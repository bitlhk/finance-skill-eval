# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///

from decimal import Decimal, InvalidOperation
from pathlib import Path
import csv
import json
import sys


def summarize(file_path: str, amount_column: str, currency: str) -> dict:
    path = Path(file_path)
    if not path.is_file():
        raise ValueError("FILE_NOT_FOUND")

    income = Decimal("0")
    expense = Decimal("0")
    count = 0
    with path.open("r", encoding="utf-8-sig", newline="") as source:
        reader = csv.DictReader(source)
        if amount_column not in (reader.fieldnames or []):
            raise ValueError("COLUMN_NOT_FOUND")
        for row_number, row in enumerate(reader, start=2):
            try:
                amount = Decimal(row[amount_column])
            except (InvalidOperation, TypeError):
                raise ValueError(f"INVALID_AMOUNT:{row_number}")
            count += 1
            if amount >= 0:
                income += amount
            else:
                expense += -amount

    return {
        "status": "ok",
        "currency": currency,
        "transaction_count": count,
        "income_total": f"{income:.2f}",
        "expense_total": f"{expense:.2f}",
        "net_total": f"{income - expense:.2f}",
    }


def main() -> int:
    try:
        request = json.load(sys.stdin)
        result = summarize(
            file_path=request["file_path"],
            amount_column=request["amount_column"],
            currency=request["currency"],
        )
    except Exception as error:
        print(json.dumps({"status": "error", "error": str(error)}), file=sys.stderr)
        return 2

    print(json.dumps(result, ensure_ascii=False, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
