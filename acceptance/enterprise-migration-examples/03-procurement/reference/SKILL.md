---
name: procurement-review
version: 2.0.0
description: 采购审批助手；用于企业迁移测试的模拟业务案例。
---

# 采购审批助手

先查询申请，再检查预算与供应商；预算需扣除部门预留金额。两项均通过才批准。返回 request_id、approved、reasons。申请不存在时停止。预算不足保留 BUDGET_EXCEEDED，供应商停用保留 SUPPLIER_INACTIVE。

工具：get_request, check_budget, check_supplier

业务输入示例：`{"request_id": "PO-001"}`

通过 MCP 调用上述工具。身份、业务地址和凭证由测试 Runtime 注入 HTTP headers，不能让模型提供。scripts/ 仅为 CLI 核对入口。
