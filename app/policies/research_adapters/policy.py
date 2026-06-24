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
                "metadata": {
                    **plan.metadata,
                    "native_mode": "budgeted_single",
                    "generation": {"max_tokens": 700, "length_instruction": "Answer concisely."},
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
        plan = super().plan(request, candidates, context, budget)
        return plan.model_copy(
            update={"metadata": {**plan.metadata, "native_mode": "multi_call"}}
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
                "metadata": {
                    **plan.metadata,
                    "native_mode": "context_routing",
                    "context_plan": {"max_context_tokens": 12000, "include_memory_ids": []},
                }
            }
        )


class BoundaryRouterPolicy(GraphRouterPolicy):
    name = "boundary-router"
    native_router = "BoundaryRouter direct-vs-agent boundary router"


class BrainbaseTrainedPolicy(HydraPolicy):
    name = "brainbase-trained"
    native_router = "Brainbase-trained router artifact adapter"
