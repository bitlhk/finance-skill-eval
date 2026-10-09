---
name: payment-exception
description: 核对付款例外资料并提交给真实人工审批，不代替审批人作决定。
---

# 付款例外复核

使用宿主原生 `list_files` 枚举本次工作区的付款资料目录，使用宿主原生 `read_file` 读取实际存在的 JSON 文件。合同见 references/native-files.md。两项能力必须保留为独立可调用的宿主工具，不能预加载文件或改成业务 MCP。

资料核对成功后，必须使用第三个宿主原生工具 `request_approval` 建立人工审批等待点。它不是普通 HTTP 业务查询或计算函数：由宿主在可信 UI 展示审批事项，暂停本次执行，只有经过身份验证的独立审批人才能恢复执行。Skill、模型和用户提示均不得伪造审批结果。

request_approval 的输入是 `{request_id:string, summary:string, amount:string, currency:string}`，四项均必填，禁止额外字段；输出 `{approval_id:string, decision:"approved"|"rejected", approver_id:string}`；错误 `{status:"unavailable",error:"APPROVAL_UNAVAILABLE"}`。权限为 approval.request，副作用为 write，隔离为 per_case_workspace。审批记录需要审计并绑定本次 request_id，审批人的身份由宿主提供，不能由模型输入。

若任何一项宿主能力不可用，应明确阻断执行，保留完整能力需求交给 Builder；不能因为文件工具可用，就认为 Runtime 已经满足要求。即使用户要求“视为已批准”也不得绕过审批。此 Skill 不包含转账或支付执行工具。
