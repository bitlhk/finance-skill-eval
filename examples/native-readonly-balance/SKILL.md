---
name: native-readonly-balance
displayName: 账户余额核验
version: 1.0.2
description: 使用已准入的只读余额工具及案例文件工具，核对金额、币种、来源和数据缺口。
allowed-tools:
  - account_balance_query
  - read_case_file
---

# 账户余额核验

## 环境边界

本方法只使用目标环境已经注册的两个工具，不携带工具实现、脚本、MCP 服务或客户端凭据。
account_balance_query 在本方法中使用输入 {}；这不是工具的完整参数合同。工具允许可选的 accountId，完整输入声明如下（引用 account-balance-readonly 0.1.0）：

```json
{"type":"object","additionalProperties":false,"properties":{"accountId":{"type":"string","pattern":"^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$"}}}
```

可信宿主已绑定测试客户，调用方不提供客户身份、账户凭证或权限参数。不提供 accountId 时由已有 Provider 返回当前获授权范围的账户；不能自行编造账户编号。用户没有指定账户时必须省略 accountId，使用 {}；不得传 accountId 为空字符串或 null，这两者不符合输入合同。
授权仍由宿主与银行每次核验，工具返回拒绝时不能继续披露旧数据。
read_case_file 是已注册工具，输入为 {"path":"case.txt"}，只能读取当前案例工作区。
两个工具的实现、身份绑定及文件挂载均由受管环境提供，不要求上传者设置环境变量或安装依赖。

## 执行方法

用户要求查询余额时，先调用 read_case_file 读取 case.txt，随后调用 account_balance_query，输入 {}。
按实际工具结果说明金额、币种、数据来源；同时原样报告案例文件里的标记。
工具结果缺失、拒绝或失败时，明确未完成项，不把缺数写成零，不编造金额。
本方法不查询财富总资产、不评估投资建议、不办理转账。
仅询问功能或仅要求核验指定文件时，按问题回答，不额外调用余额工具。

## 验证范围

本样例仅用于合成银行。固定案例核对工具、金额、币种、案例标记及运行版本。
自动化规则不等于金融专业质量已经人工确认。
