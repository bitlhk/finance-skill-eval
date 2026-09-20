---
name: expense-compliance
version: 1.0.0
description: 报销合规检查；用于企业迁移测试的模拟业务案例。
---

# 报销合规检查

在工作区读取报销单 JSON；按 assets/rules.json 检查餐饮上限 150.00，礼品不允许报销。返回总金额、违规行号和合规结论。文件缺失时返回 CLAIM_NOT_FOUND，不编造数据。

工具：check_expense

请阅读 references/workflow.md。
