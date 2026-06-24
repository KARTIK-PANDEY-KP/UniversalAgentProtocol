from fastapi import APIRouter

PUBLIC_MODELS = [
    "brainbase-chat",
    "brainbase-code",
    "brainbase-agent",
    "brainbase-fast",
    "brainbase-premium",
]

router = APIRouter()


@router.get("/v1/models")
def list_models() -> dict[str, object]:
    return {
        "object": "list",
        "data": [
            {"id": model, "object": "model", "owned_by": "brainbase"} for model in PUBLIC_MODELS
        ],
    }
