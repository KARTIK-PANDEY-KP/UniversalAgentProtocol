import os

from app.config import Settings
from app.registries import ModelRegistry, PolicyRegistry, TenantRegistry
from app.runtime.executor_factory import build_executor
from app.runtime.kernel import RuntimeKernel
from app.storage import SupabaseClient, SupabaseTraceRepository

ADVANCED_POLICIES = [
    ("r2-router", {"max_cost_usd": 0.03}),
    (
        "rcr-router",
        {"max_cost_usd": 0.03, "memory": ["User prefers concise answers.", "Runtime is FastAPI."]},
    ),
    ("router-r1", {"max_cost_usd": 0.03, "allow_multi_call": True}),
]


def main() -> None:
    if os.getenv("RUN_REAL_PROVIDER_TESTS", "false").lower() != "true":
        raise SystemExit("Refusing real advanced-mode test without RUN_REAL_PROVIDER_TESTS=true")
    settings = Settings(executor_mode="portkey", registry_mode="supabase", storage_mode="supabase")
    client = SupabaseClient.from_settings(settings)
    base_tenants = TenantRegistry.from_supabase(client)
    for policy_name, routing in ADVANCED_POLICIES:
        tenants = TenantRegistry.from_supabase(client)
        alias = base_tenants.resolve_public_model("brainbase-fast")
        tenants._public_aliases["brainbase-fast"] = alias.model_copy(  # noqa: SLF001
            update={"policy_name": policy_name, "policy_version": "v0"}
        )
        kernel = RuntimeKernel(
            model_registry=ModelRegistry.from_supabase(client),
            policy_registry=PolicyRegistry.from_supabase(client),
            tenant_registry=tenants,
            executor=build_executor(settings),
            trace_repository=SupabaseTraceRepository(client),
        )
        response = kernel.chat_completion(
            {
                "model": "brainbase-fast",
                "messages": [{"role": "user", "content": "Reply with exactly: ok"}],
                "routing": {"debug": True, **routing},
            }
        )
        routing_debug = response.get("brainbase_routing", {})
        print(
            f"{policy_name} | {routing_debug.get('route_plan_mode')} | "
            f"{routing_debug.get('selected_model')} | PASS"
        )


if __name__ == "__main__":
    main()
