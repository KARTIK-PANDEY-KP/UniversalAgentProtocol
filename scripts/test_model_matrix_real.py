import os

from app.config import Settings
from app.runtime.kernel import RuntimeKernel

MODEL_MATRIX = [
    ("small_openai", "openrouter:openai/gpt-4o-mini"),
    ("small_anthropic", "openrouter:anthropic/claude-3-haiku"),
    ("open_source_small", "openrouter:meta-llama/llama-3.2-3b-instruct"),
    ("open_source_medium_mistral", "openrouter:mistralai/mistral-small-2603"),
    ("open_source_large_llama", "openrouter:meta-llama/llama-3.1-70b-instruct"),
    ("coding_open_source_qwen", "openrouter:qwen/qwen-2.5-coder-32b-instruct"),
    ("google_flash_current", "openrouter:google/gemini-3.5-flash"),
    ("frontier_openai_current", "openrouter:openai/gpt-4o-2024-11-20"),
    ("frontier_anthropic_sonnet", "openrouter:anthropic/claude-sonnet-4.6"),
    ("super_large_anthropic_opus", "openrouter:anthropic/claude-opus-4.8-fast"),
]


def main() -> None:
    if os.getenv("RUN_REAL_PROVIDER_TESTS", "false").lower() != "true":
        raise SystemExit("Refusing real model matrix without RUN_REAL_PROVIDER_TESTS=true")
    settings = Settings(executor_mode="portkey", registry_mode="supabase", storage_mode="supabase")
    kernel = RuntimeKernel.from_settings(settings)
    passed = 0
    for category, model_id in MODEL_MATRIX:
        response = kernel.chat_completion(
            {
                "model": "brainbase-fast",
                "messages": [{"role": "user", "content": "Reply with exactly: ok"}],
                "routing": {
                    "debug": True,
                    "test_mode": True,
                    "force_model": model_id,
                    "max_cost_usd": 0.03,
                },
            }
        )
        content = response["choices"][0]["message"].get("content")
        print(f"{category} | {model_id} | PASS | {str(content)[:80]}")
        passed += 1
    print(f"SUMMARY passed={passed} total={len(MODEL_MATRIX)}")


if __name__ == "__main__":
    main()
