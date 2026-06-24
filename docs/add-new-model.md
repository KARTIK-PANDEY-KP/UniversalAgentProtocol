# Add a new model

1. Add a model entry to `app/registries/model_registry.yaml`.
2. Use an internal id like `openrouter:provider/model-slug`.
3. Set `executor: portkey` and `executor_model: "@openrouter/provider/model-slug"`.
4. Start with `status: registered` or `status: disabled` until tested.
5. Add capability, cost, support, and limit fields.
6. Add the model id to one or more `model_pools`.
7. Validate the string with:

```bash
uv run python scripts/test_model_string.py --model openrouter:provider/model-slug
```

Real execution must be explicitly gated:

```bash
RUN_REAL_PROVIDER_TESTS=true uv run python scripts/test_model_string.py \
  --model openrouter:provider/model-slug --execute
```
