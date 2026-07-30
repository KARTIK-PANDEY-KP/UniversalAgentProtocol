# AGENTS.md

## Cursor Cloud specific instructions

This is the **Universal MCP OAuth Gateway** — a pnpm + TypeScript modular monolith
(one process split into workspace packages under `packages/`, deployables under
`apps/`, plus `conformance/` tests and a manual `interop/` rig). There is no
external database or service: storage is embedded SQLite via `node:sqlite`, so
nothing here needs Docker, Postgres, Redis, or network access to build/test/run.

Standard commands live in `package.json`, `README.md`, and `CONTRIBUTING.md`;
prefer those. The notes below are the non-obvious bits.

### Environment
- Requires **Node >= 22.5** (`node:sqlite`) and the `--experimental-strip-types`
  flag used by `pnpm dev`. The VM's default Node satisfies this — do not switch
  it via nvm.
- The update script runs `pnpm install`. It does **not** build; run `pnpm build`
  yourself when you need the compiled output (see below).

### Build / lint / test
- `pnpm build` (`tsc -b`) emits `dist/` for every package/app.
- `pnpm check` is the full CI gate = `architecture` + `typecheck` + `test`.
- `pnpm architecture` enforces module boundaries (the "lint" of this repo).
- `pnpm test` runs the Vitest conformance + unit suites (~300 tests) fully on
  loopback — no network, no credentials. `node:sqlite` prints an expected
  "SQLite is an experimental feature" warning; ignore it.

### Running the deployables
- The three apps (`apps/gateway-api`, `apps/background-worker`,
  `apps/migration-cli`) run from `dist/`, so **`pnpm build` first** before
  `pnpm start` / `pnpm worker` / `pnpm migrate`.
- `pnpm dev` runs the gateway straight from `src/` (strip-types), so it needs no
  build — use it for iterating on the gateway.
- The gateway needs env vars at startup (see `docs/getting-started/running-locally.md`).
  Two gotchas: `GATEWAY_DATABASE_FILE` defaults to `:memory:` (nothing persists
  across restarts unless you set a file path), and `GATEWAY_ENCRYPTION_KEYS`, if
  unset, is regenerated each boot (credentials stored in one run become
  undecryptable in the next). Config is read once at startup and never re-read.

### Hello-world (end-to-end smoke test, fully local)
1. `pnpm build`, then start the gateway with the env block from the README.
2. Start a local unauthenticated upstream MCP server:
   `cd interop && npm install && PORT=8811 node servers/mcp-server.mjs`.
3. `POST /api/v1/connections` with `{"mcp_url":"http://127.0.0.1:8811/mcp","alias":"ref"}`
   (Bearer `dev-key`) → status `CONNECTED`, 4 tools.
4. Speak MCP to `/mcp` (initialize → `notifications/initialized` → `tools/list`
   → `tools/call ref.echo`). Federated tools are namespaced `alias.tool`.

### interop rig
`interop/` is a **manual** harness (not in CI). It has its own `package-lock.json`
(`cd interop && npm install`), binds ~6 local ports, needs outbound network for
the public MCP servers it attaches, uses browser automation for the OAuth-protected
upstream, and `token-lifecycle` waits out real 30s token expiry. Use it only for
full real-SDK/real-OAuth interop checks; the loopback hello-world above is enough
for routine verification.
