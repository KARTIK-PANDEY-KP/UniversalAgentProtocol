# 0002. No provider-specific code, ever

Status: Accepted

## Context

The gateway's first users want GitHub, Slack, Linear and Notion. Each has
quirks. The straightforward path is a small adapter per provider, and every
integration product that has taken that path has ended up maintaining dozens of
them, each subtly stale.

There is also a correctness argument. A provider adapter encodes what a server
did last year. The MCP and OAuth specifications describe what a server must
tell you at runtime.

## Decision

There is no provider dimension anywhere: no `provider` column, no
`if (host === "github.com")`, no per-provider module, no registry of known
servers.

An upstream is a URL that speaks MCP. What it needs is learned at runtime from
the `WWW-Authenticate` challenge it returns, its protected resource metadata
(RFC 9728), and its authorization server metadata (RFC 8414). Registration is
whichever of client ID metadata documents, dynamic registration (RFC 7591) or
operator pre-registration the server supports, discovered in that order.

Where a server is non-compliant, the accommodation is generic: an operator can
pre-register a client or supply static headers. It is configuration, not code,
and it is named for the mechanism rather than the vendor.

## Alternatives

**A thin adapter layer, "just for the big four".** The problem is not the first
four. It is that the fifth is easy to justify once the pattern exists, and the
tenth is nobody's job to maintain.

**Runtime discovery with a hardcoded fallback table.** Tempting, and it hides
the failure: a server that stops matching the table fails in a way that looks
like a gateway bug rather than a compliance gap.

## Consequences

A server nobody has heard of works on the day it ships, with no release from
us. That is the whole product argument for the gateway.

A server that is not compliant does not work, and we say so rather than
papering over it. `docs/reference/compatibility.md` sorts upstreams into
support tiers on exactly this basis.

Debugging is harder in one specific way: when something fails, the answer is in
what the server advertised, not in our code. The conformance harness exists
partly for this — its mock servers can be told to misbehave in each of the ways
real ones do.
