# 本地开发与模型配置

## 唯一工作目录与发布来源

本机 Eval 的保留目录为 `C:/Users/Administrator/Documents/code_projects/finance-skill-eval`。本次整合分支为 `feat/consolidate-eval-workspace`，包含主线统一迁移流程与原目录的本地改动。Git 工作区与运行数据目录是两回事；归档代码工作区不会自动迁移业务任务，也不会转换旧协议记录。

版本由 Git commit/tag 管理。手动启动、Windows 服务和 Linux 服务都直接运行指定项目目录的代码，读取该目录 `.env.local`。不再维护发布副本；修改源码后须构建并重启，切换 Git 版本前须停服务并备份数据。

`pnpm serve` 自动读取当前目录的 `.env.local`，已有进程环境变量优先。日常数据默认写入 `data`，也可通过 `FINANCE_EVAL_DATA_DIR` 显式配置；启动日志打印实际数据目录。迁移任务、Skill 资产、评测记录和环境登记应一起备份，不要把日常服务指向测试数据目录。

## 模型认证与执行活动

平台模型网关默认使用 `Authorization: Bearer <密钥>`。如果网关要求直接传密钥，设置 `FINANCE_EVAL_MODEL_AUTH_MODE=raw`，或通过 `FINANCE_EVAL_<角色>_AUTH_MODE` 为 ANALYZER、EXECUTION、JUDGE、OPTIMIZER、MIGRATION 单独覆盖。只接受 `bearer`、`raw`，密钥本身不填写前缀。

OpenJiuwen Runtime 与迁移 Agent 使用 `.runtime.local.json` 中模型条目的 `authMode`，默认 `bearer`，可设为 `raw`。平台角色环境变量和 Runtime 模型条目是两套独立配置；统一任务分析、生成、修复均使用同一套迁移模型绑定。

统一迁移页面显示模型响应、工具执行和阶段活动，支持滚动跟随、展开响应、断线重连和取消。活动接口为 `/api/migration-tasks/:id/activity` 与 `/activity/events`，取消仍走任务的 `/:id/cancel`，由任务生命周期统一等待执行与落盘结束。活动记录保存在数据目录的 `migration-activity/`，与尝试 ID 关联；进程重启后未完成活动显示中断，不代表自动继续执行。活动内容按私有任务数据管理，不提交 Git。

## 验收数据归档

手工验收脚本将独立数据保存在 `.migration-workspace/acceptance/`；自动化测试仍使用临时隔离数据。归档数据前先停止相关服务，再执行 `node scripts/consolidate-workspace.mjs <plan.json>`。

计划字段：`target` 和 `archive` 为尚不存在的目标、备份目录；`sources` 按优先级从低到高排列；可选 `projectSources` 指定任务 ID 对应的来源；`archiveSources` 指定只备份的其他目录。统一任务使用 `bundle-*` ID，任务与全部快照必须来自同一来源，缺失快照或摘要不匹配会拒绝合并。脚本保留源数据、文件摘要与冲突来源，不拼接验收结论。

旧 `migration-bundles`、`migrations` 及不兼容任务记录可在迁移任务页的“历史迁移任务”中只读查看；旧环境登记在“测试环境”的“历史环境登记”中展示。历史分析、候选、验收证据和可用文件快照保持原样，可下载历史留档。页面说明无法继续执行的原因，后端拒绝修改与执行；历史通过不代表当前协议验收通过。使用原始 Skill 新建任务后才能按当前协议重新验收。检查归档结果后再启用新数据目录，并重新验证 Runtime 是否在线。

基础环境要求：Node.js 22 或更高版本、pnpm。使用本地 OpenJiuwen Runtime 或 Skill 迁移能力时，还需要 Python 3.11–3.13 和 `uv`。

```bash
pnpm install
pnpm check
pnpm test
```

需要执行工具型 Skill 或迁移流程时，先创建本机 Runtime 配置：

```powershell
Copy-Item .runtime.local.example.json .runtime.local.json
```

在 `.runtime.local.json` 中填写可用模型的 `baseUrl`、`apiKey` 和 `upstreamModelId`，并设置 `defaultModelId`（省略时使用第一个启用的模型）。该文件只属于本机运行环境，已被 Git 忽略，不应提交。

Windows 下启动本地 Runtime：

