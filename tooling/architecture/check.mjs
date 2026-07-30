#!/usr/bin/env node
/**
 * Fails the build when the repository stops matching the architecture written
 * down in ARCHITECTURE.md and encoded in policy.json.
 *
 * Written in plain JavaScript on purpose: it gates the TypeScript build, so it
 * cannot depend on that build having succeeded, and it pulls in no packages, so
 * it cannot break because of an install.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const policy = readJson(join(root, "tooling", "architecture", "policy.json"));
/** Tooling every module may use without restating it in its own manifest. */
const rootDevDependencies = readJson(join(root, "package.json")).devDependencies ?? {};

/** Directories holding workspace packages, mirroring pnpm-workspace.yaml. */
const WORKSPACE_ROOTS = ["packages", "apps", "conformance"];
const IGNORED_DIRECTORIES = new Set(["node_modules", "dist", ".git"]);
const BUILTIN_PREFIXES = new Set(builtinModules);

const violations = [];

function fail(where, message) {
  violations.push({ where, message });
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

/** tsconfig.json permits comments; JSON.parse does not. */
function stripJsonComments(text) {
  return text.replace(/^\s*\/\/.*$/gmu, "");
}

function exists(path) {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

function sourceFiles(directory) {
  const found = [];
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (IGNORED_DIRECTORIES.has(entry.name)) continue;
      const path = join(current, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith(".ts")) found.push(path);
    }
  };
  if (exists(directory)) walk(directory);
  return found;
}

/**
 * Import specifiers, found by pattern rather than by parsing. A regex is
 * enough here because the thing being checked is the specifier string, and a
 * false positive inside a comment is still an import worth questioning.
 */
function importSpecifiers(source) {
  const specifiers = [];
  const patterns = [
    /\bfrom\s+["']([^"']+)["']/gu,
    /\bimport\s+["']([^"']+)["']/gu,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/gu,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/gu,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) specifiers.push(match[1]);
  }
  return specifiers;
}

// ---------------------------------------------------------------------------
// Discover the modules
// ---------------------------------------------------------------------------

/** @type {Map<string, {name: string, dir: string, manifest: object}>} */
const modules = new Map();

for (const workspaceRoot of WORKSPACE_ROOTS) {
  const base = join(root, workspaceRoot);
  if (!exists(base)) continue;
  for (const entry of readdirSync(base, { withFileTypes: true })) {
    if (!entry.isDirectory() || IGNORED_DIRECTORIES.has(entry.name)) continue;
    const dir = join(base, entry.name);
    const manifestPath = join(dir, "package.json");
    if (!exists(manifestPath)) continue;
    const manifest = readJson(manifestPath);
    modules.set(manifest.name, { name: manifest.name, dir, manifest });
  }
}

if (modules.size === 0) {
  console.error("No workspace modules found. Is this the repository root?");
  process.exit(2);
}

// ---------------------------------------------------------------------------
// Tiers
// ---------------------------------------------------------------------------

/** @type {Map<string, {rank: number, tier: string}>} */
const tierOf = new Map();
policy.tiers.forEach((tier, rank) => {
  for (const name of tier.modules) tierOf.set(name, { rank, tier: tier.name });
});

