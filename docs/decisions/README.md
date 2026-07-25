# Decision records

Short notes on decisions that shaped this repository and would otherwise have
to be reverse-engineered from the code.

Write one when a decision crosses module boundaries, changes what
`tooling/architecture/policy.json` permits, or has an obvious-looking
alternative that was rejected for a reason worth remembering. Do not write one
for a decision contained inside a module — that belongs in its README.

Copy [0000-template.md](0000-template.md). Number sequentially. Keep it short;
a page nobody reads is worse than no page.

A record is never edited once accepted, because it describes what was decided
at the time. When a decision changes, write a new record and mark the old one
superseded.

| # | Decision | Status |
| --- | --- | --- |
| [0001](0001-modular-monolith-of-workspace-packages.md) | A modular monolith of workspace packages | Accepted |
| [0002](0002-no-provider-specific-code.md) | No provider-specific code, ever | Accepted |
| [0003](0003-the-gateway-owns-the-tokens.md) | The gateway owns the tokens | Accepted |
| [0004](0004-sqlite-behind-repository-interfaces.md) | SQLite behind repository interfaces | Accepted |
| [0005](0005-one-upstream-session-per-downstream-session.md) | One upstream session per downstream session | Accepted |
| [0006](0006-keep-the-shared-kernel-called-core.md) | Keep the shared kernel called `core` | Accepted |
| [0007](0007-a-bespoke-architecture-check.md) | A bespoke architecture check, not a linter plugin | Accepted |
