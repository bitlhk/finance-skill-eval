# 四份企业 Skill 案例验证（2026-09-17 至 2026-09-18）

结论：案例本身及参考实现的基础核验通过；四份真实迁移页面验证本轮均停在诊断阶段，不能判定端到端通过。没有修改产品业务源码。

## 基础核验通过

- verify_examples.py：12 个原版与手工迁移参考实现的业务场景，结果、金额精度、拒绝原因及业务调用链一致；实际 SDK provider 上下文映射通过。
- verify_formats.mjs：4 份测试集、3 份 Runtime 配置符合当前平台 schema。
- verify_mcp_examples.py：项目锁定环境真实启动参考 MCP 服务；9 个场景、15 次调用通过，SDK provider、隐藏执行上下文以及 Tool schema 不含鉴权入参的检查通过。

这些结果只验证既有参考实现，不作为真实 A4 迁移产物成功的证据。

## 页面真实 A2 验证

使用 Edge 无头浏览器、真实平台服务、deepseek-v4-flash A2。由页面上传原 source.zip，保留原始 Agent 输出、完整浏览器 trace 与失败截图。

| 案例 | 本轮结果 | 已核实阻塞 |
|---|---|---|
| 01-expense | 诊断未闭环 | 模型 resolvedPaths 中的工作区绝对路径指向已有 assets/rules.json，平台未映射回包内相对路径，规则文件被判为未确认；另有 1 个多行引用仅换行差异。 |
| 02-balance | PARTIAL | 3 个多行引用仅换行差异，重复引用使平台记录 9 条拒绝；service_url 作为 Runtime INJECT 依赖但 binding=null，注入契约 UNKNOWN。 |
| 03-procurement | UNAVAILABLE | 3 条边 condition=null，而平台 schema 为可省略的 string，整份图被拒绝；49 个源码引用均可匹配，不是缺源码。 |
| 04-refund | 重跑后 UNAVAILABLE | 初轮 Agent 无结果并超时；重新执行真实 A2 返回 PRODUCED，但 2 条 condition=null 导致整份图被拒绝；27 个引用均可匹配。 |

报销首轮测试脚本还错误处理了非阻塞的标准库依赖，已修正脚本并以相同原工程、该轮真实 A2 结果复测，确认真正阻塞为包内规则文件识别。复测没有修饰模型输出或伪造诊断。退款首次长时间等待后的失败不作为业务逻辑缺陷，重跑确认了具体图校验问题。

采购与退款在图校验失败后页面显示缺少链路，同时依赖项为空，用户无法从页面看见具体失败字段，需要改进错误展示。

本轮尚未进入 A4、逐工具试运行、迁移候选 Runtime 评估及候选导出，不宣称这些阶段已通过或已确认失败。

## 证据位置

- 汇总：reports/enterprise-four-verification-20260918.json
- 首轮：reports/enterprise-four-page-2026-09-17T15-28-44-432Z/
- 报销脚本修正后复测：reports/enterprise-four-page-2026-09-17T15-36-42-587Z/
- 退款真实 A2 重跑：reports/enterprise-four-page-2026-09-17T18-08-10-028Z/
- diagnosis-audit.json：逐条校验当前依赖图 schema、引用换行差异、resolvedPaths 对应源文件。审计读取的是原始 ZIP 和真实输出，不改变输出。

## 后续修复与复验顺序

1. 将工作区绝对路径安全映射为资产相对路径，匹配时统一 CRLF/LF 并保留真实引用来源。
2. 无条件边统一省略 condition 或接受 null；A2 结构错误应有可定位的错误与受限修复，避免仅返回整图不可用。
3. 明确 service_url 等 Runtime 配置的注入绑定；标准库不要提示上传 SDK；图无效时展示具体错误。
4. 重跑四份真实 A2，诊断闭环后再依次验证真实 A4、SDK/配置补充、生成工具、三个业务分支及原服务对比。
