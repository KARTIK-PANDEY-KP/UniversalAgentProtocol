# Architecture of this repository

This document is about the shape of the codebase. For how the gateway itself
works — the protocol roles, the request paths, the data model — read
[docs/architecture/overview.md](docs/architecture/overview.md).

The target is a specific one, and it is worth stating before the rules:

> Two engineers can implement two features at the same time, each staying
> mostly inside one directory, each understanding the contracts they touch
> without reading the rest of the repository, and merge with little
> coordination.

Everything below exists to make that true, and
[`tooling/architecture/check.mjs`](tooling/architecture/check.mjs) exists to
keep it true after everyone has forgotten this document.

## The shape: a modular monolith

One process, one database, one deployment — divided into modules that could be
pulled apart later but are not, because distributed services would buy
independence at the price of operational and asynchronous complexity this
system does not need.

Each module is a pnpm workspace package. That is not a formality: package
boundaries are real boundaries. A module can only import another if its
`package.json` says so, and can only reach what that module's `exports` map
publishes. The organisational rule and the resolver rule are the same rule,
which is why it holds.

```
repository/
├── ARCHITECTURE.md          this file — how the code is organised
├── CONTRIBUTING.md          how to work in it
├── CODEOWNERS               who reviews what
│
├── packages/                the modules
│   ├── core/                shared kernel: contracts, errors, pure helpers
│   ├── observability/       logging, metrics, redaction
│   ├── security/            safe fetch, vault, locks, rate limits, keys
│   ├── storage/             every table, every repository, all the SQL
│   ├── oauth/               OAuth in both directions
│   ├── mcp-client/          speaking MCP to upstreams
│   ├── mcp-server/          speaking MCP to downstream clients
│   ├── federation/          the business capability
│   └── gateway/             composition: config, routes, wiring
│
├── apps/                    deployables — thin, no rules of their own
│   ├── gateway-api/
│   ├── background-worker/
│   └── migration-cli/
│
├── conformance/
│   ├── harness/             mock servers and fixtures
│   └── tests/               the suite
│
├── docs/
│   ├── getting-started/
│   ├── architecture/
│   ├── operations/
│   ├── reference/
│   └── decisions/           ADRs
│
└── tooling/
    └── architecture/        the check that enforces this document
```

Every one of those directories has a `README.md` answering the same eight
questions, and CI fails if one is missing a section. Start there when you are
looking for where something goes.

## The rules

### 1. A module owns one capability, and says which

`federation` owns turning many upstreams into one catalogue. `oauth` owns
credentials. `storage` owns tables. Each README opens with a Responsibility
section and — more usefully — a **Does not own** section, because boundaries
are defined at least as much by refusal as by ownership.

There is no `common`, no `helpers`, no `shared`. The check rejects those
filenames outright, along with `utils.ts`, `types.ts`, `constants.ts` and
`manager.ts`: names that attract unrelated code until they become the file
every branch has to edit.

### 2. A module has exactly one public interface

`src/index.ts`, published as the sole `.` export. Other modules import
`@uap/oauth`. They do not import `@uap/oauth/dist/dpop.js`, and they do not
reach across with `../../oauth/src/dpop.js`. Both are rejected by the check and
by Node's resolver.

The practical consequence is the point: everything not exported from
`index.ts` can be renamed, split or deleted without a cross-module change.

### 3. Dependencies run one way

Modules are ranked in tiers, declared in
[`tooling/architecture/policy.json`](tooling/architecture/policy.json). A module
may depend only on tiers strictly below its own.

```
suite            conformance/tests
harness          conformance/harness
entrypoint       gateway-api, background-worker, migration-cli
composition      gateway
capability       federation
protocol         mcp-client, mcp-server, oauth
persistence      storage
platform         security
telemetry        observability
kernel           core
```

Read it downward: the deployables know about composition, composition knows
about the capability, the capability knows about protocol adapters, and the
kernel knows about nothing. Business rules never depend on a framework, a
driver or a vendor client, so infrastructure stays replaceable.

