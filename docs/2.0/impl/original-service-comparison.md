# 原服务对比

测试页先选择“提供测试集和目标”或“接入原服务做对比”。目标评估仅执行一次候选；原服务对比每条任务分别调用原服务和候选，再由独立模型判断相关业务结果是否一致。有明确验收要求时同时检查要求；原服务回答不视为权威真值。

首版接入 HTTP POST：JSON 请求模板支持字符串字段中的 `{{input}}`、`{{caseId}}`，保留其他字段、数组与嵌套结构。响应支持 JSON 或纯文本；JSON 可用 `/data/answer` 这样的 JSON Pointer 选择回答字段，留空使用完整响应。无需原服务适配平台 Runtime 协议。

调用原服务的请求头单独配置名称、环境变量和可选前缀。平台服务进程在每次调用时读取环境变量；配置和运行记录只保留变量名，不保存实际凭证。凭证不进入测试集、候选或评估提示词；回显的已知凭证会脱敏。候选的业务上下文和 Auth Provider 继续使用现有测试 Runtime 配置，两者调用的是不同服务。

`RunConfiguration.evaluationMode=service_comparison`，迁移计划 `pair=SC`。左侧绑定源资产和原服务配置，右侧绑定候选资产及 OpenJiuwen Runtime。源资产关联由用户声明，不伪装为原 Runtime 已加载或已证明版本相同。左侧证据 `runtimeIdentityVerified=false`，记录 `metadata.baselineService` 的配置摘要、源关联摘要和响应摘要；右侧继续验证实际加载的候选摘要。

原服务执行完成记为 `originalBaseline=CAPTURED`，并非 Runtime 等价性证明。配置摘要纳入对比指纹；候选变化后旧基线不成为当前候选的有效验证。原服务失败、响应字段缺失或任一侧执行失败，不进行效果对比或验收通过。HTTP 失败仅保存状态码，不保存失败响应正文；响应限制为 2 MB，支持超时和任务取消，不跟随重定向。

两种方式均可导入测试集或 AI 生成。目标评估格式是 `{name,cases:[{id,input,criteria}]}`，criteria 必填。原服务模式导入时增加 `mode:service_comparison`，criteria 可选；省略时比较原服务关键事实、结果和拒绝条件。这类题集标记 comparisonOnly，不能用于缺少原服务的独立目标评估。AI 生成仍基于冻结的原始 Skill 和诊断，不依据候选出题；生成后可编辑并导入为新的冻结题集，不覆盖原题集。

对比模型返回每项 PASS、FAIL 或 INDETERMINATE，以及分别来自两侧回答的逐字引用。平台校验完整覆盖、索引唯一、引用真实性；PASS 必须有两侧证据。任一项 FAIL 则整体 FAIL，任一项无法判定且无失败则整体 INDETERMINATE。页面和 HTML 报告展示双侧回答及判定依据，不使用左右胜负分数。

自动测试：`tests/original-service-comparison.test.ts`、`tests/migration-service-comparison-workflow.test.ts`。对比评测只接受已经完成迁移和技术验证的候选；检测到 Runtime Harness 改造需求时，在诊断阶段停止，不会通过候选插件绕过 Runtime Builder。生产企业身份系统和远程协议不在本地受控验收的证明范围内。
