# Running the gateway locally

Node 22.5 or newer — the storage layer uses `node:sqlite` — and pnpm.

```bash
pnpm install
pnpm build
```

## Start it

```bash
export GATEWAY_BASE_URL=http://127.0.0.1:8787
export GATEWAY_API_KEYS=dev-key:tenant_local:user_local:laptop
export GATEWAY_ENCRYPTION_KEYS="k1:$(head -c 32 /dev/urandom | base64)"
export GATEWAY_DATABASE_FILE=./data/gateway.sqlite
pnpm start
```

Four settings, and each one matters for a reason worth knowing:

`GATEWAY_BASE_URL` is the origin the outside world reaches. It determines the
OAuth redirect URI the gateway registers and the URL of its client ID metadata
document, which authorization servers fetch. Change it later and existing
registrations no longer match.

`GATEWAY_API_KEYS` is the development shortcut for downstream authentication:
`key:tenantId:userId[:label[:role]]`. Fine on a laptop. For anything shared,
use `GATEWAY_AUTHORIZATION_SERVERS` instead, so each application has an
identity you can attribute and revoke.

`GATEWAY_ENCRYPTION_KEYS` protects every stored credential. If you leave it
unset a key is generated at boot, which means every credential stored in one
run is undecryptable in the next.

`GATEWAY_DATABASE_FILE` defaults to `:memory:`. Without it nothing survives a
restart.

Every other setting is in
[reference/configuration.md](../reference/configuration.md).

## Connect an upstream

```bash
curl -sX POST http://127.0.0.1:8787/api/v1/connections \
  -H 'authorization: Bearer dev-key' -H 'content-type: application/json' \
  -d '{"mcp_url":"https://mcp.example.com/mcp","alias":"example"}'
```

The gateway probes the URL. If the server needs authorization, the response
carries `connect_url` and the connection sits in `AUTHORIZATION_REQUIRED` until
you open that link and approve it. If it needs nothing, the connection is
active immediately.

Either way you never see a token. The browser round trip ends at the gateway's
callback, and the credential goes straight into the vault.

Check where it got to:

```bash
curl -s http://127.0.0.1:8787/api/v1/connections \
  -H 'authorization: Bearer dev-key'
```

An upstream that fails here is usually not a gateway bug — see the support
tiers in [reference/compatibility.md](../reference/compatibility.md), which
sort servers by what they advertise.

## Point a client at it

Next: [connecting-a-client.md](connecting-a-client.md).

## Run the tests

```bash
pnpm check                                   # typecheck, architecture, tests
npx vitest run conformance/tests/security.test.ts
```

The conformance suite starts its own mock authorization servers and MCP servers
on loopback ports. It needs no network access and no credentials.
