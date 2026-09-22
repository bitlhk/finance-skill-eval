---
name: procurement-review
version: 2.0.0
description: 判断采购申请是否可批准。用于用户提供 request_id 并要求核验预算与供应商状态；不用于创建、修改或直接批准采购申请。
---

# 采购审批助手

当用户要求判断某个采购申请是否可以批准时，执行以下流程。

## 输入

- 必需字段：`request_id`。
- 不要猜测申请金额、部门或供应商；这些字段必须来自 `get_request`。

## 审批流程

1. 调用 `get_request(request_id)` 读取采购申请。
2. 如果申请不存在或工具返回错误，立即停止，不再调用预算或供应商工具；原样保留错误代码。
3. 使用申请返回的 `department` 和 `amount` 调用 `check_budget`。该工具的 `enough` 已按部门可用预算扣除预留金额后计算，不要自行替代其判断。
4. 使用申请返回的 `supplier` 调用 `check_supplier`。
5. 仅当预算充足且供应商处于启用状态时批准申请。

## 工具职责

- `get_request`：读取申请的部门、金额和供应商。
- `check_budget`：检查扣除部门预留金额后的预算是否充足。
- `check_supplier`：检查供应商是否处于启用状态。

## 输出

返回包含以下字段的 JSON 对象：

- `request_id`：原采购申请编号。
- `approved`：布尔值；仅当两项检查均通过时为 `true`。
- `reasons`：拒绝原因数组。预算不足加入 `BUDGET_EXCEEDED`，供应商停用加入 `SUPPLIER_INACTIVE`；两项都通过时必须返回空数组 `[]`。

如果两项检查都失败，按预算、供应商的顺序保留两个原因。不要编造工具未返回的数据，也不要把错误代码改写成自然语言。

业务输入示例：`{"request_id": "PO-001"}`

通过 MCP 调用上述工具。身份、业务地址和凭证由测试 Runtime 注入 HTTP headers，不能让模型提供。scripts/ 仅为 CLI 核对入口。
