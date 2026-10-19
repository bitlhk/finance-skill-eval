# Finance Skill Eval

金融 Agent Skill 的评测与迁移平台，提供 Web 控制台、CLI 和可嵌入的评测 Core。

- **Skill 评测**：准备测试题，对比 Skill 版本或模型，由独立 Judge 评审并输出报告。
- **Skill 迁移**：1～10 个 Skill 共用一个 Agent 工作区，整体分析、改造、修复和交付。
- **任务验收**：目标 Runtime 加载整组候选，运行开发集与冻结留出集；保留版本、工具证据和日志关联。

## 部署

完整服务包含 Node API 和 OpenJiuwen Runtime。选择对应方式完成安装、配置与启停：

| 部署方式 | 服务管理 | 操作入口 | 安装指南 |
| --- | --- | --- | --- |
| Linux 直接部署 | systemd | `bash deploy/linux/manage.sh` | [Linux / WSL](docs/production-linux.md) |
| Docker Compose | API、Runtime 双容器 | `bash deploy/docker/manage.sh` | [Docker](docs/production-docker.md) |
| Windows 服务 | WinSW / SCM | `./deploy/windows/manage.ps1 -Action …` | [Windows](docs/production-windows.md) |

各方式共用 [配置、预检与备份恢复说明](docs/production-deployment.md)。日志查询见 [运维日志](docs/production-logging.md)。根目录 `compose.yaml` 是旧版 Node-only 示例；完整容器部署使用 `deploy/docker/compose.yaml`。

## 本地开发

需要 Node.js ≥22、pnpm 10.34.4；运行迁移 Agent 和本地 Runtime 还需要 Python 3.11～3.13、uv。

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm serve
```

控制台地址：`http://localhost:56361`。上述命令只启动 API；模型配置、Runtime 启动及环境登记见 [本地开发与模型配置](docs/local-development.md)。

```sh
pnpm check
pnpm test
pnpm test:ui:migration
```

## 使用与接入

迁移流程：**导入 → 分析 → 生成候选 → 运行配置 → 准备验收 → 任务验收 / 修复 → 交付**。单 Skill 和多 Skill 使用同一流程，旧任务从「旧版任务记录」继续处理。

| 需求 | 文档 |
| --- | --- |
| 单 / 多 Skill 迁移与验收 | [统一迁移](docs/multi-skill-migration.md) |
| 配置模型与本地评测 | [本地开发](docs/local-development.md)、[在线评测示例](docs/local-online-demo.md) |
| 接入 Builder 产出的 Runtime | [Builder 接入与当前支持范围](docs/runtime-builder-integration.md) |
| 实现其他 Agent Runtime | [Launcher 协议](docs/runtime-launcher-protocol.md)、[合同与示例](contracts/runtime-launcher/README.md) |
| 在其他产品中嵌入评测 | [Service 与 Adapter 接入](docs/standalone-service-v1.md)、[示例代码](examples/) |
| 定位代码与排查问题 | [架构与运维导航](docs/current-architecture.md) |

Builder 当前通过外部构建、部署后接入 Runtime；新统一任务尚未提供 Builder 需求导出和交付回填入口，旧任务保留该接口。

## 目录

```text
src/                      评测 Core、Adapter、服务接口
src/migration/tasks/      统一迁移流程
web/                      Web 控制台
integrations/openjiuwen/  Runtime 与迁移 Agent
contracts/                Runtime / Builder 协议
packs/finance/            金融 Eval Pack
deploy/                  三种部署方式及运维工具
tests/、scripts/          回归测试与端到端验证
```

私有配置使用 `.env.local` / `.runtime.local.json`，本地运行报告写入 `reports/`；这些内容默认不提交 Git。
