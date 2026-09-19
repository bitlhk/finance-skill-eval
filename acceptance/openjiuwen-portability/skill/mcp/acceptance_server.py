"""Read-only MCP Tool backed by a fixed synthetic order snapshot."""

from copy import deepcopy
from fastmcp import FastMCP


mcp = FastMCP("OpenJiuwen portability acceptance MCP")

input_schema = {
    "type": "object",
    "properties": {"order_id": {"type": "string"}},
    "required": ["order_id"],
    "additionalProperties": False
}

output_schema = {
    "type": "object",
    "properties": {
        "order_id": {"type": "string"},
        "currency": {"const": "CNY"},
        "subtotal": {"type": "string"},
        "tax_rate": {"type": "string"},
        "approved": {"type": "boolean"}
    },
    "required": ["order_id", "currency", "subtotal", "tax_rate", "approved"]
}

ORDERS = {
    "ORDER-001": {
        "order_id": "ORDER-001",
        "currency": "CNY",
        "subtotal": "100.00",
        "tax_rate": "0.06",
        "approved": True,
        "synthetic": True,
        "snapshot": "acceptance-v1"
    },
    "ORDER-002": {
        "order_id": "ORDER-002",
        "currency": "CNY",
        "subtotal": "250.00",
        "tax_rate": "0.13",
        "approved": True,
        "synthetic": True,
        "snapshot": "acceptance-v1"
    },
    "ORDER-REJECTED": {
        "order_id": "ORDER-REJECTED",
        "currency": "CNY",
        "subtotal": "80.00",
        "tax_rate": "0.06",
        "approved": False,
        "synthetic": True,
        "snapshot": "acceptance-v1"
    },
    "ORDER-INVALID": {
        "order_id": "ORDER-INVALID",
        "currency": "CNY",
        "subtotal": "invalid",
        "tax_rate": "0.06",
        "approved": True,
        "synthetic": True,
        "snapshot": "acceptance-v1"
    }
}


@mcp.tool(annotations={"readOnlyHint": True})
def get_acceptance_order(order_id: str) -> dict:
    """Return one approved synthetic order used only by the acceptance suite."""
    order = ORDERS.get(order_id)
    if order is None:
        raise ValueError("Order is unavailable in the synthetic acceptance snapshot")
    return deepcopy(order)


if __name__ == "__main__":
    mcp.run(transport="streamable-http", host="127.0.0.1", port=56364)
