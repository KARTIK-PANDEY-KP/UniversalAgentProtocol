class RuntimeErrorBase(RuntimeError):
    """Base runtime error."""


class RoutePlanValidationError(RuntimeErrorBase):
    """Raised when a policy returns a plan that must not execute."""


class RuntimeExecutionError(RuntimeErrorBase):
    """Raised when the runtime cannot complete a request."""
