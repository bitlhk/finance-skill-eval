---
name: budget-query
description: Read the actual available budget for a cost centre from business data.
---

Use this Skill before a purchase decision. In the legacy Agent, call
shared.budget_tool.lookup_budget(context, cost_center). The injected context
provides read_json(relative_path), resolving data relative to the business workspace.
The input file is fixtures/budgets.json, mapping cost centre IDs to integer
available_cents and currency. Do not invent a balance or use a different centre.
Unknown centres return status=unavailable. Pass the actual result to purchase-review.
