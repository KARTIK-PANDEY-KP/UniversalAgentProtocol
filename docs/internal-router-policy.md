# Internal RouterPolicy contract

Every router must implement:

```python
RouterPolicy.plan(
    request: RouterRequest,
    candidates: list[ModelProfile],
    context: RoutingContext,
    budget: RoutingBudget,
) -> RoutePlan
```

Policies must not call providers, Portkey, Supabase, or HTTP directly. They return a `RoutePlan` only.
The runtime validates the plan before execution.

MVP executable modes are `single`, `cascade`, and `agent_step`. Future schema modes can exist, but the
runtime will reject them until execution support is added.