```powershell
scripts\start-openjiuwen.cmd
```

Runtime 默认监听 `http://127.0.0.1:56362`，并通过 `/v1/runtime-capabilities` 向平台公布可选模型。前端展示和选择的是 Runtime 实际公布的模型，而不是一条写死在前端或平台环境变量中的模型名称。

启动独立评测控制台：

```bash
pnpm build
pnpm serve
```

浏览器打开 `http://localhost:56361`。控制台可以复核冻结证据、上传并评测 Skill，也可以导入源 Skill 完成诊断、生成、运行验证、效果评估和迁移包下载。工具型 Skill 由已登记的 Runtime Launcher 执行；迁移生成的 MCP 由 Runtime 根据候选包配置按需启动。

完整服务部署使用 [Linux](production-linux.md)、[Docker Compose](production-docker.md) 或 [Windows](production-windows.md) 指南。

## 本机配置边界

- `.runtime.local.json`：本地 Runtime Launcher 的私有配置，包含 `models`、`defaultModelId` 和 Runtime 自身需要的 `mcp` 定义。模型的 API 地址和密钥只由 Runtime 读取。
- `.env.local`：平台服务进程的本机环境变量，可配置 Analyzer、Judge、Optimizer、迁移开关、监听地址等。`pnpm serve` 自动读取该文件；Windows/Linux 后台服务也明确读取项目中的同一文件。Windows Runtime 启动脚本也会读取它，已经存在的系统环境变量优先。
- 页面中的“环境管理”：登记可连接的 Runtime Launcher 和外部 MCP，并可组合成执行环境；它不负责编辑远端 Runtime 内部的模型或 MCP 配置。

Builder 接入和服务端信任配置见 [Builder 接入](runtime-builder-integration.md)。

对于 Runtime Launcher，执行模型列表来自 Runtime 的 capabilities，平台只保存用户选择的 `modelId`。`.env.local` 中的 `FINANCE_EVAL_EXECUTION_*` 仍可用于不经过 Runtime Launcher 的直接模型执行，但不会替代 Runtime 公布的模型列表。

平台自身使用的模型角色可以通过服务端环境变量配置，密钥不进入浏览器和 Eval Pack：

```text
FINANCE_EVAL_ANALYZER_BASE_URL / API_KEY / MODEL
FINANCE_EVAL_EXECUTION_BASE_URL / API_KEY / MODEL
FINANCE_EVAL_JUDGE_BASE_URL / API_KEY / MODEL
FINANCE_EVAL_OPTIMIZER_BASE_URL / API_KEY / MODEL
```

也可以使用统一的 `FINANCE_EVAL_MODEL_BASE_URL`、`FINANCE_EVAL_MODEL_API_KEY` 和 `FINANCE_EVAL_MODEL` 作为平台模型角色的默认配置。Skill 迁移的诊断与代码生成 Agent 使用 `.runtime.local.json` 中的模型；通过 `FINANCE_EVAL_AGENT_MODEL_ID` 选择模型条目，默认条目名为 `enterprise-model`。这与前端为候选效果评估选择的执行模型是两个用途。

在本机演示环境中，也可以让 Judge 使用当前主机已登录的 Codex 账号：

```text
FINANCE_EVAL_JUDGE_PROVIDER=codex_cli
FINANCE_EVAL_JUDGE_MODEL=gpt-6-astra
```

也可直接运行 `pnpm serve:codex`。Codex Judge 默认使用 `gpt-6-astra`，可通过 `FINANCE_EVAL_JUDGE_MODEL` 单独覆盖；它不继承通用的 `FINANCE_EVAL_MODEL`，出题和做题模型仍分别配置。

该模式通过 Codex CLI 的临时只读任务执行匿名评审，会消耗当前 ChatGPT/Codex 账号额度。它适合个人演示和校准，不建议作为多人共享服务的生产认证方式；共享部署应使用独立 API、服务账号或企业模型网关。

回放投资研究评测：

```bash
pnpm eval:investment:replay
```

报告输出到：

```text
reports/investment-research/report.json
reports/investment-research/report.html
```

回放财富管理评测：

```bash
pnpm eval:wealth:replay
```

报告输出到：

```text
reports/wealth-management/report.json
reports/wealth-management/report.html
```
