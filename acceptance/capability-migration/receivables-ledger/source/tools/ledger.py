"""Reusable business logic. State belongs to this service process, not the agent."""
import json
import os
import uuid
from decimal import Decimal
from urllib.error import HTTPError
from urllib.parse import quote
from urllib.request import urlopen

_ledgers = {}


def open_ledger(customer_id: str) -> dict:
    """Load business details; expose only an opaque reference and count."""
    try:
        with urlopen(os.environ["LEDGER_SERVICE_URL"].rstrip("/") + "/ledger/" + quote(customer_id, safe=""), timeout=10) as response:
            ledger = json.load(response)
    except HTTPError as error:
        if error.code == 404:
            return {"status": "not_found", "customer_id": customer_id}
        raise
    ref = uuid.uuid4().hex
    _ledgers[ref] = ledger
    return {"status": "ok", "ledger_ref": ref, "customer_id": customer_id, "record_count": len(ledger["items"])}


def summarize_ledger(ledger_ref: str) -> dict:
    """Aggregate the exact server-side snapshot referenced by a prior call."""
    ledger = _ledgers.get(ledger_ref)
    if ledger is None:
        return {"status": "unavailable", "error": "LEDGER_REFERENCE_INVALID"}
    total = sum((Decimal(row["outstanding"]) for row in ledger["items"]), Decimal("0"))
    return {"status": "ok", "customer_id": ledger["customer_id"], "currency": ledger["currency"],
            "record_count": len(ledger["items"]), "outstanding": format(total, ".2f")}


def close_ledger(ledger_ref: str) -> dict:
    """Release the snapshot immediately; repeat use must fail closed."""
    if _ledgers.pop(ledger_ref, None) is None:
        return {"status": "unavailable", "error": "LEDGER_REFERENCE_INVALID"}
    return {"status": "closed"}
