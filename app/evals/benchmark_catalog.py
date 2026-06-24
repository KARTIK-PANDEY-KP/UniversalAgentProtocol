from pydantic import BaseModel


class BenchmarkResource(BaseModel):
    name: str
    url: str
    resource_type: str
    notes: str


BENCHMARK_CATALOG: dict[str, BenchmarkResource] = {
    "llmrouterbench": BenchmarkResource(
        name="llmrouterbench",
        url="https://github.com/ynulihao/LLMRouterBench",
        resource_type="git_repository",
        notes="Unified LLM routing benchmark referenced for router comparison.",
    ),
    "twinrouterbench": BenchmarkResource(
        name="twinrouterbench",
        url="https://github.com/CommonstackAI/TwinRouterBench",
        resource_type="git_repository",
        notes="Agent-step routing benchmark for intermediate workflow calls.",
    ),
    "routejudge": BenchmarkResource(
        name="routejudge",
        url="https://routejudge.cn",
        resource_type="website",
        notes="Preference-aware router evaluation resource.",
    ),
    "orbit": BenchmarkResource(
        name="orbit",
        url="https://github.com/AIGNLAI/LAMDA-ORBIT",
        resource_type="git_repository",
        notes="ORBIT standardized router benchmarking resource.",
    ),
    "routebench-boundaryrouter": BenchmarkResource(
        name="routebench-boundaryrouter",
        url="https://arxiv.org/abs/2605.07180",
        resource_type="paper",
        notes="BoundaryRouter / RouteBench direct-vs-agent routing benchmark reference.",
    ),
}


def list_benchmarks() -> list[BenchmarkResource]:
    return list(BENCHMARK_CATALOG.values())


def get_benchmark(name: str) -> BenchmarkResource:
    return BENCHMARK_CATALOG[name]
