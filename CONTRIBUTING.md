# Contributing

## Getting set up

Node 22.5 or newer — the storage layer uses `node:sqlite` — and pnpm.

```bash
pnpm install
pnpm build
pnpm check
```

`pnpm check` is the whole gate: typecheck, architecture, tests. If it passes
locally it passes in CI, and if it fails in CI it will fail locally too.

## Before you write anything

Read the `README.md` of the module you are about to change. Each one answers
the same eight questions, and two of them decide most design arguments before
they start: **Responsibility** and **Does not own**.

If your change does not fit any module's Responsibility, that is worth pausing
on. Either it belongs somewhere you have not looked, or the repository is
missing a capability — which is an [ADR](docs/decisions/), not a pull request.

[ARCHITECTURE.md](ARCHITECTURE.md) has a "Where does my code go?" table for the
common cases.

## While you write

**Stay in one module where you can.** A change touching six modules is usually
a change that has not found its home yet. It is also a change nobody can review
properly.

**Reach other modules through their public interface.** `@umg/oauth`, not
`@umg/oauth/dist/dpop.js`, and never a relative path across a boundary. If what
you need is not exported, exporting it is a deliberate decision by that module
— which makes it a conversation with its owner, and that is the point.

**Do not create a shared helper for two callers.** Two functions that look
alike are often two concepts about to diverge. The bar for the kernel is two
modules needing the same thing with the same meaning, and it is meant to be
uncomfortable.

**Name files for what they hold.** `utils.ts`, `helpers.ts`, `common.ts`,
`types.ts`, `constants.ts` and friends are rejected by the check. They are
rejected because they are the files every branch ends up editing.

**Take the clock and the randomness as parameters.** Everything here takes a
`Clock`. That is what lets a test move time instead of sleeping through it.

**Make every outbound request through `safeFetch`.** A bare `fetch` is a
server-side request forgery waiting for a redirect.

## Tests

Put a test next to what it tests. Unit tests live in the module, in `test/`,
and reach the module through its public interface — the same interface every
other caller has.

The conformance suite in `conformance/tests` is for behaviour that only exists
once the system is assembled: a real gateway, real HTTP, mock upstreams that
can be told to misbehave. Anything protocol-shaped belongs there.

A fixed bug gets a test first, named for the behaviour rather than the defect.
`refuses a response with no issuer from a server that promises one` will still
mean something in a year; `regression test for #412` will not.

## Pull requests

**Keep them small and single-purpose.** Prefer a sequence:

```
1. add the public interface
2. add the domain behaviour behind it
3. add the infrastructure implementation
4. expose it on the API
5. document it
```

over one pull request that does all five. Small changes get reviewed properly,
break less, and spend less time diverging from `main`.

**Say what changed and why.** The diff shows what. The description should
cover why this approach, what you rejected, and what a reviewer should look at
hardest.

**Update the module README** when you change what a module owns, exposes, or
guarantees. It is part of the module, not documentation about it.

**Write an ADR** when the decision crosses modules, changes the tier policy, or
is one a future reader would otherwise have to reverse-engineer. Copy
`docs/decisions/0000-template.md`; short is fine, and short is better.

## Commits

One logical change per commit, with a message in the imperative mood saying
what it does and — where it is not obvious — why.

```
Bound the key-set refetch and refuse JWTs that are not access tokens
```

not

```
fix security issues
```

## Review

`CODEOWNERS` routes each directory to the people responsible for it. Ownership
does not mean only they may change it; it means someone is accountable for the
module staying coherent and no architectural change happens invisibly.

If you are reviewing: check the change is in the right module before checking
whether it is correct. Correct code in the wrong module is a cost that
compounds.
