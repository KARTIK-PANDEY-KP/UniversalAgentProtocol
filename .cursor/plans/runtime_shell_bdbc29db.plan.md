---
name: runtime shell
overview: Build the backend-only Brainbase Model Runtime MVP in the current workspace root, starting with the stable runtime shell and cheap mock-mode verification before any real provider calls.
todos:
  - id: foundation
    content: Create backend repo skeleton, dependency config, Makefile targets, env example, Dockerfile, Render config, and placeholder tests.
    status: pending
  - id: protocol
    content: Implement Pydantic protocol models and RouterPolicy base contract with validation tests.
    status: pending
  - id: registries
    content: Fan-out subagent implements YAML-first model, policy, and alias registries with Supabase-backed interfaces.
    status: pending
  - id: executor
    content: Fan-out subagent implements mock executor and gated Portkey/OpenRouter executor with mocked HTTP tests.
    status: pending
  - id: api-runtime
    content: Fan-out API subagent builds endpoints; integration pass wires RuntimeKernel, RoutePlan validation, response normalization, and trace creation.
    status: pending
  - id: storage
    content: Fan-out subagent adds Supabase schema and repository layer for traces, registries, benchmarks, and artifacts.
    status: pending
  - id: policies
    content: Fan-out subagent implements baseline RouterPolicy plug-ins and policy tests.
    status: pending
  - id: bench-shadow
    content: Parallel benchmark/shadow subagent implements skeletons with cost and execution guards after runtime contracts are stable.
    status: pending
  - id: verify-docs
    content: Run required verification targets and document usage, testing, benchmarking, deployment, and extension workflows.
    status: pending
isProject: false
---

# Brainbase Model Runtime Shell

## Confirmed Setup
- Use `/Users/kapie/Projects/brainbase/router` as the repo root.
- Build only backend code: Python, FastAPI, Pydantic, Uvicorn, Portkey/OpenRouter, Supabase, Render config.
- Public model aliases start as `brainbase-chat`, `brainbase-code`, and `brainbase-agent`.
- Normal development runs with `EXECUTOR_MODE=mock`, `REGISTRY_MODE=yaml`, and `STORAGE_MODE=memory`.
- Real Supabase and Portkey/OpenRouter checks stay opt-in and gated by `RUN_SUPABASE_TESTS=true` or `RUN_REAL_PROVIDER_TESTS=true`.

## Source-Of-Truth Rules
- The four supplied PDFs are stored in `[source-documents/](source-documents/)` and are the binding specification for the full development effort:
  - `[source-documents/Brainbase Router Architecture and Protocol Design.pdf](source-documents/Brainbase%20Router%20Architecture%20and%20Protocol%20Design.pdf)` for core abstractions and architecture.
  - `[source-documents/Brainbase Model Product — Implementation Plan.pdf](source-documents/Brainbase%20Model%20Product%20%E2%80%94%20Implementation%20Plan.pdf)` for repo layout, phases, MVP scope, public model names, environment variables, Supabase model, and deployment approach.
  - `[source-documents/Brainbase Model Product — Development Resource Index.pdf](source-documents/Brainbase%20Model%20Product%20%E2%80%94%20Development%20Resource%20Index.pdf)` only for external docs and links.
  - `[source-documents/Brainbase Model Runtime Documentation.pdf](source-documents/Brainbase%20Model%20Runtime%20Documentation.pdf)` as the final execution, test-mode, Makefile, benchmark, shadow-testing, and acceptance checklist.
- Before each wave starts, I will cross-check its scope against the relevant document sections and include those constraints in the subagent prompt.
- Each subagent must report which document requirements it implemented, which tests it ran, and any deviations or unresolved questions.
- If the documents appear ambiguous, I will resolve the ambiguity from the documents first, using your required reading order as precedence: architecture for core abstractions, implementation plan for layout/phases/MVP scope, resource index only for external links, and runtime documentation for execution/testing acceptance.
- If the documents conflict, I will use the more specific later checklist only for execution/testing details, while preserving the architecture and implementation-plan product constraints.
- I will ask you only when the documents provide no possible way to determine a required behavior or when external credentials/access are physically required to continue.
- No extra infrastructure, public model names, router APIs, provider access paths, benchmark behavior, or data schema changes may be added unless one of the documents explicitly calls for it or you approve it.

## What I Need From You
- Provide runtime secrets outside committed code: `PORTKEY_API_KEY`, `OPENROUTER_API_KEY`, `SUPABASE_URL`, `SUPABASE_SECRET_KEY` or `SUPABASE_SERVICE_ROLE_KEY`, and `SUPABASE_PUBLISHABLE_KEY` or `SUPABASE_ANON_KEY`.
- Confirm when it is OK to apply the Supabase schema in the target project. Until then I will create `database/supabase_schema.sql` and keep real DB tests gated.
- `RENDER_API_KEY` is only needed if you want me to deploy programmatically. `GITHUB_TOKEN` is only needed if you want me to push/create PRs from here.

