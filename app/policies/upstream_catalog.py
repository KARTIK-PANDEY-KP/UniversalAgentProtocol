from pydantic import BaseModel


class UpstreamRouterSource(BaseModel):
    policy_names: list[str]
    repository: str | None
    commit: str | None
    status: str
    notes: str


UPSTREAM_ROUTER_SOURCES: dict[str, UpstreamRouterSource] = {
    "llmrouter": UpstreamRouterSource(
        policy_names=[
            "graphrouter",
            "llmrouter",
            "mtrouter",
            "gmtrouter",
            "router-r1",
        ],
        repository="https://github.com/ulab-uiuc/LLMRouter.git",
        commit="c65a32b1435bacdb1488280effef28a6ff89edf6",
        status="official_public",
        notes=(
            "Official LLMRouter library includes GraphRouter, multi-round, personalized, "
            "and Router-R1 integrations."
        ),
    ),
    "routellm": UpstreamRouterSource(
        policy_names=["mf-router"],
        repository="https://github.com/lm-sys/RouteLLM.git",
        commit=None,
        status="official_public",
        notes=(
            "Official RouteLLM framework; MF router may require package extras and "
            "external embedding/API configuration."
        ),
    ),
    "avengers-pro": UpstreamRouterSource(
        policy_names=["avengers-pro"],
        repository="https://github.com/ZhangYiqun018/AvengersPro.git",
        commit="dfb60b156c4b6011b89edfc8516aa16d8e4f4d38",
        status="official_public",
        notes=(
            "Official Avengers-Pro repository with clustering/performance-efficiency "
            "routing code."
        ),
    ),
    "router-r1": UpstreamRouterSource(
        policy_names=["router-r1"],
        repository="https://github.com/ulab-uiuc/Router-R1.git",
        commit="801a240e37701577907c32de27a548af4e6c4430",
        status="official_public",
        notes=(
            "Official Router-R1 repository; exact runtime requires model weights and "
            "GPU/vLLM-style environment."
        ),
    ),
    "lookahead": UpstreamRouterSource(
        policy_names=["lookahead"],
        repository="https://github.com/huangcb01/lookahead-routing.git",
        commit="9c9135f5143f8dc9c83dfd957aff44df086f9338",
        status="official_public",
        notes="Official Lookahead routing repository with CLM/MLM training and inference code.",
    ),
    "hydra": UpstreamRouterSource(
        policy_names=["hydra"],
        repository=None,
        commit=None,
        status="paper_only_no_public_code_found",
        notes=(
            "No official public HyDRA code/checkpoint was found; adapter implements "
            "the published shortfall matching algorithm."
        ),
    ),
    "paper-only": UpstreamRouterSource(
        policy_names=[
            "routenlp",
            "twinrouterbench",
            "policy-guided-stepwise",
            "r2-router",
            "orcarouter",
            "barp",
            "decor",
            "trouter",
            "rcr-router",
            "boundary-router",
            "brainbase-trained",
        ],
        repository=None,
        commit=None,
        status="no_verified_official_runtime_repo",
        notes=(
            "No importable official runtime repository was verified during GitHub search; "
            "adapters remain protocol-compatible paper/MVP implementations."
        ),
    ),
}


def sources_for_policy(policy_name: str) -> list[UpstreamRouterSource]:
    return [
        source
        for source in UPSTREAM_ROUTER_SOURCES.values()
        if policy_name in source.policy_names
    ]
