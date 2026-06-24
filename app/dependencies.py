from functools import lru_cache

from app.config import Settings, get_settings
from app.runtime.kernel import RuntimeKernel


def settings_dependency() -> Settings:
    return get_settings()


@lru_cache
def get_runtime_kernel() -> RuntimeKernel:
    return RuntimeKernel.from_settings(get_settings())


def runtime_kernel_dependency() -> RuntimeKernel:
    return get_runtime_kernel()
