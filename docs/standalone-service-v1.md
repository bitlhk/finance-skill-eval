# Finance Skill Eval 独立服务 V1

## 定位

独立服务是 Finance Harness Engineering Plane 中的 Eval Lab。它不进入生产 Agent 请求热路径，也不接管 Agent Loop、权限或金融业务系统。

```text
EA 技能市场 ───────────┐
独立评测控制台 ─────────┼─> Finance Skill Eval Service
Builder / CI ──────────┘      │
                              ├─ Eval Pack / Promptfoo / Judge
                              ├─ Skill 候选 / Run / Report
                              └─ Runtime Adapter
                                      │
                              被测 Agent Runtime
                                      │
                         Finance Harness / MCP / 银行业务系统
```

原 EA 可以继续内嵌 `finance-skill-eval` Library。需要集中运行时，再把 EA 技能市场入口切换为 Service Client；这不是独立服务 V1 的前置条件。

## API

| API | 用途 |
|---|---|
| `GET /api/catalog` | Eval Pack、上传 Skill、环境与模型角色状态 |
| `POST /api/skills/upload` | 以 `application/zip` 上传候选 Skill |
| `POST /api/skills/{assetId}/prepare` | Analyzer 根据 Skill 生成测试题 |
| `POST /api/skills/{assetId}/prepare/manual` | 保存人工给定测试题 |
| `POST /api/environments` | 登记 Runtime HTTP 或 MCP 环境 |
| `POST /api/environments/{id}/preflight` | 健康检查或 MCP 初始化与 `tools/list` |
| `POST /api/runs` | 创建一轮 A/B 评测 |
| `GET /api/runs/{id}/events` | SSE 实时运行快照 |
| `POST /api/runs/{id}/cancel` | 取消排队或运行中的任务 |
| `POST /api/runs/{id}/retry` | 对失败、中断或取消任务单次重试 |
| `GET /api/runs/{id}/export` | 导出 JSON、HTML 或 Markdown 报告 |

服务重启时，未完成任务会标记为 `interrupted`，不会伪装成成功；任务可由用户显式重试。

## Runtime HTTP 合同

Runtime 环境的执行地址建议以 `/execute` 结尾，并提供同级 `/health`。

请求：

```json
{
  "schemaVersion": "finance.skill-eval.runtime-request.v1",
  "runId": "run-id",
  "side": "left",
  "case": {
    "caseId": "CASE-001",
    "prompt": "业务任务",
    "requiredTools": ["customer_query"]
  },
  "model": {
    "providerId": "bank-model-gateway",
    "modelId": "model-a"
  },
  "variant": {
    "mode": "without_target_skill",
    "skillId": "target-skill"
  },
  "skill": null,
  "environment": {
    "environmentId": "env-id",
    "mcpServers": []
  }
}
```

右侧装配上传 Skill 时，`skill` 包含目标 Skill 的 ID、版本、摘要和主 `SKILL.md` 内容。Runtime 必须确认实际装配身份，并返回统一执行证据：

```json
{
  "runId": "runtime-run-id",
  "side": "right",
  "caseId": "CASE-001",
  "status": "completed",
  "modelId": "model-a",
  "skillVersion": "1.0.0",
  "output": "Agent 输出",
  "elapsedMs": 1200,
  "toolCalls": [{ "name": "customer_query", "status": "completed" }],
  "loadedSkills": [{ "skillId": "target-skill", "version": "1.0.0" }],
  "usage": null,
  "runtimeIdentityVerified": true,
  "streamCompleted": true,
  "error": null,
  "metadata": {}
}
```

Eval Service 不根据回答文本猜测工具调用或 Skill 身份。

## MCP 边界

服务支持 MCP Streamable HTTP 的 `initialize` 和 `tools/list` 预检。它将环境 ID、服务地址和已发现工具名作为测试环境描述传给 Runtime。

真正的 MCP 工具执行由被测 Agent Runtime 完成。这样可以保留 Runtime 原生 Session、权限、Trace 和工具调用语义，也避免 Eval Service 变成另一套 Agent Runtime。

## 数据边界

- 上传文件最大 8 MB，解压后最大 16 MB、200 个文件；拒绝目录穿越。
- Skill 资产、环境声明和运行记录保存在 `FINANCE_EVAL_DATA_DIR`。
- 环境记录只保存凭据环境变量名称，不保存浏览器提交的密钥。
- 可选 `FINANCE_EVAL_ACCESS_TOKEN` 用于保护 API；生产部署还应放在机构网关和身份认证之后。
- 当前文件存储适合单实例 Demo。多实例部署应替换为共享数据库和对象存储，不改变公共 API 合同。

## V1 非目标

- 不提供通用 Agent 对话界面；
- 不把任意工具调用模拟为成功；
- 不建设资产市场或复杂审批平台；
- 不要求传统银行系统改造成 MCP；
- 不要求 EA 立即修改现有入口。
