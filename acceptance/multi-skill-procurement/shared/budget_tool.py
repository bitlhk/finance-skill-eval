"""Legacy context-injected tool with a cents-denominated result."""


def lookup_budget(context, cost_center):
    row = context.read_json("fixtures/budgets.json").get(cost_center)
    if row is None:
        return {"status": "unavailable", "cost_center": cost_center}
    return {
        "status": "ok",
        "cost_center": cost_center,
        "currency": row["currency"],
        "available_cents": row["available_cents"],
    }
