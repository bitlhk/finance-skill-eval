# Runtime 公共接入合同

自定义 Runtime、Builder 交付和完整 Agent 工程准备使用同一 Launcher。沿用 capabilities、创建实例、实例查询、execute 和 cleanup，不增加采集或查询接口，不要求 OTLP、公共收集器或反向连接。

## 职责与接入

- 自定义 Runtime：提供方将现有框架回调、会话或事件适配为以下格式。
- Builder：构建需求要求 processEvidence，交付的 Launcher 声明并实际提供该能力；复用已有采集和授权投影。
- 完整工程：准备 Agent 阅读源码，在 candidate 副本适配现有入口和采集。不重建 Agent、不改变业务逻辑。invoke 只有答案时，使用回调/上下文采集，或内部消费流后汇总，不从答案推造过程。

现有接口、身份和摘要校验继续有效。字段的可执行定义在 src/shared/contracts/runtime-launcher.ts、runtime-skills.ts、runtime-protocol-versions.ts 和 src/contracts.ts。executeEndpoint 使用实例返回的地址。执行证据回显 runId/caseId/side，实际 output/status/modelId/elapsedMs/error/streamCompleted/runtimeIdentityVerified；实例 configurationDigest、Skill/工程 contentDigest 必须匹配。完整工程使用 executionMode=agent_project，返回 metadata.projectExecution=true。

新接入 capabilities 声明 features.processEvidence=true。其他 projectExecution、multiTurn、caseStateLifecycle、artifactEvidence 能力仍按实际支持范围声明。过程能力声明不等于每次采集完整。

## 统一中间过程

现有 execute 返回的 evidence.metadata.process 必填，类型定义在 src/shared/contracts/runtime-process.ts。非流式随最终 JSON 返回；SSE 保留现有进度事件，最终 {"evidence": ...} 携带同一过程列表。中间摘要不替代最终记录，不重复累计两路数据。

下面是 process 字段内容，不是整个响应：

```json
{
  "schemaVersion": "finance.runtime-process.v1",
  "status": "COMPLETE",
  "scopes": ["tools"],
  "records": [{
    "id": "record-1", "kind": "tool", "callId": "call-1",
    "name": "query_order", "status": "completed",
    "input": {"order_id": "123"}, "output": {"status": "paid"}, "durationMs": 25
  }]
}
```

| 字段 | 约定 |
| --- | --- |
| status | COMPLETE / PARTIAL / UNAVAILABLE：采集状态，不是业务裁决 |
| scopes | messages / models / tools / events：实际采集范围 |
| reason | PARTIAL、UNAVAILABLE 必填，说明缺失、字段省略或截断原因 |
| records | 按观察顺序排列，最多 512 条；整个 process 不超过 128 KiB |
| id | 本次执行内唯一记录 ID |
| kind | message / model / tool / event |
| callId、name、status | tool/model 必填；每次调用一条终态记录，status 为 completed/failed/incomplete；无原生 ID 时由执行侧在调用开始时生成 |
| role | message 必填，user/assistant/system |
| input、output | 可选，任意 JSON 值，保留获授权业务结构；缺失不能补造 |
| timestamp、durationMs、error | 可选，ISO 8601 时间、非负毫秒、错误信息 |
| data | 可选，脱敏的原生事件/扩展数据；未知事件用 kind=event |

COMPLETE 仅表示声明范围内采集完成，不证明远程业务服务内部全链路可见。只有确实观测了整个工具边界，才可用 scopes=["tools"]、records=[] 表达没有调用。调用未结束保留 incomplete，整体 PARTIAL。业务失败不必意味着采集失败。

无法获取过程时仍返回合法结构：status=UNAVAILABLE、scopes=[]、records=[]、reason 说明原因。可继续结果评测；依赖缺失过程的 Judge 必须给出无法验证。

整个执行证据仍最多 256 KiB。超限保留有界前缀并标记 PARTIAL，不返回超限数据。凭证、鉴权头和隐藏推理不得进入过程，复用原脱敏/授权规则。省略字段与显式 JSON null 不同。

## 共用评测与兼容

平台保存 process，并以 /process 暴露给既有规则、脚本、模型 Judge、诊断和 Review。工具记录投影到已有 toolCalls/toolEvidence，不要求调用方再构建第二份详细轨迹。若同时提供旧字段，应保持一致；不覆盖历史较丰富的工具凭证。

旧 telemetry、externalTelemetry、toolEvidence 和历史报告仍可读取；OTLP 不是新接入要求，也不需要接收地址。旧记录缺 process 时不补造历史过程。

## 验证与交付

pnpm runtime:check --capabilities capabilities.json（或 --url <launcher-base-url>）默认检查 processEvidence，令牌由 RUNTIME_CHECK_TOKEN 环境变量提供。加 --evidence evidence.json --run-id <id> --case-id <id> --side right 检查实际响应，期望身份来自请求。

合同兼容、采集完整与业务验收分开。PARTIAL/UNAVAILABLE 是合法返回，不代表过程验收通过。

工程准备报告沿用 summary、skills、entrypoints、missing、baselinePlan，说明改动文件、映射、采集范围、已验证内容和缺口。缺环境时保留调查及适配结果等待补充。三种入口复用相同验证器和业务评测，不增加固定工作流。
