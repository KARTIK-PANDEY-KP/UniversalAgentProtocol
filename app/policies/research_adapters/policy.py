from app.policies.base import RouterPolicy
from app.policies.selection import choose_best, numeric_metric, require_candidates
from app.protocol.model_profile import ModelProfile
from app.protocol.route_plan import RoutePlan
from app.protocol.route_step import RouteStep
from app.protocol.router_request import RouterRequest
from app.protocol.routing_budget import RoutingBudget
from app.protocol.routing_context import RoutingContext


def request_text(request: RouterRequest) -> str:
    return " ".join(str(message.get("content", "")) for message in request.messages).lower()


def infer_capability(request: RouterRequest, budget: RoutingBudget) -> str:
    text = request_text(request)
    if request.public_model == "brainbase-code" or budget.mode == "code":
        return "coding"
    if request.public_model == "brainbase-agent" or budget.mode == "agent" or request.tools:
        return "tool_use"
    if any(term in text for term in ["bug", "error", "traceback", "debug", "fix"]):
        return "debugging"
    if any(term in text for term in ["reason", "prove", "math", "compare", "why"]):
        return "reasoning"
    if budget.mode == "fast":
        return "latency_score"
    return "overall"


def model_cost(model: ModelProfile) -> float:
    input_cost = numeric_metric(model, ("cost", "input_per_million"), 1_000_000.0)
    output_cost = numeric_metric(model, ("cost", "output_per_million"), 1_000_000.0)
    return input_cost + output_cost


def capability_score(model: ModelProfile, capability: str) -> float:
    return numeric_metric(model, ("capabilities", capability), 0.0)


def efficient_score(model: ModelProfile, capability: str) -> float:
    return capability_score(model, capability) / max(model_cost(model), 0.01)


class ResearchAdapterPolicy(RouterPolicy):
    name = "research-adapter"
    version = "v0"
    supported_modes = ["single"]
    native_router = "generic"

    def plan(
        self,
        request: RouterRequest,
        candidates: list[ModelProfile],
        context: RoutingContext,
        budget: RoutingBudget,
    ) -> RoutePlan:
        del context
        capability = infer_capability(request, budget)
        selected = self.select_model(request, candidates, capability, budget)
        return RoutePlan(
            mode="single",
            selected_model=selected.id,
            fallback_models=self.fallbacks(selected, candidates),
            confidence=self.confidence(selected, capability),
            policy_name=self.name,
            policy_version=self.version,
            metadata={
                "native_router": self.native_router,
                "adapter": "mvp_protocol_adapter",
                "capability": capability,
            },
        )

    def select_model(
        self,
        request: RouterRequest,
        candidates: list[ModelProfile],
        capability: str,
        budget: RoutingBudget,
    ) -> ModelProfile:
        del request, budget
        return choose_best(candidates, key=lambda model: capability_score(model, capability))

    def fallbacks(self, selected: ModelProfile, candidates: list[ModelProfile]) -> list[str]:
        alternatives = [
            candidate for candidate in require_candidates(candidates) if candidate.id != selected.id
        ]
        return [candidate.id for candidate in alternatives[:1]]

    def confidence(self, selected: ModelProfile, capability: str) -> float:
        return min(max(capability_score(selected, capability), 0.2), 0.99)


