---
name: refund-eligibility
version: 2.0.0
description: 退款资格判断；用于企业迁移测试的模拟业务案例。
---

# 退款资格判断

查询订单后读取退款政策，判断资格。将分转换为元，扣除已退款金额，保持两位小数。发货状态返回 STATUS_NOT_REFUNDABLE；订单缺失返回 ORDER_NOT_FOUND，不继续查询政策。

工具：refund_eligibility

业务输入示例：`{"order_id": "RF-001"}`

通过 MCP 调用上述工具。身份、业务地址和凭证由测试 Runtime 注入 HTTP headers，不能让模型提供。scripts/ 仅为 CLI 核对入口。
