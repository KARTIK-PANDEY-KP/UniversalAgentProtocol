// Runs every suite in order and summarises. Resilience goes last but one
// because it kills processes, and the token suite last because it is slow and
// leaves the protected connection freshly reauthorized.
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

const SUITES = [
  "protocol",
  "federation",
  "bidirectional",
  "resilience",
  "token-lifecycle",
];

const only = process.argv.slice(2);
const chosen = only.length > 0 ? only : SUITES;
const outcomes = [];

for (const suite of chosen) {
  process.stdout.write(`\n===== ${suite} =====\n`);
  const code = await new Promise((resolve) => {
    const child = spawn("node", [join(here, "tests", `${suite}.mjs`)], {
      cwd: here,
      stdio: "inherit",
    });
    child.on("exit", resolve);
  });
  outcomes.push({ suite, ok: code === 0 });
}

process.stdout.write("\n===== summary =====\n");
for (const { suite, ok } of outcomes) {
  process.stdout.write(`  ${ok ? "pass" : "FAIL"}  ${suite}\n`);
}
process.exit(outcomes.every((outcome) => outcome.ok) ? 0 : 1);
