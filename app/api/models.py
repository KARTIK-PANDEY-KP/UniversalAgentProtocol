from typing import Annotated

from fastapi import APIRouter, Depends

from app.dependencies import runtime_kernel_dependency
from app.runtime.kernel import RuntimeKernel

router = APIRouter()


@router.get("/v1/models")
def list_models(
    kernel: Annotated[RuntimeKernel, Depends(runtime_kernel_dependency)],
) -> dict[str, object]:
    return {
        "object": "list",
        "data": [
            {"id": model, "object": "model", "owned_by": "brainbase"}
            for model in kernel.list_public_models()
        ],
    }


@router.get("/v1/capabilities")
def capabilities(
    kernel: Annotated[RuntimeKernel, Depends(runtime_kernel_dependency)],
) -> dict[str, object]:
    return kernel.capabilities()
