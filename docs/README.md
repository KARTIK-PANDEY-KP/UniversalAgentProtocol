# Documentation

## Getting started

- [Running locally](getting-started/running-locally.md) — install, configure,
  start, connect a first upstream
- [Connecting a client](getting-started/connecting-a-client.md) — pointing
  Cursor, Claude Code, Codex and others at the gateway

## Architecture

How the system works. For how the *codebase* is organised, see
[ARCHITECTURE.md](../ARCHITECTURE.md) at the repository root.

- [Overview](architecture/overview.md) — the two protocol roles, request paths,
  data model, session model, concurrency
- [OAuth flow](architecture/oauth-flow.md) — discovery, registration, the
  authorization round trip, refresh and rotation
- [Threat model](architecture/threat-model.md) — assets, adversaries, controls,
  residual risk

## Operations

- [Running](operations/running.md) — processes, production checklist,
  endpoints, metrics, alerting, runbooks
- [Migration](operations/migration.md) — moving existing MCP configurations
  behind the gateway, and back

## Reference

- [Configuration](reference/configuration.md) — every environment variable
- [Compatibility](reference/compatibility.md) — upstream support tiers,
  downstream client notes, transport and version negotiation

## Decisions

- [Decision records](decisions/) — what was decided, what was rejected, and
  what it cost
