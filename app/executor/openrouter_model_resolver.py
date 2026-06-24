from app.executor.errors import InvalidModelStringError


def resolve_openrouter_executor_model(model_id: str) -> str:
    prefix = "openrouter:"
    if not model_id.startswith(prefix):
        raise InvalidModelStringError(
            f"Only OpenRouter model ids are executable in MVP: {model_id}"
        )
    slug = model_id.removeprefix(prefix)
    if "/" not in slug or slug.startswith("/") or slug.endswith("/"):
        raise InvalidModelStringError(f"Invalid OpenRouter model id: {model_id}")
    return f"@openrouter/{slug}"
