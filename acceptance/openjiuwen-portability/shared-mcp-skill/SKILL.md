---
name: shared-mcp-acceptance
version: 1.0.0
displayName: 共享 MCP 验收 Skill
description: Read a synthetic customer and its account through two Tools provided by one MCP service. Use only for migration acceptance testing.
---

# Shared MCP acceptance

1. Call `get_acceptance_customer` with the supplied customer ID.
2. Call `get_acceptance_account` with the account ID returned by the first Tool.
3. Return only the values supplied by the Tools.

If either Tool fails, information is missing, or access is rejected, state the problem and stop.