class HydraPolicy(ResearchAdapterPolicy):
    name = "hydra"
    native_router = "HyDRA capability-profile router"

    dimensions = ("reasoning", "coding", "debugging", "tool_use")

    def plan(
        self,
        request: RouterRequest,
        candidates: list[ModelProfile],
        context: RoutingContext,
        budget: RoutingBudget,
    ) -> RoutePlan:
        requirements = self._predict_requirements(request)
        weights = self._weights(context)
        tau = float(context.policy_config.get("shortfall_tau", 0.20))
        selected, shortfalls = self._shortfall_match(candidates, requirements, weights, tau)
        return RoutePlan(
            mode="single",
            selected_model=selected.id,
            fallback_models=self.fallbacks(selected, candidates),
            confidence=max(0.2, min(0.99, 1.0 - shortfalls[selected.id])),
            policy_name=self.name,
            policy_version=self.version,
            metadata={
                "native_router": self.native_router,
                "algorithm": "paper_shortfall_matching",
                "input_features": self._signal_prefix(request),
                "requirements": requirements,
                "weights": weights,
                "shortfall_tau": tau,
                "shortfalls": shortfalls,
                "upstream_code": "not_publicly_released",
            },
        )

    def _predict_requirements(self, request: RouterRequest) -> dict[str, float]:
        text = request_text(request)
        prefix = self._signal_prefix(request)
        requirements = {
            "reasoning": 0.35,
            "coding": 0.30,
            "debugging": 0.25,
            "tool_use": 0.20,
        }
        if prefix["has_code"] or request.public_model == "brainbase-code":
            requirements["coding"] += 0.35
            requirements["reasoning"] += 0.15
        if prefix["has_error"]:
            requirements["debugging"] += 0.45
            requirements["reasoning"] += 0.10
        if prefix["has_command"] or request.tools or request.public_model == "brainbase-agent":
            requirements["tool_use"] += 0.45
            requirements["reasoning"] += 0.10
        if prefix["has_file"] or prefix["has_url"]:
            requirements["reasoning"] += 0.20
        if any(term in text for term in ["prove", "why", "compare", "tradeoff", "architecture"]):
            requirements["reasoning"] += 0.30
        if prefix["is_short"]:
            requirements = {key: value * 0.75 for key, value in requirements.items()}
        return {key: min(value, 1.0) for key, value in requirements.items()}

    @staticmethod
    def _signal_prefix(request: RouterRequest) -> dict[str, bool | str]:
        text = request_text(request)
        error_terms = ["error", "traceback", "exception", "failed"]
        command_markers = ["npm ", "uv ", "python ", "git ", "make "]
        code_markers = ["def ", "class ", "function ", "```", "import "]
        return {
            "turn_count_bin": "single_turn",
            "has_error": any(term in text for term in error_terms),
            "has_file": any(marker in text for marker in [".py", ".js", ".ts", ".md", "/"]),
            "has_url": "http://" in text or "https://" in text,
            "has_command": any(marker in text for marker in command_markers),
            "has_code": any(marker in text for marker in code_markers),
            "is_short": len(text.split()) <= 16,
        }

    def _shortfall_match(
        self,
        candidates: list[ModelProfile],
        requirements: dict[str, float],
        weights: dict[str, float],
        tau: float,
    ) -> tuple[ModelProfile, dict[str, float]]:
        available = require_candidates(candidates)
        shortfalls = {
            model.id: sum(
                weights[dimension]
                * max(0.0, requirements[dimension] - capability_score(model, dimension))
                for dimension in self.dimensions
            )
            for model in available
        }
        eligible = [model for model in available if shortfalls[model.id] <= tau]
        if eligible:
            return min(eligible, key=model_cost), shortfalls
        selected = min(available, key=lambda model: (shortfalls[model.id], model_cost(model)))
        return selected, shortfalls

    def _weights(self, context: RoutingContext) -> dict[str, float]:
        raw_weights = context.policy_config.get("weights", {})
        weights = {
            dimension: (
                float(raw_weights.get(dimension, 1.0)) if isinstance(raw_weights, dict) else 1.0
            )
            for dimension in self.dimensions
        }
        total = sum(weights.values()) or 1.0
        return {dimension: value / total for dimension, value in weights.items()}


class GraphRouterPolicy(ResearchAdapterPolicy):
    name = "graphrouter"
    native_router = "GraphRouter effect-cost graph router"

    def select_model(
        self,
        request: RouterRequest,
        candidates: list[ModelProfile],
        capability: str,
        budget: RoutingBudget,
    ) -> ModelProfile:
        del request, budget
        return choose_best(candidates, key=lambda model: efficient_score(model, capability))


class LLMRouterPolicy(GraphRouterPolicy):
    name = "llmrouter"
    native_router = "LLMRouter library baseline"


class MFRouterPolicy(GraphRouterPolicy):
    name = "mf-router"
    native_router = "RouteLLM MFRouter strong-vs-weak baseline"


class AvengersProPolicy(GraphRouterPolicy):
    name = "avengers-pro"
    native_router = "Avengers-Pro performance-efficiency router"


class RouteNLPPolicy(ResearchAdapterPolicy):
    name = "routenlp"
    native_router = "RouteNLP conformal cascade router"
    supported_modes = ["cascade"]

    def plan(
        self,
        request: RouterRequest,
        candidates: list[ModelProfile],
        context: RoutingContext,
        budget: RoutingBudget,
    ) -> RoutePlan:
        del context
        capability = infer_capability(request, budget)
        available = require_candidates(candidates)
        first = choose_best(available, key=lambda model: efficient_score(model, capability))
        strongest = choose_best(available, key=lambda model: capability_score(model, capability))
        steps = [RouteStep(model=first.id, condition="try_first")]
        if strongest.id != first.id and budget.max_cascade_depth > 1:
            steps.append(RouteStep(model=strongest.id, condition="if_confidence_below_threshold"))
        return RoutePlan(
            mode="cascade",
            steps=steps,
            fallback_models=[],
            confidence=0.82,
            policy_name=self.name,
            policy_version=self.version,
            metadata={"native_router": self.native_router, "capability": capability},
        )


