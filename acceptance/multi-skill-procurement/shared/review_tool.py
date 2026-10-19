"""Business rules. Input budget is cents; input purchase and output shortfall are yuan."""
from decimal import Decimal


def review_purchase(budget, amount_yuan):
    if budget.get("status") != "ok":
        return {"decision": "UNAVAILABLE", "reason": "Budget not found"}
    amount = Decimal(str(amount_yuan))
    if not amount.is_finite() or amount <= 0 or amount * 100 != (amount * 100).to_integral_value():
        raise ValueError("Amount must be positive and have at most two decimal places")
    available = Decimal(budget["available_cents"]) / 100
    shortfall = max(amount - available, Decimal("0"))
    return {
        "decision": "REJECT" if shortfall else "ALLOW",
        "cost_center": budget["cost_center"],
        "currency": budget["currency"],
        "amount_yuan": format(amount, ".2f"),
        "available_yuan": format(available, ".2f"),
        "shortfall_yuan": format(shortfall, ".2f"),
    }
