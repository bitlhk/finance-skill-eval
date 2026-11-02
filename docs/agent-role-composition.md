# Agent 角色与统一执行底座

当前实现只保留一个迁移任务编排、一个优化轮次执行器和一个平台工程 Agent 进程入口。旧迁移路由原本未注册，本次删除其实现、旧服务集合、旧 A2/A4 Agent、旧逐工具优化编排和对应的停用页面；当前页面布局与入口继续使用。

## 当前代码分工

| 位置 | 职责 |
| --- | --- |
| `web/src/features/migration/` | 现有迁移页面：输入、诊断、方案、候选、运行准备、验收、交付 |
| `src/migration/tasks/application/task-service.ts` | 唯一迁移任务流程；经端口组织 Agent、Builder、评测与候选版本 |
| `src/migration/tasks/application/task-optimization.ts` | 将迁移任务的目标、快照和评测证据接到公共优化循环 |
| `src/service/optimization-manager.ts` | 对比评测后的优化入口、候选文档装配、留出集复核及人工采纳 |
| `src/improvement/application/optimization-loop.ts` | 通用优化状态：工作版本、推荐版本、目标、预算和等待恢复 |
| `src/improvement/application/round-workflow.ts` | 唯一轮次调度：诊断、调整、复测、Review、选择下一轮起点 |
| `src/evaluation/` | 案例执行与证据边界、评估方法接口 |
| `src/agents/` | 公共角色、指导加载、模型调用、输出校验和取消超时 |
| `agent-roles/v1/` | 版本化 Prompt、指导 Skill、输出合同、工具权限及交付模板 |
| `integrations/openjiuwen/platform_agent.py` | 唯一平台工程 Agent 进程入口，首先检查项目 SDK 环境 |
| `integrations/openjiuwen/bundle_agent.py` | 统一工程任务合同、隔离工作区、受限文件工具、结构提交和候选冻结 |
| `integrations/openjiuwen/agent_execution.py` | 模型初始化、SDK Agent 装配、轨迹与实际权限核验 |
| `src/service/history-store.ts` | 原格式历史记录与快照的只读展示、下载 |
| `src/execution-configuration/historical-service-environment.ts` | 读取历史评测配置中的服务环境引用；不启动旧任务、不改写记录 |

`src/migration/domain/` 中仍被历史记录和当前任务共同引用的数据类型、规范规则继续保留。这些类型不构成第二套执行流程。历史记录中的 A1/A2/A3/A4 阶段编号仍可读取；新执行使用角色名称。

## 迁移和优化到底是什么关系

迁移是业务任务：把已有企业工程变成符合规范、能部署运行、保持业务含义的交付物。优化是公共能力：在允许修改的范围内，根据评测证据改善目标，直到达标、用完预算或等待外部改造。

```text
迁移：源工程 → 诊断与标准化改造 → 规范 Review → Runtime 准备 → 评测
                                                           ↓ 未达到目标
                                                      公共优化循环
                                                           ↓
                                                      验收、选择与导出

对比评测：运行两侧 → 评分与报告 → 按用户目标启动同一个优化循环

公共优化循环：证据 → 诊断 → 调整 → 复测 → 效果 Review → 下一轮或结束
```

例如，报销工具依赖旧框架，先将业务工具变为独立 Script/MCP 并验证接口和业务语义，这是迁移。评测发现缺少发票时仍误判，再联合调整 Skill 指导与必要工具逻辑、复测和审查，这是优化。优化不得以通过率为理由重新引入框架耦合。

程序管理步骤、预算、权限、版本和等待恢复；Agent 负责诊断、提出或实施调整、判断结果。规则检查、脚本验证、模型评分是不同评测方法，不要求全部改成模型评分。

## 角色如何组成

| 角色 | 目标 | 执行方式 |
| --- | --- | --- |
| diagnosis | 识别源码、依赖、工具边界与标准化问题 | 只读工程 Agent，扫描器与文件工具 |
| migration | 按已确认方案完成标准化交付 | 工程 Agent，受限写入、编译、契约测试 |
| improvement-diagnosis | 根据冻结评测证据定位效果问题 | 无工具模型角色，不读取留出集 |
| adjustment | 按诊断联合调整文档、工具或 Runtime 工程 | 按入口使用提案或工程执行配置 |
| criterion-judge | 根据真实执行证据逐项判断验收标准 | 无工具模型角色 |
| standardization-review | 独立审查迁移规范与交付边界 | 只读工程 Agent |
| effect-review | 判断候选收益、回退及继续修复的价值 | 独立无工具模型角色 |

