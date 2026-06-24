class RegistryError(RuntimeError):
    """Base registry error."""


class UnknownPublicModelError(RegistryError):
    """Raised when a customer-facing Brainbase model alias is unknown."""


class UnknownModelError(RegistryError):
    """Raised when an internal model id is unknown."""


class UnknownPolicyError(RegistryError):
    """Raised when a policy registry entry is unknown."""
