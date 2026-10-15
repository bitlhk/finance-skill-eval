"""Reusable business logic. State belongs to this service process, not the agent."""
import json
import os
import uuid
from decimal import Decimal
from urllib.error import HTTPError
from urllib.parse import quote
from urllib.request import urlopen

_snapshots = {}


def query_receivables(customer_id: str) -> dict:
    """Query receivables; retain full IT response and return a small selection preview."""
    try:
        with urlopen(os.environ["LEDGER_SERVICE_URL"].rstrip("/") + "/ledger/" + quote(customer_id, safe=""), timeout=10) as response:
            ledger = json.load(response)
    except HTTPError as error:
        if error.code == 404:
            return {"status": "not_found", "customer_id": customer_id}
        raise
    ref = uuid.uuid4().hex
    _snapshots[ref] = ledger
    return {"status": "ok", "snapshot_ref": ref, "customer_id": customer_id,
            "record_count": len(ledger["items"]),
            "invoice_preview": [{"invoice_id": row["invoice_id"], "outstanding": row["outstanding"]}
                                for row in ledger["items"][:10]],
            "preview_complete": len(ledger["items"]) <= 10}


def summarize_receivables(snapshot_ref: str, invoice_ids: list[str] | None = None) -> dict:
    """Consume the exact query snapshot, optionally only the user's selected invoices."""
    ledger = _snapshots.get(snapshot_ref)
    if ledger is None:
        return {"status": "unavailable", "error": "RECEIVABLES_SNAPSHOT_INVALID"}
    rows = ledger["items"]
    if invoice_ids is not None:
        indexed = {row["invoice_id"]: row for row in rows}
        if not invoice_ids or len(set(invoice_ids)) != len(invoice_ids) or any(key not in indexed for key in invoice_ids):
            return {"status": "unavailable", "error": "INVOICE_SELECTION_INVALID"}
        rows = [indexed[key] for key in invoice_ids]
    total = sum((Decimal(row["outstanding"]) for row in rows), Decimal("0"))
    return {"status": "ok", "customer_id": ledger["customer_id"], "currency": ledger["currency"],
            "record_count": len(rows), "outstanding": format(total, ".2f")}
