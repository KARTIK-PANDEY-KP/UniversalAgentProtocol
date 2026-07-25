# security

## Responsibility

The defensive primitives the rest of the gateway is built on: outbound request
safety, credential encryption, distributed locking, request throttling, signing
keys, and the URL and origin comparisons that authorization decisions rest on.

Everything here is mechanism. Deciding *when* to encrypt, lock or throttle
belongs to the module with the business reason.

## Does not own

- OAuth. `@uap/oauth` owns the protocol; this module owns the vault it stores
  tokens in and the fetch it makes them over.
- Authentication or authorization decisions. `@uap/oauth` verifies tokens and
  `@uap/federation` applies policy.
- Rate-limit budgets. This module implements the token bucket; the caller
  chooses the numbers.

## Public interface

`@uap/security`, from `src/index.ts`.

- `safe-fetch.ts` — the only outbound HTTP client. Resolves DNS, rejects
  addresses outside the public internet, re-checks after every redirect, and
  strips credential-bearing headers when a redirect crosses origins.
- `ip-rules.ts` — the reserved IPv4 and IPv6 ranges `safe-fetch` refuses.
- `url.ts` — canonical issuer form, same-origin and same-issuer comparison, and
  redirect-target validation.
- `origin.ts` — `Origin` header validation for browser-reachable endpoints.
- `envelope.ts` / `vault.ts` — envelope encryption and the credential vault
  that upstream tokens live in.
- `locks.ts` — leased distributed locks, so one refresh happens per grant even
  with several gateway processes.
- `signing-keys.ts` — the key pairs used for client assertions and DPoP.
- `rate-limit.ts` — the token bucket behind per-tenant throttling.

## Depends on

- `@uap/core`
- `@uap/observability`

## Data ownership

No tables of its own. It reads and writes `dpop_keys` and `distributed_locks`
through repository interfaces that `@uap/storage` owns and implements; the
schema for those tables lives there.

## Entry points

`src/index.ts`.

## Invariants

- Every outbound request in the system goes through `safeFetch`. A bare `fetch`
  anywhere else is a server-side request forgery waiting for a redirect.
- DNS is resolved before connecting and the resolved address is what gets
  checked, so a name that resolves to a private address is refused rather than
  trusted twice.
- Redirects are followed manually. Each hop is re-validated, and `Authorization`,
  `DPoP` and `Cookie` are dropped when the origin changes.
- A plaintext credential never reaches the database. The vault encrypts on the
  way in and is the only path out.
- A lock is a lease with an expiry. A process that dies holding one does not
  hold it forever.
- Issuers are compared in canonical form, so a trailing slash cannot make one
  issuer look like two.

## Testing

```bash
pnpm --filter @uap/security test
```

## Owners

`@platform`
