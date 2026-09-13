"""Independent JSON stdin/stdout Script Tool used by migration tests."""

from decimal import Decimal, InvalidOperation
import json
import sys


input_schema = {
    "type": "object",
    "properties": {
        "invoice_id": {"type": "string"},
        "amount": {"type": "string"},
    },
    "required": ["invoice_id", "amount"],
    "additionalProperties": False,
}


def normalize_invoice(invoice_id: str, amount: str) -> dict[str, str]:
    try:
        normalized = Decimal(amount).quantize(Decimal("0.01"))
    except (InvalidOperation, TypeError) as exc:
        raise ValueError("amount must be a decimal string") from exc
    return {"invoice_id": invoice_id, "amount": f"{normalized:.2f}"}


def main() -> int:
    try:
        result = normalize_invoice(**json.load(sys.stdin))
    except Exception as exc:
        print(json.dumps({"status": "error", "error": str(exc)}), file=sys.stderr)
        return 2
    print(json.dumps(result, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
