在工作区读取报销单 JSON；按 assets/rules.json 检查餐饮上限 150.00，礼品不允许报销。返回总金额、违规行号和合规结论。文件缺失时返回 CLAIM_NOT_FOUND，不编造数据。

业务输入示例：{"claim_id": "EXP-001"}
