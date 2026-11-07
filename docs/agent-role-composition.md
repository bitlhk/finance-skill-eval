# Agent 角色与统一执行底座

当前业务后端已统一到 Python。迁移通过 Jiuwen Runtime 中的持久主 Agent 会话推进；对比评测保持固定程序，用户选择优化时调用现有优化协调 Agent。旧 npm 编程接口和 TS 后端已撤掉，HTTP 与 CLI 保留。完整调用关系见[当前架构](current-architecture.md)。

## 当前代码分工

| 位置 | 职责 |
| --- | --- |
| `web/src/features/migration/` | 现有迁移页面：输入、诊断、方案、候选、运行准备、验收、交付 |
| `src/migration/service.py`、`execution.py`、`execution_ports.py` | 唯一迁移任务控制链；接入主 Agent、Builder、评测和 Git 版本 |
| `src/migration/optimization.py`、`src/improvement/policy.py` | 迁移优化状态与公共目标、预算、取舍规则 |
| `src/improvement/service.py`、`engineering.py` | 对比评测后的独立优化；修改 Skill 与随包工具、复测、留出复核和人工采纳 |
| `integrations/openjiuwen/optimization_agent.py`、`optimization_coordinator.py` | 优化协调 Agent 与其原子工具的公共状态核验 |
| `src/evaluation/` | 案例执行与证据边界、评估方法接口 |
| `src/agents/` | 公共角色、指导加载、模型调用、输出校验和取消超时 |
| `src/resources/agents/v1/` | 版本化 Prompt、指导 Skill、输出合同、工具权限及交付模板 |
| `src/runtime/agent_client.py`、`integrations/openjiuwen/migration_runtime.py` | 通过 HTTP/SSE 调用 Jiuwen Runtime，复用其实例调度与会话恢复 |
| `integrations/openjiuwen/bundle_agent.py` | 统一工程任务合同、隔离工作区、受限文件工具、结构提交和候选冻结 |
| `integrations/openjiuwen/agent_execution.py` | 模型初始化、SDK Agent 装配、轨迹与实际权限核验 |
| `src/storage/history.py`、`src/api/history_routes.py` | 原格式历史记录与快照的只读展示、下载 |
| `src/runtime/service_environment.py` | 读取历史评测配置中的服务环境引用；不启动旧任务、不改写记录 |

历史记录中的 A1/A2/A3/A4 阶段编号仍可只读展示，不对应另一套可执行 Agent。公开数据合同在 `contracts/platform/`，运行规则在所属 Python 模块。

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
| migration 主会话 | 围绕用户目标调查、交流、修改、验证和交付 | DeepAgent / NativeHarness，按需读取 Skill，受限文件、工程执行、评测请求和工作产物工具 |
| migration_investigator | 独立调查复杂源码和证据 | 框架内只读子 Agent，不单独部署 |
| migration_delivery_reviewer | 独立核查交付范围、源码和基础验证缺口 | 框架内只读子 Agent，使用已配置 JUDGE 模型；读取冻结的工具登记和运行证据 |
| improvement-diagnosis | 根据冻结评测证据定位效果问题 | 独立 Agent，只有 query_evidence，不读取留出集 |
| adjustment | 联合修改 Skill、随包工具和授权工程源码 | 独立优化复用主工程 Agent；不让诊断者直接改文件 |
| criterion-judge | 根据真实执行证据逐项判断验收标准 | 独立 Agent，通过 query_evidence 查询冻结材料 |
| effect-review | 判断目标是否达成，或比较收益、回退及继续修复的价值 | 独立上下文，通过共享 Runtime 执行；单次目标模式不要求或虚构基线，不执行业务工具或改文件 |

角色表达不同职责；业务入口不再各自复制执行器。文档、工具、Runtime 是 adjustment 的可组合指导与权限，不是三个独立修改者。

角色清单声明 Prompt、Skill、参考文件和工具权限上限。Python 加载器只读取平台安装的可信资源并记录摘要。主会话使用 `migration-main.md`，SkillUseRail 暴露可信指导目录，由 Agent 自行选择和读取；不会按页面阶段强制替换 Skill。上传工程不能替换平台指导。

模型访问统一复用 `model_config.py` 的 OpenJiuwen SDK 装配；工程 Agent 装配在 `agent_execution.py`。角色注册表也保留当前底层消费者使用的只读分析、运行准备与提案配置，它们不构成第二条公开迁移流程。自然语言承接任务，真正需要程序执行的请求、文件和证据引用才做边界校验。格式修正不得改判业务结论或重复执行业务工具。

被测企业 Skill 的加载仍由其 Runtime 负责。平台的指导 Skill 与正在评测的业务 Skill 是不同资产。

## 公共能力的归属

- 源码扫描与只读调查只读取指定工程，不执行上传代码。
- 编译和工具验证：统一工程 Agent 提供 `compile_source`、单工具 `run_contract_test` 及联合 `run_mcp_contract_suite`，继续复用实际契约测试工具。
- 服务和脚本交付模板：迁入 `src/resources/agents/v1/references/service-templates.md`，标准化迁移和工程调整共同加载。
- 历史服务环境解析在 `runtime/service_environment.py`，继续核对候选摘要、配置版本、配置摘要及工具归属，区分普通配置和敏感配置；历史记录只读。
- Judge、诊断复用已有的宽容 JSON 解析，随后核对字段和冻结证据；不将 Markdown 代码块包装误判为业务失败。
- 页面通过 HTTP 接入 Python 服务，CLI 也调用同一套评测能力，不再保留 SDK 回调桥。

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

验证范围与旧 SDK 测试退役记录见[五步改造记录](backend-five-step-migration.md)及 `verification/python-backend-cutover.json`。完整工程上传通过、离线测试通过与真实业务迁移通过是不同的验收结果，应分别记录。
