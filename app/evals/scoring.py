from app.protocol.model_profile import ModelProfile


def estimate_model_cost_usd(model: ModelProfile) -> float:
    input_cost = model.cost.get("input_per_million", 0)
    output_cost = model.cost.get("output_per_million", 0)
    if not isinstance(input_cost, int | float) or not isinstance(output_cost, int | float):
        return 0.0
    return float(input_cost + output_cost) / 1_000_000
