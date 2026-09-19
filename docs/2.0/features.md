# Finance Skill Eval 2.0 特性说明

## 1. 产品目标

Finance Skill Eval 2.0 帮助企业把一个包含 Skill 和 Tool 的工程整理成可以在不同 Agent Runtime 中复用的资产，并在 OpenJiuwen 中完成验证、评估和 Skill 优化。

系统分别回答：

1. Skill 写法是否符合企业规范；
2. 每个 Tool 是否已经可以跨 Runtime 使用；
3. 哪些 Tool 需要迁移，以及适合迁移成什么形式；
4. 迁移后的 Tool 是否能独立运行；
5. Skill 和 Tool 在 OpenJiuwen 中能否共同完成任务；
6. Skill 优化后是否真正带来改进。

Skill 合规判断以独立的企业 Skill 规范为依据；本文件只定义迁移产品要提供的能力。

## 2. 目标用户

- 需要迁移企业 Skill 的业务和研发人员；
- 负责 Tool、接口或脚本的开发人员；
- 负责验证业务结果和权限边界的评审人员；
- 负责 Skill 评估和优化的团队。

## 3. 首期使用前提

- 输入代码来自企业内部可信来源；
- 在运行本项目的同一台机器上执行一次性技术验证；
- 最终 Agent Runtime 验证目标是 OpenJiuwen；
- 生产部署、远程 Worker 和真实业务办理不在首期范围。

## 4. 用户流程

```text
导入工程
  → 查看 Skill 与 Tool 检查
  → 逐 Tool 选择处理方式
  → 审阅生成候选和 Diff
  → 运行 Tool 技术验证
  → 运行 OpenJiuwen 验证
  → 评估并优化 Skill
  → 复测并导出
```

## 5. 特性清单

### F-01 导入完整工程

用户可以上传包含一个 `SKILL.md`、Tool 源码、依赖文件、测试和资源的 ZIP，也可以导入单独的 Skill 文档。

验收标准：

- 原始上传内容按摘要保存，后续步骤不覆盖原资产；
- 同一个 ZIP 中存在多个 `SKILL.md` 时明确拒绝，不静默选择；
- 二进制和无法读取的文件列入清单，不在扫描阶段执行；
- 凭据文件被识别为风险，并阻止直接导出。

### F-02 Skill 规范检查

用户可以单独查看 Skill 是否符合企业 Skill 规范。

验收标准：

- 检查 `name`、`description`、目录名和引用文件；
- 展示可定位到文件和行号的问题；
- 区分错误、警告和提示；
- 不把 Tool 的实现语言当作 Skill 合规条件；
- 检查过程不执行上传代码。

### F-03 逐 Tool 可移植性检查

系统发现工程中使用或实现的 Tool，并为每个 Tool 给出证据、状态和建议。

验收标准：

- 至少识别 MCP Tool、命令行 Script Tool 和 Runtime SDK 绑定 Tool；
- MCP 是否可移植不取决于 Java、Python 或其他实现语言；
- 对每个 Tool 展示名称、来源文件、语言、状态、问题和建议；
- 状态包括 `PORTABLE_MCP`、`PORTABLE_SCRIPT`、`RUNTIME_BOUND`、`INCOMPLETE`、`UNSUPPORTED` 和 `UNKNOWN`；
- 静态结果不显示为“已验证通过”。

### F-04 逐 Tool 迁移决策

用户可以分别决定每个 Tool 的处理方式。

验收标准：

- 每个 Tool 只需选择 `MIGRATE_TO_MCP` 或 `MIGRATE_TO_SCRIPT`；
- 同一项目可以混合两种迁移方式；
- 选择 MCP 的多个 Tool 合并到同一个 Skill MCP 服务；
- 每个决定绑定当前资产，资产变化后要求重新确认；
- 系统可以展示建议，但不要求用户填写迁移理由。

### F-05 不可变候选与 Diff

系统根据逐 Tool 决策生成新的候选工程。

验收标准：

- 原始资产保持不变；
- 首期支持生成 Java MCP Tool 和 Python Script Tool；
- 同一 Skill 只生成一个 MCP 服务工程，服务中可以包含多个 Tool；
- 生成能力范围不影响其他语言 MCP 的合规判断；
- 缺失 Schema 或业务实现时生成待办并阻断验证，不编造实现；
- 所有自动改动按文件展示 Diff；
- 用户修改过的生成文件不会被静默覆盖。

### F-06 本机一次性技术验证

