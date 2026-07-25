# 0003. The gateway owns the tokens

Status: Accepted

## Context

The problem being solved is that every MCP client runs its own OAuth flow
against every upstream, so a user authorizes GitHub once for Cursor, again for
Claude Code, and again for Codex. Something has to hold the credential in one
place.

There are two ways to be that place. Hold the tokens and never hand them out,
or hold them and pass them through to whichever client asks.

## Decision

The gateway is the OAuth client. It obtains, stores, refreshes and rotates
upstream credentials, and no downstream client ever receives one — not in a
response, not in an error, not in a log, not in a debug endpoint.

A downstream client authenticates to the *gateway* and receives results. The
upstream credential stops at the boundary.

The gateway never impersonates a client either. It registers as itself, with
its own client identity and its own redirect URI, so an authorization server
can see what it is granting to.

## Alternatives

**Pass the upstream token through.** Would make the gateway a thin proxy and
avoid a lot of session machinery. It also reproduces the problem: three clients
each holding a copy of a GitHub token, three places for it to leak, and no way
to revoke one without revoking all.

**Impersonate the client's OAuth identity.** Some providers only allow their
own applications' client IDs, and borrowing one would make more upstreams work
today. It also means lying to an authorization server about who is asking,
which breaks the consent screen's only job. Ruled out as a matter of principle,
not of difficulty.

## Consequences

Every credential lives in one place, encrypted with a tenant- and
purpose-bound envelope, revocable in one action.

The gateway becomes a high-value target, which is why
`docs/architecture/threat-model.md` exists and why the security module is held
to invariants rather than conventions.

Refresh has to be exactly-once under concurrency, because a rotating
authorization server invalidates the loser of a race. That drove the
connection-scoped lock and the compare-and-swap on `token_version`.

Some capabilities that would need a real client-side credential are simply
unavailable through the gateway. That is the correct outcome.
