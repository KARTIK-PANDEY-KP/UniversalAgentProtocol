import time
import uuid
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from app.api.models import PUBLIC_MODELS

router = APIRouter(prefix="/v1")


class ChatCompletionRequest(BaseModel):
    model: str
    messages: list[dict[str, Any]] = Field(min_length=1)


@router.post("/chat/completions")
def chat_completions(request: ChatCompletionRequest) -> dict[str, Any]:
    if request.model not in PUBLIC_MODELS:
        raise HTTPException(status_code=400, detail=f"Unknown public model: {request.model}")

    return {
        "id": f"chatcmpl_{uuid.uuid4().hex}",
        "object": "chat.completion",
        "created": int(time.time()),
        "model": request.model,
        "choices": [
            {
                "index": 0,
                "message": {
                    "role": "assistant",
                    "content": "Brainbase mock runtime is ready.",
                },
                "finish_reason": "stop",
            }
        ],
        "usage": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0},
    }
