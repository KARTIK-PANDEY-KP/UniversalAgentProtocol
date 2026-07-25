# 0005. One upstream session per downstream session

Status: Accepted

## Context

Several applications connect to the gateway at once, and they share upstream
OAuth grants — that is the point of the product. The question is whether they
should also share upstream MCP *sessions*.

MCP sessions can hold state: a subscription, a negotiated log level, a cursor,
whatever a stateful upstream chooses to keep. Sharing one session between
Cursor and Codex means sharing that state.

## Decision

Sharing happens at the grant, not at the transport.

An upstream session belongs to one `(connection, downstream session)` pair.
Three applications using the same GitHub connection resolve to one OAuth grant
and one code exchange, but to three upstream MCP sessions.

`UpstreamSessionManager` owns the mapping and reinitializes a session the
upstream has dropped.

## Alternatives

**One upstream session per connection, shared by everyone.** Fewer sessions,
less memory, fewer initializes. Also means a subscription Cursor placed
delivers notifications into Codex's stream, and a log level one client set
silently applies to another. Cross-client interference that would be very hard
to diagnose from either end.

**A session per downstream request.** Perfectly isolated and unusably chatty:
an `initialize` round trip before every tool call, and no stateful upstream
would work at all.

## Consequences

State cannot leak between connected applications, and the conformance suite
asserts it directly.

More upstream sessions to hold and to reap, which is why the background worker
has an idle window and why `upstream_mcp_sessions` is a table rather than a
map.

An upstream that rate-limits by session sees more sessions than it would
otherwise. Not yet a problem, and the alternative trades a correctness property
for a quota one.
