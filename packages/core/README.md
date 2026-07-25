# core — the shared kernel

## Responsibility

The vocabulary every other module speaks: the JSON-RPC and MCP wire types, the
OAuth wire types, the persisted record shapes, the error type, and a small set
of pure helpers that have no home anywhere else.

This is the one module every other module imports, which is why it is the one
module held to the strictest rule: it depends on nothing. The architecture
check seals it, permitting `node:crypto` and no other builtin. An import of a
database driver, a socket or the filesystem here would place infrastructure
underneath every business rule in the repository.

## Does not own

- Any behaviour. Nothing here talks to a network, a disk or a clock it did not
  receive as an argument.
- Validation of MCP or OAuth messages. The types describe the wire; the modules
  that read the wire decide what is acceptable.
- Anything a single other module could own instead. Two modules needing a thing
  is the bar for it to live here, and the bar is enforced by review, not by the
  check.

## Public interface

`@umg/core`, from `src/index.ts`.

- `json-rpc.ts` — `JsonValue`, `JsonObject`, request/response/notification
  shapes, and the JSON-RPC error codes.
- `mcp.ts` — MCP method names, capability records, tool/resource/prompt shapes,
  content blocks, log levels, protocol version constants.
- `oauth.ts` — authorization server metadata, protected resource metadata,
  token responses, client registration shapes, grant and auth-method constants.
- `domain.ts` — the persisted records: tenants, users, connections, tools,
  sessions, audit events, and the enums their columns take.
- `errors.ts` — `GatewayError`, the single error type that carries an HTTP
  status, a JSON-RPC code and a structured payload across every boundary.
- `crypto.ts` — identifiers, random tokens, SHA-256 in three encodings, and a
  constant-time string comparison.
- `json.ts` — record narrowing, tolerant parsing, and the deterministic
  stringify that tool-schema hashing depends on.
- `text.ts` — scope parsing and formatting, deduplication, and the clamp
  applied to untrusted text before it reaches a log.
- `time.ts` — the injectable `Clock`, `sleep`, and jittered backoff.

## Depends on

Nothing.

## Data ownership

No tables. `domain.ts` declares the record shapes; `@umg/storage` owns the
schema that stores them and is the only module that may issue SQL.

## Entry points

`src/index.ts`.

## Invariants

- No workspace dependencies, now or later.
- No I/O. A function here is pure, or it takes its clock and its randomness as
  a parameter.
- `stableStringify` sorts keys and drops `undefined`. Tool-schema change
  detection is built on it, so altering its output re-notifies every connected
  client that every tool changed.
- `GatewayError` is the only error type crossing a module boundary. Modules
  throwing bare `Error` leak stack shapes into responses.

## Testing

```bash
pnpm --filter @umg/core test
```

Most of this module is types, and is tested by the modules that use it.

## Owners

`@platform`
