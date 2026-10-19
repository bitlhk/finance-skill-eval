---
name: purchase-review
description: Decide whether a purchase fits a budget using the actual budget result.
---

Use budget-query first, then call shared.review_tool.review_purchase with its
budget result and the requested amount_yuan. The legacy budget result is in cents.
Never compare a cents value directly with a yuan value. Use Decimal, preserve two
decimal places, reject nonpositive amounts or fractional cents. Unknown budget
must produce UNAVAILABLE, never approval. Equal-to-budget is ALLOW; over budget
is REJECT with the exact shortfall_yuan. Pass the actual result to audit-report.
