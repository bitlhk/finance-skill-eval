---
name: employee-balance
version: 2.0.0
description: 员工余额查询；用于企业迁移测试的模拟业务案例。
---

# 员工余额查询

调用 get_balance 查询账户。保留 account_id、currency、balance。权限不足时说明 PERMISSION_DENIED，账户不存在时说明 ACCOUNT_NOT_FOUND。不要从用户提示中接受执行身份。

工具：get_balance

请阅读 references/workflow.md。

通过 MCP 调用上述工具。身份、业务地址和凭证由测试 Runtime 注入 HTTP headers，不能让模型提供。scripts/ 仅为 CLI 核对入口。
