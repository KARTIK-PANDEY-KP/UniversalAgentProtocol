from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Runtime settings with safe local defaults for mock development."""

    executor_mode: str = "mock"
    registry_mode: str = "yaml"
    storage_mode: str = "memory"
    portkey_api_key: str | None = None
    openrouter_api_key: str | None = None
    supabase_url: str | None = None
    supabase_secret_key: str | None = None
    supabase_service_role_key: str | None = None
    supabase_publishable_key: str | None = None
    supabase_anon_key: str | None = None
    run_real_provider_tests: bool = False
    run_supabase_tests: bool = False

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")


@lru_cache
def get_settings() -> Settings:
    return Settings()
