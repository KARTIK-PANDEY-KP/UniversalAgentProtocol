# 0001. A modular monolith of workspace packages

Status: Accepted

## Context

The gateway has several genuinely separable concerns: OAuth, two directions of
MCP, persistence, federation, and the defensive primitives underneath all of
them. They are separable enough that they could be services, and cohesive
enough that they could be one folder of files. Both extremes have obvious
costs.

We also wanted a property that is easy to say and hard to get: two people
working on two features at once, each staying mostly inside one directory,
merging without coordinating.

## Decision

One deployable process, one database, divided into modules — and each module is
a pnpm workspace package with its own manifest, its own `tsconfig`, and a single
`src/index.ts` published as its only export.

Packages rather than folders, because the boundary then has teeth. A module can
import another only if its manifest declares it, and can reach only what that
module's `exports` map publishes. The organisational rule and the module
resolver's rule become the same rule, which is why it survives contact with a
deadline.

Modules are ranked in tiers and may depend only downward. The ranking lives in
`tooling/architecture/policy.json`.

## Alternatives

**Microservices.** Would give real independence, at the price of network
failure modes, distributed transactions, and an operational surface for a
system whose entire job is to be a single trustworthy custodian of credentials.
Independence we do not need yet, complexity we would pay for immediately.

**One package with folders.** Simpler to set up. But a folder boundary is a
convention, and conventions lose to expedience. Nothing stops
`import { thing } from "../../oauth/internal/thing"` at eleven at night.

**Packages without tiers.** We tried relying on declared dependencies alone.
It stops nothing: every edge looks fine on its own, and the graph becomes a
mesh one reasonable pull request at a time.

## Consequences

Adding a module means a manifest, a `tsconfig`, a README and a tier — enough
friction that nobody adds one absent-mindedly, which is the intent.

Moving code between modules is a visible, reviewable change rather than a
drag-and-drop.

Sharing anything requires deciding where it lives, and the tiers make some
choices impossible. That is the constraint doing its job, but it will
occasionally be the wrong answer, and the escape hatch is an ADR changing the
policy rather than a quiet exception.

Extracting a module into a service later is mechanical rather than
archaeological, if it ever becomes worth doing.
