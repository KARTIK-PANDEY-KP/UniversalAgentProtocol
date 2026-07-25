# federation

## Responsibility

The gateway's business capability. One upstream MCP server, connected once,
becomes part of a single catalogue that every downstream client sees; a tool
call on that catalogue is routed to the right upstream with the right
credential attached.

Concretely: the lifecycle of a connection, the naming that keeps two upstreams'
identically named tools apart, discovery and resynchronisation of catalogues,
the policy applied to a call, the audit trail it leaves, and the pooling of
upstream sessions.

This module holds the rules. `@uap/mcp-client` and `@uap/mcp-server` hold the
protocol; `@uap/oauth` holds the credentials.

## Does not own

- The HTTP surface or configuration, which is `@uap/gateway`.
- Any transport detail. It asks for an upstream connection and gets one.
- Token acquisition or refresh. It asks `@uap/oauth` for a usable credential
  and reacts to being told there is not one.
- SQL. Everything persists through repositories declared in `@uap/storage`.

## Public interface

`@uap/federation`, from `src/index.ts`.

- `connection-service.ts` — connect, authorize, rename, refresh, disconnect,
  and enable or disable either an individual tool or a whole connection. Every
  entry point takes a `ControlPlaneActor`, and visibility is decided from it.
- `gateway-handler.ts` — the northbound MCP handler: the list methods, the
  call methods, completion, and the notifications that follow a catalogue
  change.
- `naming.ts` — namespaced aliases, collision handling, and the reverse mapping
  from an alias back to an upstream.
- `tool-classifier.ts` — the read/write/destructive risk classification a
  policy decision is made against.
- `json-schema.ts` — validation of arguments against an upstream's declared
  schema, before the call is made.
- `policy-engine.ts` — allow, deny, or require confirmation.
- `audit.ts` — the audit record every call leaves.
- `upstream-sessions.ts` — pooling and reuse of upstream MCP sessions.
- `pagination.ts` — the cursors the northbound list methods hand out.

## Depends on

- `@uap/core`
- `@uap/observability`
- `@uap/security`
- `@uap/storage`
- `@uap/oauth`
- `@uap/mcp-client`
- `@uap/mcp-server`

## Data ownership

Logical owner of `mcp_servers`, `upstream_connections`, `discovered_tools`,
`discovered_resources`, `discovered_prompts`, `upstream_mcp_sessions` and
`audit_events`, all reached through repositories declared in `@uap/storage`.

## Entry points

`src/index.ts`, then `ConnectionService` for the control plane and
`GatewayMcpHandler` for the data plane.

## Invariants

- A connection is owned by a user or by the workspace. A user-owned connection
  is invisible to colleagues in the same tenant, including by direct id.
- Aliases are stable. A downstream client that learned a tool name keeps it
  across a resync, unless the upstream itself renamed the tool.
- A disabled tool is absent from every list method and refused by every call
  path, not merely hidden. A disabled connection is absent in the same way,
  and so is everything it discovered.
- An upstream that lists the same tool, resource or prompt twice loses the
  repeat, not its whole catalogue.
- Arguments are validated against the upstream's schema before the call goes
  out, so a malformed call fails here rather than upstream.
- Every call is audited, including the denied ones. An audit record never
  contains a credential or a raw argument value that policy considers
  sensitive.
- A catalogue change notifies clients for tools, resources and prompts alike.
- Pagination cursors are opaque and tenant-bound.

## Testing

Naming and schema validation are pure and are tested directly:

```bash
pnpm vitest run packages/federation
```

Everything else is exercised end to end, because a routing rule is only true
against a real upstream:

```bash
pnpm --filter @uap/conformance-tests test
```

## Owners

`@federation`
