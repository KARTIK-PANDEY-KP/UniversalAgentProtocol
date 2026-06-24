# Brainbase Model Runtime

Backend-only MVP shell for first-party Brainbase model names:

- `brainbase-chat`
- `brainbase-code`
- `brainbase-agent`
- `brainbase-fast`
- `brainbase-premium`

The public API is OpenAI-compatible. Internally, the runtime is built around a stable
`RouterPolicy.plan(...) -> RoutePlan` protocol, Portkey/OpenRouter execution, and Supabase
traces/registries.

## Local setup

```bash
make install
make check
```

Normal development uses mock/YAML/memory mode and never calls paid providers.