用户可以在本机验证当前候选中的 Tool。

验收标准：

- 每次任务使用独立临时目录，完成后清理；
- 只执行服务端允许的程序和参数，不执行模型拼接的 Shell；
- 支持成功、失败、超时和取消结果；
- MCP 验证覆盖启动、Tool 列表和 Tool 调用；
- Script 验证覆盖入口、结构化结果、退出码和错误；
- 结果绑定当前 Tool 和候选摘要；
- 报告明确标记 `LOCAL_TRUSTED`，不宣称生产安全隔离。

### F-07 OpenJiuwen 端到端验证

技术验证通过后，用户可以在 OpenJiuwen 中验证 Skill 和 Tool 的协作结果。

验收标准：

- Host 加载当前 Skill 和当前 Tool 映射；
- 支持已验证的 MCP Tool 和 Script Tool；
- 验证必要 Tool 调用、业务结果和安全先后关系，不固定完整推理轨迹；
- 记录 Skill、Tool、Runtime、模型、用例和实际调用证据；
- 任一绑定资产变化后，旧验证自动失效。

### F-08 评估与 Skill 优化

OpenJiuwen 验证通过后，用户可以复用现有开发题、Judge、Optimizer 和冻结留出题。

验收标准：

- B/C 对比使用同一组 Tool、Runtime、模型、数据和权限条件；
- Optimizer 只修改 `SKILL.md` 和明确允许的非执行资源；
- Optimizer 不修改 Tool 源码、依赖或测试；
- Optimizer 不读取冻结留出题；
- 优化候选重新运行开发题和留出题后，用户再决定是否采用。

### F-09 报告与导出

用户可以查看并导出当前迁移结果。

验收标准：

- 报告分别展示 Skill 检查、Tool 检查、逐 Tool 决策、Diff、技术验证和 OpenJiuwen 验证；
- 明确区分静态可移植、技术通过、端到端通过和历史证据；
- 导出包含候选工程、测试结果和验证摘要；
- 默认不导出凭据、Worker Token、完整模型回答或敏感测试报文；
- 未完成验证的候选只能标记为草稿。

### F-10 0.1 历史兼容

用户仍可查看和导出已有 0.1 项目。

验收标准：

- 保留源资产、候选、Diff、评测、优化和复核记录；
- 旧模拟验证明确显示为历史夹具证据；
- 旧验证结论不自动成为 2.0 技术验证或 OpenJiuwen 验证；
- 旧项目可以从当前资产重新进入 2.0 检查流程。

## 6. 明确不做的事情

- 不自动恢复缺失的业务代码；
- 不根据函数名猜测权威 Schema；
- 不把 MCP 限定为 Java；
- 不强制 Script 使用 Python；
- 不要求 Skill 增加 Tool 清单或环境安装步骤；
- 不执行生产发布或真实业务办理；
- 不宣称本机 Worker 可以安全运行任意不可信代码；
- 不证明迁移前后 Runtime 完全等价。

## 7. 完成定义

首期开发完成需要同时满足：

1. F-01 至 F-10 的首期验收项都有自动测试或可重复验证记录；
2. 一个 Runtime 绑定 Tool 可以生成 Java MCP 候选并验证；
3. 一个 Runtime 绑定 Tool 可以生成 Python Script 候选并验证；
4. 一个项目可以同时包含两种迁移方式的 Tool；
5. 同一 Skill 中的多个 MCP Tool 只生成一个 MCP 服务；
6. 一个缺少业务实现的负例不会被标记通过；
7. OpenJiuwen 验证后可以进入现有评估和优化流程；
8. 现有非迁移评测测试保持通过。

## 8. 确定性验收集

首期随仓库提供三类小型 Skill，用于重复验证不同工具组合：

- 混合 Tool：一个 MCP Tool 和一个 Python Script Tool；
- 纯 Script：一个带 `pyproject.toml` 的 Python Script Tool；
- 共享 MCP：两个 Tool 由同一个 MCP 服务提供。

混合 Tool 的公开业务用例覆盖正常订单、订单不存在、订单未批准和 Script Tool 输入异常；另保留一个不同金额的隐藏订单，防止只针对公开答案实现。

运行 `pnpm test:ui:migration-v2` 可以使用真实本地服务和无界面 Chrome，重复验证页面上传、检查、迁移选择、完成版替换、Script/MCP 技术验证与 ZIP 下载。测试不会调用企业模型服务，也不会读取本机模型凭据。
