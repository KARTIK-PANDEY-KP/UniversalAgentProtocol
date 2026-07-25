# 0004. SQLite behind repository interfaces

Status: Accepted

## Context

The gateway needs durable storage for credentials, connections, catalogues and
sessions. It also needs to be trivial to run — a developer trying it on a
laptop should not first provision a database — while remaining credible for a
team deployment.

Those pull in opposite directions, and picking the heavier option early usually
wins the argument and loses the users.

## Decision

`node:sqlite`, built into Node 22.5, with no native dependency to install and
no service to run. Every table, every migration and every line of SQL lives in
`@umg/storage`.

Other modules never see SQL. They depend on repository *interfaces* declared in
`store.ts`; `sqlite-store.ts` implements them. Moving to Postgres means writing
a second implementation of those interfaces, and nothing above the persistence
tier changes.

## Alternatives

**Postgres from the start.** Better concurrency and the obvious destination for
a large deployment. It also means every contributor and every CI job needs a
database before the first test runs, for a system whose typical deployment is a
single small process.

**An ORM.** Would have given both backends at once. It would also put a query
builder's opinions between the schema and the code, in the module where being
able to read exactly what runs matters most.

**Repositories are over-engineering; just call SQLite directly.** True right up
until the second backend, at which point it is a rewrite of every module rather
than one. The interfaces also make it possible to test business rules without a
database.

## Consequences

`pnpm install && pnpm test` works with nothing else installed, and the
conformance suite gives every fixture its own temporary database.

Write concurrency is bounded by SQLite. Acceptable for the traffic this system
sees, and the reason the interesting concurrency — token refresh — is handled
with explicit leases rather than left to the database.

Requires Node 22.5 or newer, which is stated in the README and asserted in CI.

The repository interfaces are the load-bearing part of this decision. A module
that reaches around them to issue SQL of its own silently removes the option
this ADR was written to preserve.
