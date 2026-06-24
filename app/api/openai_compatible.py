from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field

from app.dependencies import runtime_kernel_dependency
from app.registries.errors import UnknownPublicModelError
from app.runtime.errors import RoutePlanValidationError, RuntimeErrorBase
from app.runtime.kernel import RuntimeKernel

router = APIRouter(prefix="/v1")


class ChatCompletionRequest(BaseModel):
    model_config = ConfigDict(extra="allow")

    model: str
    messages: list[dict[str, Any]] = Field(min_length=1)
    tools: list[dict[str, Any]] | None = None
    response_format: dict[str, Any] | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)
    tenant_id: str | None = None
    workflow_id: str | None = None
    step_id: str | None = None
    routing: dict[str, Any] | None = None


@router.post("/chat/completions")
def chat_completions(
    request: ChatCompletionRequest,
    kernel: Annotated[RuntimeKernel, Depends(runtime_kernel_dependency)],
) -> dict[str, Any]:
    try:
        return kernel.chat_completion(request.model_dump(mode="json"))
    except UnknownPublicModelError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except RoutePlanValidationError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except RuntimeErrorBase as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
