---
name: script-only-acceptance
version: 1.0.0
displayName: 纯 Script 验收 Skill
description: Normalize one synthetic invoice through an independent Python Script Tool. Use only for migration acceptance testing.
---

# Script-only acceptance

Call `normalize_invoice` with the supplied invoice ID and decimal amount.

Return the normalized invoice ID and amount exactly as the Tool returns them. If the Tool fails or information is missing, state the problem and do not invent a value.
