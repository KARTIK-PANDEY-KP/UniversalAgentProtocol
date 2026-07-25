# 0007. A bespoke architecture check, not a linter plugin

Status: Accepted

## Context

Written architecture guidance is ignored eventually — not out of bad faith, but
because the person under deadline pressure is not the person who read the
document. The rules in `ARCHITECTURE.md` are only real if CI fails on them.

The usual tools for TypeScript are `eslint-plugin-boundaries` and
`dependency-cruiser`. Both are capable and both are well maintained.

## Decision

`tooling/architecture/check.mjs`: about three hundred lines of dependency-free
JavaScript, with the policy in `tooling/architecture/policy.json`.

It checks tier direction, deep imports, relative imports that escape a module,
self-imports outside tests, undeclared and unused dependencies, drift between
`tsconfig` references and manifests, dependency cycles, the sealed kernel,
forbidden filenames, single public entry points, and the required README
sections.

Plain JavaScript, not TypeScript, because it gates the TypeScript build and
cannot depend on that build having succeeded. No dependencies, because a check
that fails on a bad install teaches people to skip it.

## Alternatives

**`dependency-cruiser`.** Does the graph rules well and is the obvious choice
for them. It does not check manifests against imports, `tsconfig` references
against manifests, or README sections — and those turned out to be where the
real drift was: five modules declaring dependencies they never imported, with
stale project references to match.

**`eslint-plugin-boundaries`.** Fits naturally if there is already an ESLint
setup. There is not, and adding one to enforce architecture puts the
architecture behind a plugin's configuration model.

**Both, plus a small script for the rest.** Three places to look when the build
fails, and three vocabularies for one set of rules.

## Consequences

The rules and their reasons live in one readable file. Its failure messages say
why a rule exists, not just which line broke it — which matters, because a rule
nobody can explain gets worked around.

We maintain it. It uses regular expressions to find import specifiers rather
than parsing TypeScript, which is imprecise in a specific and acceptable
direction: it can flag a specifier inside a comment, and a specifier inside a
comment is still worth a look.

Adding a rule is a small change to one file. That is the point — the checks
that found real problems here are the unusual ones, and unusual checks are
exactly what a general-purpose tool does not have.
