# 单 Skill / 多 Skill 统一迁移验收

日期：2026-10-19。分支：`codex/multi-skill-migration`，基线 `c3d9942`。本轮在 Windows 工作树的独立 API/Runtime 测试实例执行；未替换既有 Windows SCM 或 WSL systemd 部署。

## 改造结果

- 新任务统一支持 1–10 个成员，相同任务模型、编排、七阶段页面和任务验收路径。
- 文件存储、迁移编排、逐题验收、交付、Agent/Runtime 适配分别归入 `src/migration/tasks/`，生产入口通过 composition 装配。
- 旧 Bundle 路径作为导入门面与 HTTP 别名保留；磁盘目录、ID 和存储 schema 不重写。
- 旧单 Skill v2 任务保留继续处理与导出；v0.1 保留只读导出。复制源资产或候选转入新任务时记录来源，旧文件不变，旧通过结论不继承。
- 请求 → 任务 → 尝试 → Agent 进程 / Runtime 案例 → Judge 请求可关联；UI 展示操作历史及关联 ID。
- 新旧候选导出共用凭据检查，拒绝凭据文件及明显硬编码凭据（包含 JSON 引号键），不静默裁剪已冻结候选。

## 自动化检查

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| Node / examples / Web 类型 | 通过 | `unified-check.log` |
| Core + Web 构建 | 通过；保留 Vite 主包体积提示 | `unified-build.log` |
| 全量 Vitest | 140 文件，1089 通过、2 跳过 | `unified-full-regression-final.log` |
| Python Bundle 与日志 | 12 通过，包含单成员 v2 装载 | `unified-python.log` |
| 统一迁移 UI | 11 项通过：修复、陈旧结论、重新验收、交付、窄屏、旧任务转入、单成员验收 | `unified-ui-regression.log`、`artifacts/bundle-ui/` |
| 导入 UI | 5 项通过：混合失败、单成员创建、整工程共享路径、超大文件、窄屏 | `reports/migration-import-ui/result.json` |
| 历史 v2 UI | 18 个检查条目完成，包括逐 Tool、Script/MCP、候选改进、留出集和取消 | `unified-legacy-ui.log` |

UI 回归使用明确的确定性 Agent/Runtime/Judge 端口，不将其计为真实模型效果证据。历史 UI 测试通过兼容 API 准备历史任务，再从旧记录入口继续操作。企业/能力旧验收脚本已调整导航并通过语法检查，本轮未重新运行它们的全部真实模型案例。

## 真实 Agent、Runtime、Judge

实际使用 Python OpenJiuwen Agent/Runtime 与私有配置中的模型、Judge；未注入端口替身、重放答案或拦截模型请求。两个成员规模都执行真实脚本、核对装载回执、冻结候选及模型身份、下载已验收 ZIP，并检查 Runtime activeSessions 为 0。

| 场景 | UTC 时间 | 开发集 | 独立留出集 | 报告 |
| --- | --- | --- | --- | --- |
| 3 个 Skill | 10:51:23–11:00:25 | 2/2 | 1/1 | `reports/bundle-live-13a347ec-78e8-4bb1-ad6b-497abf847ea8/result.json` |
| 1 个 Skill，最终复跑 | 11:06:24–11:15:06 | 2/2 | 1/1 | `reports/bundle-live-3a91a018-170b-405d-892d-b8aa03b41562/result.json` |

两组最终候选都首次通过开发验收。另保留早期单成员运行 `reports/bundle-live-f57d17e5-a90c-4d37-854b-914c63b6b10d/`：第一次开发验收因 Judge 未完整覆盖业务标准失败，随后实际调用迁移 Agent 修复、重验与留出验收均通过。该次不能被解释为证明原业务代码有错，也不隐去失败记录。最终复跑已将案例描述明确为单个 procurement Skill 内的三个业务步骤。

本轮跨两个成员修复代码的确定性 UI 回归通过；最终真实多成员运行没有触发修复，不宣称本轮真实模型覆盖了跨两个成员修复。

## 日志关联与凭据

三个真实运行目录均生成 `correlation-audit.json`，检查 HTTP 请求、持久化尝试、Agent 开始/退出、Runtime 会话和 Judge 开始/结束事件的 ID 对应关系，包括失败 Judge 事件。最终单成员和多成员分别检查 4 次尝试、2 次 Agent 运行、3 个验收案例；早期单成员检查 6 次尝试、3 次 Agent 运行、5 个案例。

`reports/unified-log-audit.json` 对 3 份 API/进程日志和 3 份 Runtime 日志扫描本次配置的实际凭据，未发现明文匹配；单元测试另覆盖 header、query、body、异常消息及调用方伪造请求 ID 的脱敏。报告只记录计数，不复制凭据。

两份最终真实交付 ZIP 的 package 文件亦通过最终共享导出检查。私有任务证据和 Agent 诊断含业务内容，仍属于受保护数据，不当作脱敏运维日志公开。

## 升级边界

API 与 Runtime 需一起升级，Runtime v2 成员数量下限已从 2 扩展为 1。旧单 Skill 的逐 Tool / Builder 功能仍由历史兼容实现维护；新任务使用完整工作区分析、改造和任务验收。数据目录依旧只允许单 API 写入，升级按既有停机备份方案执行。

代码定位与常见故障入口见 [当前架构](../current-architecture.md)，操作说明见 [统一迁移](../multi-skill-migration.md)，部署入口见 [生产部署](../production-deployment.md)。
