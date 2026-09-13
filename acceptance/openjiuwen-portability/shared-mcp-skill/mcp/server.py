"""Two read-only Tools intentionally provided by one MCP service."""

from fastmcp import FastMCP


mcp = FastMCP("Shared MCP acceptance")

input_schema = {
    "type": "object",
    "properties": {"id": {"type": "string"}},
    "required": ["id"],
    "additionalProperties": False,
}


@mcp.tool(annotations={"readOnlyHint": True})
def get_acceptance_customer(customer_id: str) -> dict:
    """Return a fixed synthetic customer."""
    if customer_id != "CUSTOMER-001":
        raise ValueError("Customer is unavailable")
    return {"customer_id": customer_id, "account_id": "ACCOUNT-001"}


@mcp.tool(annotations={"readOnlyHint": True})
def get_acceptance_account(account_id: str) -> dict:
    """Return a fixed synthetic account from the same service."""
    if account_id != "ACCOUNT-001":
        raise ValueError("Account is unavailable")
    return {"account_id": account_id, "status": "ACTIVE", "currency": "CNY"}


if __name__ == "__main__":
    mcp.run(transport="streamable-http", host="127.0.0.1", port=56365)
