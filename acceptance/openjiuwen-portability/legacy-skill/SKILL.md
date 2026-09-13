---
name: openjiuwen-portability-acceptance
version: 1.0.0
displayName: 旧 Runtime 耦合验收 Skill
description: Validate synthetic order totals through tools registered directly in a legacy Agent Runtime. Use only as the migration platform's deterministic source fixture.
---

# Legacy Runtime-bound acceptance Skill

Use this Skill only with synthetic acceptance orders.

1. Read `references/acceptance-policy.md`.
2. Call `get_acceptance_order` with the exact order ID.
3. If the order is unavailable or unapproved, stop and do not invent an amount.
4. Call `calculate_acceptance_total` with the returned subtotal and tax rate.
5. Return the order ID, currency, subtotal, tax amount, and total.

If a Tool fails or required information is missing, state the problem clearly.