## Fan-Out Implementation Order
1. Wave 0, foundation: one primary pass creates `pyproject.toml`, `Makefile`, `.env.example`, `Dockerfile`, `render.yaml`, `README.md`, `app/main.py`, required package folders, pytest setup, and placeholder tests. Use `uv` for dependency management. This must pass `make install`, `make test`, and `make check` before fan-out.
2. Wave 1, protocol: one protocol pass implements the canonical Pydantic objects in `app/protocol/` and `RouterPolicy.plan(...) -> RoutePlan` in `app/policies/base.py`. This is deliberately sequential because no other subagent should invent schemas. It must pass `make test tests/protocol`.
3. Wave 2, parallel module fan-out: after protocol lands, launch independent subagents concurrently for API, registries, executor, storage, and baseline policies. Each subagent owns its module implementation plus module tests and must return changed files, commands run, pass/fail output, and integration notes.
4. Wave 2A, API subagent: build `GET /health`, `GET /v1/models`, and `POST /v1/chat/completions` in `app/api/`, delegating to `RuntimeKernel` without routing/provider logic. Acceptance: `make test tests/api`.
5. Wave 2B, registry subagent: build YAML-first model, policy, tenant, and public alias loaders in `app/registries/`; add Supabase-backed loading interfaces without making Supabase required for normal tests. Acceptance: `make test tests/registries`.
6. Wave 2C, executor subagent: build `app/executor/mock_executor.py`, OpenRouter model string resolution, and a Portkey executor with mocked HTTP tests. Real calls remain gated. Acceptance: `make test tests/executor`.
7. Wave 2D, storage subagent: build `database/supabase_schema.sql` and repositories in `app/storage/` for traces, registries, benchmarks, and artifacts. Normal tests use mocked Supabase clients. Acceptance: `make test tests/storage`.
8. Wave 2E, policy subagent: implement `always-strongest`, `always-cheapest`, `always-fastest`, `manual-rules`, and `random-policy` as RouterPolicy plug-ins only. Acceptance: `make test tests/policies`.
9. Wave 3, fan-in runtime integration: one integration pass wires request normalization, public alias resolution, candidate resolution, policy loading, `RoutePlan` validation, executor selection, response normalization, and trace writing in `app/runtime/`. Acceptance: `make test tests/runtime` and `make smoke-mock`.
10. Wave 4, parallel benchmark/shadow and docs/deployment: once runtime tests pass, launch benchmark/shadow and documentation/deployment subagents in parallel. Benchmark/shadow builds mock, dry-run, canary-real, full-guarded benchmark modes and shadow decision logging. Docs/deployment finalizes customer usage, testing, benchmarking, adding models, adding policies, and Render instructions.
11. Wave 5, final verification: run `make check`, then gated Supabase and real provider checks only when env vars are present and flags are explicitly enabled.

## Fan-Out Rules
- I will use parallel subagents only after the shared contracts are in place: foundation first, protocol second, then module fan-out.
- Every subagent prompt will include the relevant document-derived constraints, the document precedence rules, and the instruction to continue by deriving answers from the PDFs before escalating.
- Subagents must not make public model names include `router`; public names remain `brainbase-chat`, `brainbase-code`, and `brainbase-agent`.
- Subagents must not add forbidden MVP infrastructure: no Kafka, Redis, LangFuse, Sentry, Stripe, Clerk, direct provider keys, or S3.
- Subagents must keep routers behind `RouterPolicy.plan(...) -> RoutePlan`; routers must not call providers, Supabase, Portkey, or HTTP directly.
- Each subagent must run its own focused tests before returning. The integration pass will rerun module tests that touch shared boundaries.
- Real provider work is never part of fan-out module tests; it is only a final gated smoke/canary step.

## Verification Gates
- After each module: run the relevant target, for example `make test tests/protocol`, `make test tests/registries`, `make test tests/executor`, or `make test tests/runtime`.
- Before real calls: run `make check`, including lint, typecheck, unit tests, `smoke-mock`, `benchmark-mock`, and `benchmark-dry-run`.
- Only after mock checks pass: run `RUN_SUPABASE_TESTS=true make test tests/storage`, `RUN_REAL_PROVIDER_TESTS=true make smoke-real`, and optionally capped `RUN_REAL_PROVIDER_TESTS=true make benchmark-canary-real`.
- Never run full benchmarks during MVP development; require explicit `--full --confirm-cost` guards for future full runs.
