# Upstream router source availability

This project can host Brainbase `RouterPolicy` adapters for router papers/libraries, but exact upstream
implementations require a public repository and the upstream runtime dependencies.

Verified official/public upstreams:

- LLMRouter: `https://github.com/ulab-uiuc/LLMRouter.git`
  - Covers `llmrouter`, `graphrouter`, `mtrouter`, `gmtrouter`, and LLMRouter's Router-R1 integration.
- RouteLLM: `https://github.com/lm-sys/RouteLLM.git`
  - Covers `mf-router`.
- Avengers-Pro: `https://github.com/ZhangYiqun018/AvengersPro.git`
  - Covers `avengers-pro`.
- Router-R1: `https://github.com/ulab-uiuc/Router-R1.git`
  - Covers standalone Router-R1; exact runtime requires model weights and GPU/vLLM-style dependencies.
- Lookahead: `https://github.com/huangcb01/lookahead-routing.git`
  - Covers `lookahead`.

No official importable runtime repo was verified for:

- HyDRA
- RouteNLP
- TwinRouterBench as a production router
- policy-guided stepwise routing
- R2-Router
- OrcaRouter
- BaRP
- DecoR
- TRouter
- RCR-Router
- BoundaryRouter
- Brainbase-trained router

Fetch official upstream repositories without committing vendored code:

```bash
PYTHONPATH=. uv run python scripts/fetch_upstream_routers.py --all
```

The fetched code is placed under `vendor/upstream/`, which is intentionally gitignored. The Brainbase
runtime remains stable and only depends on `RouterPolicy.plan(...) -> RoutePlan`; exact upstream runtime
bridges should be enabled only when their dependencies, model weights, and required hardware/API keys are
available.
