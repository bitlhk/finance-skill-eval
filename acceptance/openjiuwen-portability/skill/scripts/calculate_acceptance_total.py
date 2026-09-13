"""Deterministic JSON stdin/stdout Script Tool for acceptance testing."""

from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
import json
import sys


input_schema = {
    "type": "object",
    "properties": {
        "subtotal": {"type": "string", "pattern": "^[0-9]+\\.[0-9]{2}$"},
        "tax_rate": {"type": "string", "pattern": "^0\\.[0-9]{2}$"}
    },
    "required": ["subtotal", "tax_rate"],
    "additionalProperties": False
}

output_schema = {
    "type": "object",
    "properties": {
        "status": {"const": "ok"},
        "subtotal": {"type": "string"},
        "tax_rate": {"type": "string"},
        "tax_amount": {"type": "string"},
        "total": {"type": "string"}
    },
    "required": ["status", "subtotal", "tax_rate", "tax_amount", "total"]
}

CENT = Decimal("0.01")


def calculate_acceptance_total(subtotal: str, tax_rate: str) -> dict[str, str]:
    try:
        amount = Decimal(subtotal)
        rate = Decimal(tax_rate)
    except (InvalidOperation, TypeError) as exc:
        raise ValueError("subtotal and tax_rate must be decimal strings") from exc
    if amount < 0 or rate < 0 or rate > 1:
        raise ValueError("subtotal and tax_rate are outside the acceptance range")
    tax = (amount * rate).quantize(CENT, rounding=ROUND_HALF_UP)
    total = (amount + tax).quantize(CENT, rounding=ROUND_HALF_UP)
    return {
        "status": "ok",
        "subtotal": f"{amount.quantize(CENT):.2f}",
        "tax_rate": f"{rate:.2f}",
        "tax_amount": f"{tax:.2f}",
        "total": f"{total:.2f}",
    }


def main() -> int:
    try:
        request = json.load(sys.stdin)
        result = calculate_acceptance_total(**request)
    except Exception as exc:
        print(json.dumps({"status": "error", "error": str(exc)}), file=sys.stderr)
        return 2
    print(json.dumps(result, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
