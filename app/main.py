from fastapi import FastAPI

from app.api.frontend import router as frontend_router
from app.api.health import router as health_router
from app.api.models import router as models_router
from app.api.openai_compatible import router as openai_router


def create_app() -> FastAPI:
    app = FastAPI(title="Brainbase Model Runtime", version="0.1.0")
    app.include_router(frontend_router)
    app.include_router(health_router)
    app.include_router(models_router)
    app.include_router(openai_router)
    return app


app = create_app()
