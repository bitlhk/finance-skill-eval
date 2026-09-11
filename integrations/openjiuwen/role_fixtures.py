"""Synthetic read-only provider, never live Wind, underwriting or approval data."""
from copy import deepcopy
import json
from pathlib import Path

SOURCE = {"source": "finance-eval-role-fixtures", "snapshotVersion": "roles-demo-v1", "asOf": "2026-09-05", "synthetic": True}
DATA = json.loads(Path(__file__).with_name("role-fixtures.json").read_text())


def insurance_customer(customer_id):
    if customer_id != "I001":
        raise ValueError("Unknown synthetic insurance customer")
    return deepcopy(DATA["insuranceCustomer"])


def register_tools(mcp):
    for name, spec in DATA["tools"].items():
        def factory(definition):
            def query(reference: str = "") -> dict:
                ref = reference or definition["defaultRef"]
                if ref not in definition["records"]:
                    raise ValueError("Reference is outside the fixed synthetic snapshot")
                return {**SOURCE, "reference": ref, **deepcopy(definition["records"][ref])}
            return query
        mcp.tool(name=name, description=spec["description"], annotations={"readOnlyHint": True})(factory(spec))