A new edge that violates the direction is not a policy edit. It is a signal
that either the dependency should be inverted, or the shared part belongs
lower down.

### 4. The kernel is sealed

`@uap/core` is the one module everything imports, so it is the one module that
must not grow a dependency. It has zero workspace dependencies and may use
`node:crypto` and nothing else; the check enforces both. An import of a driver
or a socket there would put infrastructure underneath every rule in the system.

Adding to the kernel needs two other modules to need the same thing, with the
same meaning. Two functions that merely look alike usually turn out to be two
concepts that were about to diverge.

### 5. Data has one owning module

Every table is created by `storage` and reached through a repository interface
it declares. But each table also has a *logical* owner — the module whose
capability it serves — recorded in that module's README under Data ownership.
`federation` owns connections and catalogues; `oauth` owns issuers and
registrations; `mcp-server` owns downstream sessions.

No module writes SQL of its own, and no module reads another's tables directly.

### 6. Code that changes together lives together

A module's tests, fixtures, types and documentation sit inside the module.
Unit tests go next to what they test. The conformance suite is the exception,
and deliberately so: it tests the composed system through real HTTP, which is
not something any single module can claim.

### 7. Manifests tell the truth

An import that no manifest declares fails the check, and so does a declared
dependency nobody imports. `tsconfig.json` references must match the
dependencies exactly, so the build graph and the module graph describe the same
edges. Cycles fail.

### 8. Central files stay thin

`packages/gateway/src/routes.ts` is the file this standard warns about — the
registry every feature wants to edit. It survives because it is kept to
routing: parse, authorize, delegate, serialise. A handler with logic in it is
logic in the wrong module, and that is a review comment, not a lint rule.

Each module's `src/index.ts` is the other one. A barrel is a file every new
export touches, which is the shape that causes merge conflicts. It is accepted
here because rule 2 needs a single public interface, and because the file
holds nothing but re-export lines: two branches adding one each conflict
textually at worst, never semantically. Naming what to export from a file
rather than taking all of it is fine, and is how a module keeps an internal
helper internal. A barrel that grows anything else — a rename, a constant, a
type alias, a conditional — has started being code, and that code belongs in a
file of its own.

## Where does my code go?

| You are… | It goes in |
| --- | --- |
| adding an MCP method | `federation/gateway-handler.ts` for meaning; `mcp-server` only if it is framing |
| supporting a new OAuth mechanism | `oauth`, as its own file, exported from `index.ts` |
| adding a table | `storage/schema.ts` as a new numbered migration, plus a repository in `store.ts` |
| adding a policy rule | `federation/policy-engine.ts` |
| adding a configuration knob | `gateway/config.ts`, and `docs/reference/configuration.md` |
| adding an outbound HTTP call | nowhere new — use `safeFetch` from `security` |
| adding a periodic job | `gateway/background-worker.ts` |
| tempted to write a helper two modules need | the module that needs it, twice, until a third makes the case |

If nothing fits, the capability may be missing a module. That is an
[ADR](docs/decisions/), not a pull request.

## Enforcement

```bash
pnpm check          # typecheck, architecture, tests
pnpm architecture   # just the boundaries
```

The check runs on every pull request and covers: tier direction, deep imports,
relative imports that escape a module, self-imports outside tests, undeclared
and unused dependencies, `tsconfig` reference drift, dependency cycles, the
sealed kernel, forbidden filenames, single public entry points, and the
required README sections.

Its failures name the rule and the reason, not just the line. A rule nobody can
explain gets deleted rather than worked around.

## Changing the architecture

The policy file is enforcement, not authority. Changing it changes what CI
allows, so a change to it needs a reason recorded in
[docs/decisions/](docs/decisions/) — one short file saying what was decided,
what the alternatives were, and what it costs. The existing ADRs are the record
of how the current shape came about.
