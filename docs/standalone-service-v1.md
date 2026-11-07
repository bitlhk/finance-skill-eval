# 平台 HTTP 与命令行接入

平台后端使用 Python。原 npm 编程接口已撤销；外部应用通过现有 HTTP API 接入，不再直接实例化 TypeScript Runner、Judge 或任务控制器。

## HTTP

默认地址为 `http://127.0.0.1:56361`。私有工作区使用 `Authorization: Bearer …`；账户工作区仍由现有可信入口提供身份与 Origin。不要在 URL 中携带口令。

| 用途 | 入口 |
| --- | --- |
| 能力、资产、测试题和 Runtime | `GET /api/catalog` |
| 上传 Skill | `POST /api/skills/upload`，ZIP 请求体 |
| 导入用户测试集 | `POST /api/skills/{assetId}/prepare/import` |
| AI 准备测试集 | `POST /api/skills/{assetId}/prepare` |
| 创建对比评测 | `POST /api/runs` |
| 查询与流式进度 | `GET /api/runs/{id}`、`GET /api/runs/{id}/events` |
| 重复评判冻结证据 | `POST /api/runs/{id}/rescore` 或 `/rescore/start` |
| 优化与人工选择 | `POST /api/runs/{id}/optimize`、`/api/optimizations/{id}/…` |
| 人工复核和校准 | `GET/POST /api/evaluation-reviews` |
| 迁移任务 | `/api/migration-tasks` |
| 完整工程上传 | `POST /api/migration-tasks/upload?inputKind=agent_project` |
| 主 Agent 对话与补充 | `/api/migration-tasks/{id}/conversation/…` |
| 环境登记和准入 | `/api/environments` |

公开请求 JSON Schema 位于 `contracts/platform/schemas/`，页面响应类型位于 `contracts/platform/responses.d.ts`。现有页面是完整接入示例。后台独立核验权限、配置、运行身份、证据和交付条件，不能把客户端校验当作准入。

对比评测保持固定流程，优化是单独的受预算任务。迁移主 Agent 可以自主选择能力、更新计划、提出需要用户决定的问题并继续原会话；客户端不需要再按模型输出格式拼接多个独立阶段。

## 命令行

```sh
pnpm check:openjiuwen
pnpm eval:investment:replay
pnpm eval:wealth:replay
pnpm runtime:check -- --capabilities contracts/runtime-launcher/examples/builder-capabilities.json
```

构建后继续支持原命令路径：

```sh
node dist/service/server.js
node dist/cli.js replay --pack packs/finance/investment-research/eval.yaml --out reports/investment-research
```

这些文件只负责选择项目环境和启动 Python，不包含另一套评测或任务实现。Python 入口分别为 `api`、`api.cli`、`api.runtime_check`。

## 自定义运行环境

业务 Agent 仍通过标准 Launcher 合同接入，返回规定的结果与中间过程，不要求公开 OTLP 收集器。Builder 新建、已接入 Launcher 和完整工程迁移共用该运行与评测边界。协议见 [Launcher 合同](../contracts/runtime-launcher/README.md)，架构见 [当前实现](current-architecture.md)。
