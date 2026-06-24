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

Native router modes that are not fully executable in the MVP, such as `multi_call`,
`budgeted_single`, and `context_routing`, are represented in `RoutePlan.metadata.native_mode`
while returning an executable MVP mode (`single`, `cascade`, or `agent_step`).

Run a real capped canary across all adapters:

```bash
RUN_REAL_PROVIDER_TESTS=true PORTKEY_API_KEY=... make benchmark-canary-real-routers
```
