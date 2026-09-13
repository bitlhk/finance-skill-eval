---
name: openjiuwen-portability-acceptance
version: 2.0.0
displayName: 迁移完成验收 Skill
description: Validate that an Agent Runtime can load one Skill and coordinate a portable MCP Tool with a portable Script Tool. Use only for deterministic platform acceptance tests.
---

# OpenJiuwen portability acceptance

Use this Skill only with synthetic acceptance orders supplied by the acceptance environment.

## Required workflow

1. Read the packaged acceptance policy in **references/acceptance-policy.md** before calculating an order.
2. Call `get_acceptance_order` with the exact order ID supplied by the user.
3. If the Tool reports that the order is unavailable or unapproved, stop. State that the total cannot be calculated and do not invent any amount.
4. For an approved order, call `calculate_acceptance_total` with the returned **subtotal** and **tax_rate** values unchanged.
5. If the calculation Tool fails, state that the total could not be calculated. Do not repair, guess, or calculate the value yourself.
6. Return the order ID, currency, subtotal, tax amount, and total exactly as returned by the Tools.

## Result format

For a successful calculation, include the marker **ACCEPTANCE_RESULT** and these five labeled values:

- **order_id**
- **currency**
- **subtotal**
- **tax_amount**
- **total**

Do not perform the arithmetic yourself. Do not convert currencies or round values outside `calculate_acceptance_total`.
