---
name: account-balance
description: 查询客户账户余额，并在查询前检查必要信息。用户询问账户余额或可用资金时使用。
---

# 查询账户余额

1. 确认用户已经提供账户编号；缺失时请用户补充，不要猜测。
2. 调用 `get_account_balance`，传入 `account_id`。
3. 成功时返回 Tool 给出的 `currency`、`ledger_balance` 和 `available_balance`。
4. Tool 返回 `ACCOUNT_NOT_FOUND` 时，请用户检查账户编号。
5. Tool 调用失败或超时时，说明当前无法查询，不要编造余额。

不要向用户索取密码、Token 或密钥。
