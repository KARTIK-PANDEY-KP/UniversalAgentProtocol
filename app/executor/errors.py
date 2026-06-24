class ExecutorError(RuntimeError):
    """Base executor error."""


class InvalidModelStringError(ExecutorError):
    """Raised when an internal model id cannot be resolved for execution."""


class ProviderExecutionError(ExecutorError):
    """Raised when Portkey/OpenRouter execution fails."""