for (const name of modules.keys()) {
  if (!tierOf.has(name)) {
    fail(
      "tooling/architecture/policy.json",
      `${name} is a workspace module but no tier claims it. Place it in a tier ` +
        "so its allowed dependencies are decided deliberately rather than by whoever imports it first.",
    );
  }
}
for (const name of tierOf.keys()) {
  if (!modules.has(name)) {
    fail(
      "tooling/architecture/policy.json",
      `The policy places ${name} in a tier, but no such workspace module exists.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Per-module checks
// ---------------------------------------------------------------------------

for (const module of modules.values()) {
  const here = relative(root, module.dir);
  const declared = new Set(
    Object.keys({
      ...(module.manifest.dependencies ?? {}),
      ...(module.manifest.devDependencies ?? {}),
    }).filter((name) => modules.has(name)),
  );
  const imported = new Set();

  // One public entry point, and only that one.
  const exportMap = module.manifest.exports;
  if (exportMap !== undefined) {
    const paths = Object.keys(exportMap);
    if (paths.length !== 1 || paths[0] !== ".") {
      fail(
        `${here}/package.json`,
        `A module exposes exactly one public entry point. This one exports ${paths.join(", ")}, ` +
          "which lets another module reach past its interface and pin its internals.",
      );
    }
    if (!exists(join(module.dir, "src", "index.ts"))) {
      fail(here, "A module with an exports map needs src/index.ts as its public interface.");
    }
  }

  // The module's own README is part of the module.
  const readmePath = join(module.dir, "README.md");
  if (!exists(readmePath)) {
    fail(
      `${here}/README.md`,
      "Every module documents itself. Missing README.md: a reader has nowhere to " +
        "learn what this module owns, what it refuses to own, or who maintains it.",
    );
  } else {
    const readme = readFileSync(readmePath, "utf8");
    const missing = policy.requiredReadmeSections.filter(
      (section) => !readme.includes(`\n${section}\n`) && !readme.startsWith(`${section}\n`),
    );
    if (missing.length > 0) {
      fail(`${here}/README.md`, `Missing required sections: ${missing.join(", ")}`);
    }
  }

  for (const file of sourceFiles(module.dir)) {
    const shown = relative(root, file);
    const basename = file.split(sep).pop();
    const isTest = /\.test\.ts$/u.test(basename) || file.includes(`${sep}test${sep}`);

    if (policy.forbiddenFilenames.names.includes(basename)) {
      fail(
        shown,
        `"${basename}" is a name that attracts unrelated code and becomes the file ` +
          "every branch has to edit. Name the file for what it holds.",
      );
    }

    const source = readFileSync(file, "utf8");
    for (const specifier of importSpecifiers(source)) {
      // A builtin, possibly infrastructure the kernel must stay clear of.
      if (specifier.startsWith("node:") || BUILTIN_PREFIXES.has(specifier)) {
        if (
          module.name === policy.sealedKernel.module &&
          !policy.sealedKernel.allowedBuiltins.includes(specifier)
        ) {
          fail(
            shown,
            `The shared kernel imports ${specifier}. Everything depends on this module, ` +
              "so a dependency here is a dependency everywhere. Put it in the module that needs it.",
          );
        }
        continue;
      }

      // A workspace module.
      if (specifier.startsWith("@uap/")) {
        const [scope, name, ...rest] = specifier.split("/");
        const target = `${scope}/${name}`;
        if (rest.length > 0) {
          fail(
            shown,
            `Deep import "${specifier}". A module is reached only through its public ` +
              `interface, so import from "${target}" and export it there if it is missing.`,
          );
        }
        if (target === module.name) {
          // A module's own tests reach it through its public interface, which is
          // the interface everyone else has; that is the surface worth testing.
          // Its own source must not, or the module would depend on its build output.
          if (!isTest) {
            fail(
              shown,
              `A module imports itself by package name ("${specifier}"). Use a relative ` +
                "path, so the file does not depend on its own build output.",
            );
          }
          continue;
        }
        imported.add(target);
        continue;
      }

      // A relative path, which must stay inside the module.
      if (specifier.startsWith(".")) {
        const resolved = resolve(dirname(file), specifier);
        if (!resolved.startsWith(module.dir + sep)) {
          fail(
            shown,
            `Relative import "${specifier}" reaches outside the module. Crossing a ` +
              "boundary this way sidesteps the dependency the manifest declares.",
          );
        }
        continue;
      }

      // Anything else is a third-party package and must be declared.
      const external = specifier.startsWith("@")
        ? specifier.split("/").slice(0, 2).join("/")
        : specifier.split("/")[0];
      const allDeclared = {
        ...(module.manifest.dependencies ?? {}),
        ...(module.manifest.devDependencies ?? {}),
      };
      if (!(external in allDeclared) && !(external in rootDevDependencies)) {
        fail(shown, `Imports "${external}", which no manifest declares.`);
      }
    }
  }

  // The manifest and the code have to agree, in both directions.
  for (const name of imported) {
    if (!declared.has(name)) {
      fail(
        `${here}/package.json`,
        `Imports ${name} but does not declare it. An undeclared edge is one nobody ` +
          "reviewed and one the build graph does not order.",
      );
    }
  }
  for (const name of declared) {
    if (!imported.has(name)) {
      fail(
        `${here}/package.json`,
        `Declares ${name} but never imports it. A dependency nobody uses still ` +
          "constrains what this module may become.",
      );
    }
  }

  // The build graph and the module graph describe the same edges, so they have
  // to agree. A stale project reference builds something nobody depends on; a
  // missing one builds things in an order that only happens to work.
  const tsconfigPath = join(module.dir, "tsconfig.json");
  if (exists(tsconfigPath)) {
    const tsconfig = JSON.parse(stripJsonComments(readFileSync(tsconfigPath, "utf8")));
    const referenced = new Set(
      (tsconfig.references ?? []).map((reference) => {
        const target = resolve(module.dir, reference.path);
        return [...modules.values()].find((candidate) => candidate.dir === target)?.name ?? reference.path;
      }),
    );
    for (const name of declared) {
      if (!referenced.has(name)) {
        fail(`${here}/tsconfig.json`, `Depends on ${name} but does not reference it.`);
      }
    }
    for (const name of referenced) {
      if (!declared.has(name)) {
        fail(`${here}/tsconfig.json`, `References ${name}, which is not a declared dependency.`);
      }
    }
  }

  // Tier direction.
  const mine = tierOf.get(module.name);
  if (mine) {
    for (const name of imported) {
      const theirs = tierOf.get(name);
      if (!theirs) continue;
      if (theirs.rank >= mine.rank) {
        fail(
          `${here}/package.json`,
          `${module.name} (${mine.tier}) depends on ${name} (${theirs.tier}). ` +
            "Dependencies run one way, from the outside in. Invert the dependency, " +
            "or move the shared part down a tier.",
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Cycles
// ---------------------------------------------------------------------------

const graph = new Map(
  [...modules.values()].map((module) => [
    module.name,
    Object.keys(module.manifest.dependencies ?? {}).filter((name) => modules.has(name)),
  ]),
);

const state = new Map();
const stack = [];
function visit(name) {
  if (state.get(name) === "done") return;
  if (state.get(name) === "open") {
    const cycle = [...stack.slice(stack.indexOf(name)), name].join(" -> ");
    fail("workspace", `Dependency cycle: ${cycle}`);
    return;
  }
  state.set(name, "open");
  stack.push(name);
  for (const next of graph.get(name) ?? []) visit(next);
  stack.pop();
  state.set(name, "done");
}
for (const name of graph.keys()) visit(name);

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

if (violations.length === 0) {
  console.log(`Architecture check passed: ${modules.size} modules, no violations.`);
  process.exit(0);
}

console.error(`Architecture check failed with ${violations.length} violation(s).\n`);
for (const { where, message } of violations) {
  console.error(`  ${where}\n    ${message}\n`);
}
console.error("These rules are explained in ARCHITECTURE.md.");
process.exit(1);
