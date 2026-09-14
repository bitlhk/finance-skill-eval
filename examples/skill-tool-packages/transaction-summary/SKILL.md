---
name: transaction-summary
description: 汇总 CSV 交易明细中的收入、支出和净额。用户要求统计交易流水时使用。
compatibility: Requires Python 3.11+ and uv.
---

# 汇总交易明细

1. 确认用户已经提供 CSV 文件、金额列名和币种。
2. 从 Skill 根目录运行 `uv run --script scripts/summarize_transactions.py`，通过标准输入传入包含 `file_path`、`amount_column` 和 `currency` 的 JSON 对象。
3. 使用脚本返回的 `transaction_count`、`income_total`、`expense_total` 和 `net_total`，不要自行重算金额。
4. 脚本返回 `FILE_NOT_FOUND`、`COLUMN_NOT_FOUND` 或 `INVALID_AMOUNT` 时，说明对应问题，不要猜测或修改原始数据。
5. 脚本失败或超时时，说明本次汇总未完成，不要给出估算结果。

不要修改或覆盖用户提供的原始文件。
