# Router plug-ins

The runtime includes MVP protocol adapters for the router families named in the source documents.
Each adapter implements `RouterPolicy.plan(...) -> RoutePlan` and does not call providers, Portkey,
Supabase, or HTTP.

Implemented adapters:

- `hydra`
- `graphrouter`
- `llmrouter`
- `mf-router`
- `avengers-pro`
- `routenlp`
- `twinrouterbench`
- `mtrouter`
- `gmtrouter`
- `policy-guided-stepwise`
- `r2-router`
- `orcarouter`
- `barp`
- `router-r1`
- `decor`
- `lookahead`
- `trouter`
- `rcr-router`
- `boundary-router`
- `brainbase-trained`

## HyDRA upstream status

I could not find an official public author repository for HyDRA. The implementation therefore does not
vendor unpublished GitHub/Microsoft code. The `hydra` policy implements the published algorithmic core from
the paper:

- 7-flag input signal prefix
- 4 capability dimensions: reasoning, coding, debugging, tool use
- config-defined model capability profiles
- weighted shortfall score
- cheapest eligible model where shortfall is below `shortfall_tau`
- fail-open to least-shortfall model when no candidate is eligible

The capability predictor is currently a deterministic feature heuristic because the paper’s ModernBERT
checkpoint/heads are not public. The policy metadata records `upstream_code=not_publicly_released`, and
the adapter seam can be swapped to a real checkpoint if one is released.

Native router modes that are not fully executable in the MVP, such as `multi_call`,
`budgeted_single`, and `context_routing`, are represented in `RoutePlan.metadata.native_mode`
while returning an executable MVP mode (`single`, `cascade`, or `agent_step`).

Run a real capped canary across all adapters:

```bash
RUN_REAL_PROVIDER_TESTS=true PORTKEY_API_KEY=... make benchmark-canary-real-routers
```
