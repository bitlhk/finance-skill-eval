先查询申请，再检查预算与供应商；预算需扣除部门预留金额。两项均通过才批准。返回 request_id、approved、reasons。申请不存在时停止。预算不足保留 BUDGET_EXCEEDED，供应商停用保留 SUPPLIER_INACTIVE。

业务输入示例：{"request_id": "PO-001"}
