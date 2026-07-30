# 0006. Keep the shared kernel called `core`

Status: Accepted

## Context

The architecture standard this repository follows lists suspicious shared
package names — `common`, `utils`, `helpers`, `all-types`,
`shared-business-logic` — because such names describe no capability and so
attract anything.

`@uap/core` is close enough to that list to deserve an answer. It holds the
JSON-RPC and MCP wire types, the OAuth wire types, the persisted record shapes,
`GatewayError`, and a small set of pure helpers.

It also contained a `util.ts`, which was exactly the problem the standard
describes: crypto, JSON, timing, scopes and text in one file that every branch
had a reason to edit.

## Decision

Keep the package named `core`, and defend it with rules rather than a rename.

- `util.ts` is gone, split into `crypto.ts`, `json.ts`, `text.ts` and `time.ts`
  — files named for what they hold. Those names are now on the check's
  forbidden list, so the grab-bag cannot come back.
- The kernel is sealed: zero workspace dependencies, and `node:crypto` is the
  only builtin it may import. The check enforces both.
- Its README states the entry bar: two modules needing the same thing, with the
  same meaning.

## Alternatives

**Rename to `@uap/contracts`.** More precise about the largest part of the
contents, and a lie about the rest — the helpers are not contracts. Also a
rename touching every file in the repository, producing exactly the enormous
unreviewable diff this standard warns against, in exchange for a word.

**Split into `contracts` and `primitives`.** Honest, and it makes the kernel
two things to reason about instead of one, both imported by everything, with a
new argument every time about which half something belongs in.

**Do nothing.** The name would have been fine. `util.ts` would not have been.

## Consequences

A reader arriving at `core` gets a README that says what may live there, which
is the information a name alone was never going to carry.

The seal is the real protection. A dependency-free module cannot quietly become
a place where infrastructure hides, whatever it is called.

The judgement call — "same thing, same meaning" — is enforced by review, not by
CI. It is the one rule in this repository with no automated backstop, and it is
where the kernel will erode first if it erodes.