角色表达不同职责；业务入口不再各自复制执行器。文档、工具、Runtime 是 adjustment 的可组合指导与权限，不是三个独立修改者。

角色清单声明 Prompt、Skill、参考文件和工具集合。TS/Python 加载器只读取平台安装的可信版本，检查目录边界和代码内权限上限，创建 Agent 前完整加载指导并记录资源摘要。上传工程不能替换平台指导。

proposal 配置由模型返回一份 changes，程序验证并冻结候选；engineering 配置让同一个角色通过受限文件工具实际改代码。模型调用底层统一使用 `model-role.ts`；工程装配统一使用 `agent_execution.py`。格式修正只整理已有判断，不得改判业务结论或重复执行工具。

被测企业 Skill 的加载仍由其 Runtime 负责。平台的指导 Skill 与正在评测的业务 Skill 是不同资产。

## 从旧实现迁入的能力

- 源码扫描：`run_scanner` 已接入统一 diagnosis，只扫描 source 目录，不执行上传代码。
- 编译和工具验证：统一工程 Agent 提供 `compile_source`、单工具 `run_contract_test` 及联合 `run_mcp_contract_suite`，继续复用实际契约测试工具。
- 服务和脚本交付模板：迁入 `agent-roles/v1/references/service-templates.md`，标准化迁移和工程调整共同加载。
- 历史服务环境解析：抽出只读解析器和 `historical-migration-record.ts` 读取器，继续核对候选摘要、配置版本、配置摘要及工具归属，分别返回普通配置和敏感配置。旧迁移仓库的写入、任务锁和列表接口一并删除；历史展示仍由 HistoryStore 负责。
- 模型输出修正：所有当前调用直接引用 `src/agents/model-output-correction.ts`，删除旧转发入口。
- 当前页面和测试直接接入 `MigrationTaskService`，删除旧 Bundle 构造兼容类。

业务 Script/MCP 的实现仍独立于 Agent 框架。框架只绑定通用执行工具，不把企业业务逻辑重新写成框架私有工具。

## 优化与审查

规范 Review 检查硬约束；效果 Review 检查候选是否值得保留、是否继续修复。程序分别保存 working（下一轮实验起点）与 best（审查认可的推荐版本）。

`CONTINUE_CANDIDATE` 可以沿有潜力的候选继续修复，普通案例回退不会导致机械回滚；受保护案例和硬约束仍不可被效果评分抵消。轮次用尽时保存实验记录，推荐版本不会被未审查的实验结果替换。

需要外部 Runtime 或配置时，保存候选、诊断和剩余预算，等待 Builder 交付或配置补齐。恢复后复测同一轮，不重复诊断和改写。工程内明确授权的 Runtime 源码也可先在独立候选中调整，再等待部署。

手工复测会使旧的效果 Review 失效。新的独立审查完成前，任务保持执行中，不能提前选择候选。对比评测优化继续保留独立留出集复核，留出材料不交给诊断或调整角色。

## 历史与验证边界

本次不转换、不删除历史任务、快照、候选、原始 Skill、评测报告或配置文件。历史页面按原格式读取和下载；历史通过结论不等于当前版本验收通过。

旧工作流专属测试和停用 UI 脚本随实现删除；仍覆盖当前流程的测试改接统一入口。新增或保留验证覆盖：单一进程入口、只读扫描、编译和契约工具、优化等待恢复、候选取舍、取消后进程退出、历史配置读取不改写文件，以及当前迁移页面流程。

离线模型替身和真实 SDK 接线测试只能验证执行链路，不能证明生产模型下的业务效果提升。

本次验证：类型检查、前后端构建、Vitest 全量回归、44 项 Python 测试、迁移页面及 Builder 页面回归均通过。最后将历史仓库收窄为只读读取器后，另行通过 10 项历史读取、服务配置及架构边界测试，并重新进行类型检查和后端构建。
