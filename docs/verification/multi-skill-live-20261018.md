# 多 Skill 整体迁移与联合验收：真实模型 UI 端到端验证

最终结果：通过。浏览器操作、迁移 Agent、OpenJiuwen Runtime 和 Judge 均为真实实现；未注入 bundlePorts、拦截模型响应、回放结果或使用测试替身。

## 执行范围

- 日期：2026-10-18（America/Tijuana）；最终一轮 UTC 2026-10-19 04:21:25 至 04:28:09，约 6 分 44 秒。
- 分支：`codex/multi-skill-migration`。
- 迁移与执行模型：`deepseek-v4-flash`；Judge：`glm-5.3`。
- Runtime：本分支真实 OpenJiuwen Worker，SDK `0.1.17.post1`，原生 DeepAgent 多 Skill 装载。
- 浏览器：真实 Chromium，经页面执行导入、分析、生成、配置、能力检查、联合验收、留出验收和下载。
- 数据：仓库 `acceptance/multi-skill-procurement/` 的可控采购示例，包含真实 Python 业务代码。外部金融系统及其他部署环境不在本次范围内。

三个成员为 `budget-query`、`purchase-review`、`audit-report`。迁移 Agent 同时看见所有成员与共享源码，将 LegacyContext 注入式函数迁移为标准库 CLI，统一 `available_yuan` 金额契约。最终候选修改三个 Skill 和共享代码，新增运行说明，共 7 个文件有变动。分析阶段 10 次模型调用，生成阶段 20 次；本轮开发验收首次通过，没有触发候选修复。

## 业务结果

| 阶段 | 案例 | 真实执行结果 | Runtime 耗时 | Judge |
| --- | --- | --- | --- | --- |
| 开发 | over-budget | 预算 5312.75 元，申请 8123.45 元；REJECT，缺口 2810.70 元 | 29.796 秒 | 通过 |
| 开发 | equal-budget | 预算和申请均为 947.23 元；ALLOW，缺口 0.00 元 | 34.328 秒 | 通过 |
| 独立留出 | unknown-center | 缺少 CC-MISSING；UNAVAILABLE，未借用 CC-OTHER 预算 | 36.985 秒 | 通过 |

三个案例分别使用独立 Runtime 实例。每例均有三个 Skill 的实际 `skill_tool` 激活及入口读取摘要，并直接执行冻结包内 `budget_tool.py` 和 `review_tool.py`。六次脚本调用全部退出码 0；没有临时修改代码或复制后修补。Judge 同时核验实际工具输出和业务标准，报告均明确未发生审批、预留或扣款。留出案例未反馈给迁移 Agent。

Runtime 身份、完整流结束标记、全体成员及整组摘要均核对通过。浏览器没有 pageerror；下载的 ZIP 包含全部成员和验收清单，`verified=true`。独立重算 ZIP 内 `package/` 文件内容摘要，与验收候选一致：

```text
ce65fa5efa14c738ece02df15fe490bbf4c72d9d709cf09afbe6e0b57709da1c
```

最终候选：`candidate-1761e96c-1e61-49e6-86f0-6f62f4806f5a`。验收后 `activeSessions=0`，脚本关闭自行启动的浏览器、服务和 Worker。

## 实测发现与修复

1. 原先分析阶段使用 Code Agent，可能进入实施待办或生成流程。改为只读 Explore Agent，并明确当前阶段。
2. 真实模型曾返回非空但不完整的 JSON。增加一次无工具的真实模型格式整理；空回答、执行错误和轮数耗尽仍失败，保留诊断。
3. 整组任务没有单工具契约注册表，却暴露了只能返回 UNKNOWN_TOOL_CONTRACT 的工具。移除该无效入口，保留编译检查，业务判断交给实际联合验收。
4. 新增 live 脚本曾误将 Launcher 的 `executionMode` 与 Worker 内部字段混用。按实际生产协议检查 Launcher 模式，同时核对 SDK 版本、DeepAgent 和上游模型绑定；随后重新完整运行。
5. 更关键的问题是运行时修补掩盖交付缺陷：一轮候选错误导入 `decimal.ArithmeticError`，运行 Agent 复制脚本后修补，业务答案正确而旧 Judge 给了通过。证据复核否决该候选。现已明确禁止这种行为，Worker 检查原件及同路径工作区副本，Judge 拒绝包括复制修补、猴子补丁和重新实现的替代结果。真实 Judge 对该旧执行证据重新判断后，两个标准均判 false。早期两次复核响应未完整覆盖标准，被现有校验拒绝，未作为有效结论。

旧候选的失败或复核否决记录均保留，未改写为成功。最终通过记录来自修复后的新一轮完整执行，不沿用旧候选或旧验收结果。

## 产物与复跑

本机完整产物目录（已被 Git 忽略，未提交密钥或私有运行日志）：

```text
reports/bundle-live-b1f1b7bb-a1b7-4465-9356-fa27d5850d62/
  result.json                 最终执行结果和模型信息
  task.json                   分析、候选、逐例执行与 Judge 证据
  evidence-review.json        独立核查原始脚本调用与交付摘要
  agent-diagnostics/          真实迁移调用与工具轨迹
  joint-passed.png            联合验收 UI 截图
  verified-bundle.zip         已验收完整交付包
```

被否决的运行时修补案例在 `reports/bundle-live-a12840f3-1b97-4650-b32a-66daef283791/`，应结合 `review.json` 阅读，不能将其早期自动通过记录用于交付。`judge-raw-format-diagnostic.json` 保留真实 Judge 最终拒绝结果。

按 [多 Skill 迁移说明](../multi-skill-migration.md) 配置真实模型和 Python 环境后运行：

```sh
pnpm test:ui:migration-bundle:live
```

辅助回归结果：`pnpm check`、`pnpm build`、8 项多 Skill TypeScript 测试、18 项 Python 测试、脚本语法检查及 `git diff --check` 通过。辅助单元测试包含模型替身；上述端到端验收及真实 Judge 复核没有使用替身。
