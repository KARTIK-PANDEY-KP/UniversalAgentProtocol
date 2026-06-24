# Deployment

The MVP is a single Render web service using Docker.

Required environment variables:

- `PORTKEY_API_KEY`
- `OPENROUTER_API_KEY`
- `SUPABASE_URL`
- `SUPABASE_SECRET_KEY` or `SUPABASE_SERVICE_ROLE_KEY`
- `SUPABASE_PUBLISHABLE_KEY` or `SUPABASE_ANON_KEY`

Runtime mode for production:

```bash
EXECUTOR_MODE=portkey
REGISTRY_MODE=supabase
STORAGE_MODE=supabase
```

The Docker command binds Uvicorn to `0.0.0.0:${PORT}` as required by Render. Secrets should be configured
in Render and never committed.

Apply the database schema from `database/supabase_schema.sql` before enabling Supabase-backed storage.
Seed `model_registry`, `policy_registry`, and `public_model_aliases` from the YAML registry files before
serving traffic in `REGISTRY_MODE=supabase`.
