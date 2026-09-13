"""Deliberately Runtime-bound tools used as the migration source fixture."""

from decimal import Decimal, ROUND_HALF_UP

from agentscope.tool import ToolResponse


ORDERS = {
    "ORDER-001": {"order_id": "ORDER-001", "currency": "CNY", "subtotal": "100.00", "tax_rate": "0.06", "approved": True},
    "ORDER-002": {"order_id": "ORDER-002", "currency": "CNY", "subtotal": "250.00", "tax_rate": "0.13", "approved": True},
}


def get_acceptance_order(order_id: str) -> ToolResponse:
    order = ORDERS.get(order_id)
    if order is None:
        return ToolResponse(content={"status": "unavailable", "order_id": order_id})
    return ToolResponse(content={"status": "ok", **order})


def calculate_acceptance_total(subtotal: str, tax_rate: str) -> ToolResponse:
    amount = Decimal(subtotal)
    rate = Decimal(tax_rate)
    tax = (amount * rate).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
    return ToolResponse(content={
        "status": "ok",
        "subtotal": f"{amount:.2f}",
        "tax_rate": f"{rate:.2f}",
        "tax_amount": f"{tax:.2f}",
        "total": f"{amount + tax:.2f}",
    })


def register(toolkit) -> None:
    """This registration API is the intentional Runtime coupling under test."""
    toolkit.register_tool_function(tool_func=get_acceptance_order)
    toolkit.register_tool_function(tool_func=calculate_acceptance_total)