class TwinRouterBenchPolicy(ResearchAdapterPolicy):
    name = "twinrouterbench"
    native_router = "TwinRouterBench agent-step benchmark router"
    supported_modes = ["agent_step"]

    def plan(
        self,
        request: RouterRequest,
        candidates: list[ModelProfile],
        context: RoutingContext,
        budget: RoutingBudget,
    ) -> RoutePlan:
        plan = super().plan(request, candidates, context, RoutingBudget(mode="agent"))
        return plan.model_copy(update={"mode": "agent_step"})


class MTRouterPolicy(TwinRouterBenchPolicy):
    name = "mtrouter"
    native_router = "MTRouter multi-turn history-aware router"


class GMTRouterPolicy(TwinRouterBenchPolicy):
    name = "gmtrouter"
    native_router = "GMTRouter personalized multi-turn router"


class PolicyGuidedStepwisePolicy(TwinRouterBenchPolicy):
    name = "policy-guided-stepwise"
    native_router = "Policy-guided stepwise reasoning router"


class R2RouterPolicy(ResearchAdapterPolicy):
    name = "r2-router"
    native_router = "R2-Router budgeted-output router"

    def plan(
        self,
        request: RouterRequest,
        candidates: list[ModelProfile],
        context: RoutingContext,
        budget: RoutingBudget,
    ) -> RoutePlan:
        plan = super().plan(request, candidates, context, budget)
        return plan.model_copy(
            update={
                "mode": "budgeted_single",
                "metadata": {
                    **plan.metadata,
                    "native_mode": "budgeted_single",
                    "generation": {"max_tokens": 64, "length_instruction": "Answer concisely."},
                }
            }
        )


class OrcaRouterPolicy(GraphRouterPolicy):
    name = "orcarouter"
    native_router = "OrcaRouter offline-online adaptive router"


class BaRPPolicy(GraphRouterPolicy):
    name = "barp"
    native_router = "BaRP bandit-feedback tradeoff router"


class RouterR1Policy(RouteNLPPolicy):
    name = "router-r1"
    native_router = "Router-R1 multi-call planner-executor-judge router"

    def plan(
        self,
        request: RouterRequest,
        candidates: list[ModelProfile],
        context: RoutingContext,
        budget: RoutingBudget,
    ) -> RoutePlan:
        capability = infer_capability(request, budget)
        available = require_candidates(candidates)
        planner = choose_best(available, key=lambda model: efficient_score(model, "reasoning"))
        executor = choose_best(available, key=lambda model: capability_score(model, capability))
        judge = choose_best(available, key=lambda model: capability_score(model, "reasoning"))
        return RoutePlan(
            mode="multi_call",
            steps=[
                RouteStep(model=planner.id, role="planner", max_tokens=64),
                RouteStep(model=executor.id, role="implementation", max_tokens=64),
                RouteStep(model=judge.id, role="judge_merge", max_tokens=64),
            ],
            confidence=0.78,
            policy_name=self.name,
            policy_version=self.version,
            metadata={"native_router": self.native_router, "native_mode": "multi_call"},
        )


class DecoRPolicy(GraphRouterPolicy):
    name = "decor"
    native_router = "DecoR query decomposition and historical matching router"


class LookaheadPolicy(ResearchAdapterPolicy):
    name = "lookahead"
    native_router = "Lookahead output-representation router"


class TRouterPolicy(ResearchAdapterPolicy):
    name = "trouter"
    native_router = "TRouter cold-start task-aware router"


class RCRRouterPolicy(ResearchAdapterPolicy):
    name = "rcr-router"
    native_router = "RCR-Router context-routing router"

    def plan(
        self,
        request: RouterRequest,
        candidates: list[ModelProfile],
        context: RoutingContext,
        budget: RoutingBudget,
    ) -> RoutePlan:
        plan = super().plan(request, candidates, context, budget)
        return plan.model_copy(
            update={
                "mode": "context_routing",
                "metadata": {
                    **plan.metadata,
                    "native_mode": "context_routing",
                    "context_plan": {
                        "max_context_tokens": 12000,
                        "include_memory_ids": [],
                        "context_snippets": self._context_snippets(request),
                    },
                }
            }
        )

    @staticmethod
    def _context_snippets(request: RouterRequest) -> list[str]:
        memories = request.metadata.get("memory")
        if isinstance(memories, list):
            return [str(memory) for memory in memories[:3]]
        return []


class BoundaryRouterPolicy(GraphRouterPolicy):
    name = "boundary-router"
    native_router = "BoundaryRouter direct-vs-agent boundary router"


class BrainbaseTrainedPolicy(HydraPolicy):
    name = "brainbase-trained"
    native_router = "Brainbase-trained router artifact adapter"
