# 企业 Skill 平台代码复用与分阶段改造计划

更新日期：2026 年 11 月 1 日。状态：待确认的实施计划。总体职责、扩展方式与页面流程见[企业 Skill 平台方案](enterprise-skill-platform-plan.md)。本计划以整个项目的有效调用和行为为基线，包含尚未合并的工作区改动。

## 实施原则

先统一职责和接口，再逐条替换调用，最后清理重复实现。页面未接入不能成为删除理由；后台仍调用的服务必须保留并纳入统一。没有使用者的代码也需核对兼容导出、测试目的和历史读取职责，不能仅凭文本搜索一次无结果就删除。

重构与能力扩展分别提交和验收。重构阶段使用相同材料和原规则核对等价；扩展阶段新增检查方式、诊断策略或优化行为，明确变化点。不能通过放宽权限、跳过原门槛或把未知改成通过让新流程看起来跑通。

当前本地的角色抽取属于待对齐试改，并非已确认架构。保留与最终方案相容的代码，重新审视固定角色数量、指导加载方式和仅摘要式效果评审；不覆盖其他工作区改动。

## 当前实际调用关系

| 调用方 | 实际路径 | 需要保留的事实 |
| --- | --- | --- |
| 对比评测页面 | App 内的 EvaluationView → EvaluationRunManager → runner / Promptfoo worker → RuntimeAdapter → Judge | 排队、环境装配、单候选与多种对比、事件和报告已有实现 |
| 对比后的候选改进 | OptimizationPanel → OptimizationManager → 文档候选 → EvaluationRunManager → 最终复核与选择 | 修改范围受限、原资产保留、候选环境重新绑定 |
| 当前迁移页面 | MigrationWorkspace → MigrationTaskPanel → /api/migration-tasks → MigrationTaskService | 整组工程、方案确认、生成修复、独立审查、环境与业务验收、下载 |
| 普通评测的内部环境解析 | EvaluationRunManager 的 resolveServiceEnvironment → MigrationStore → runtimeConfigurationService | 后台有效依赖，必须迁入 Runtime 公共能力后才解除原依赖 |
| 项目迁移服务体系 | MigrationStore → createMigrationServices → 诊断、规划、生成、验证、优化、复用验收等服务 | 调用与存储需逐项核对，不能整体判为废弃 |
| 项目迁移路由与组件 | migration-routes、MigrationPanel、MigrationAssessmentStep 等仍在仓库 | 当前 server 注册的是 migration-task-routes；路由定义存在不等于线上暴露，兼容责任单独审计 |
| Python 执行层 | OpenJiuwen worker、bundle agent、Runtime 实例与受限工具 | 真实工具执行、会话、加载证据、候选冻结、清理及进程取消必须保护 |

代码依据：[server.ts](../src/service/server.ts)、[run-manager.ts](../src/service/run-manager.ts)、[migration-store.ts](../src/migration/migration-store.ts)、[migration-composition.ts](../src/migration/migration-composition.ts)、[当前迁移装配](../src/migration/tasks/composition.ts)。

## 能力保留与归属清单

这张表是后续逐项替换的起点。阶段零补齐每项的直接与间接调用者、接口、存储、现有测试、最终归属和替换状态，作为可核验的迁入台账。

| 能力 | 当前实现依据 | 统一后的归属与要求 |
| --- | --- | --- |
| Skill 导入、包读取、版本与候选 | [skill-store](../src/service/skill-store.ts)、[task-repository](../src/migration/tasks/infrastructure/task-repository.ts)、[candidate-service](../src/migration/application/migration-candidate-service.ts) | assets；保留原始包、二进制与共享文件、单／多成员、导入候选和草稿能力 |
| 依赖识别与补充 | [inspection-service](../src/migration/application/migration-inspection-service.ts)、[supplement-service](../src/migration/application/migration-supplement-service.ts)、[task-runtime-inputs](../src/migration/tasks/domain/task-runtime-inputs.ts) | 诊断与运行输入分别归属；文件补充、解释、运行配置不能混为同一类缺失源码 |
| 源码及业务基线诊断 | [task-agent](../src/migration/tasks/infrastructure/task-agent.ts)、[task-standardization](../src/migration/tasks/domain/task-standardization.ts)、[project-service](../src/migration/application/migration-project-service.ts) | improvement 的诊断端口，迁移提供企业标准与业务基线策略 |
| 工具选型与方案确认 | [planning-service](../src/migration/application/migration-planning-service.ts)、[task-service](../src/migration/tasks/application/task-service.ts) | migration；保留 Script/MCP 选择、复用方案、修改前确认与版本失效规则 |
| 工程生成与修复 | [generation-service](../src/migration/application/migration-generation-service.ts)、[bundle_agent.py](../integrations/openjiuwen/bundle_agent.py) | improvement 改造端口与 OpenJiuwen 适配；保留共享工程、候选目录限制和真实文件交付 |
| 工具独立验证与实测 | [technical-validation-service](../src/migration/application/migration-technical-validation-service.ts)、[migration_tools.py](../integrations/openjiuwen/migration_tools.py) | runtime 执行、evaluation 检查、migration 适用政策；保留合同、错误语义、安全样例与真实调用证据 |
| 环境、配置与连接检查 | [environment-store](../src/service/environment-store.ts)、[runtime-configuration-service](../src/migration/application/migration-runtime-configuration-service.ts)、[execution-configuration](../src/execution-configuration/execution-configuration.ts) | runtime；保留凭据引用、配置验证、业务连接、MCP 服务解析以及现有后台消费者 |
| 原生工具绑定与能力复用 | [native-binding-service](../src/migration/application/migration-native-binding-service.ts)、[runtime-reuse](../src/migration/domain/migration-runtime-reuse.ts) | runtime 的绑定接口和 migration 的标准策略；不强制将注册工具改为 MCP |
| Builder 构建、重建、交付 | [task-builder](../src/migration/tasks/application/task-builder.ts)、[runtime-rebuild-service](../src/migration/application/migration-runtime-rebuild-service.ts)、[Builder 合同](../src/shared/contracts/runtime-builder.ts) | runtime 提供构建端口；迁移与优化都可请求，保留交付验证、过期和部署身份检查 |
| 测试集准备 | [preparation-store](../src/service/preparation-store.ts)、[run-questions](../src/service/run-questions.ts)、[suite-service](../src/migration/application/migration-suite-service.ts) | evaluation；保留固定、生成、导入、自然语言要求、多轮与文件材料 |
| 普通运行与多种 Judge | [runner](../src/runner.ts)、[promptfoo-worker](../src/promptfoo-worker.ts)、[judge](../src/judge.ts)、[goal-judge](../src/goal-judge.ts) | evaluation 调用 runtime；保留单候选、A/B、服务、Runtime 及方案比较，不强制统一评分算法 |
| 整组业务验收 | [task-acceptance](../src/migration/tasks/application/task-acceptance.ts) | evaluation 提供执行检查；migration 保留原业务要求覆盖与交付策略 |
| 跨环境复用验收 | [reuse-acceptance-service](../src/migration/application/migration-reuse-acceptance-service.ts) | migration 编排复用范围，evaluation 执行；保留确认、冻结、多环境、取消与证据要求 |
| 改进归因与假设 | [improvement-planning-service](../src/migration/application/migration-improvement-planning-service.ts)、[improvement-planner](../src/migration/infrastructure/migration-improvement-planner.ts) | improvement；拆开材料收集、证据校验与模型判断，服务三个场景 |
| 文档与工具候选优化 | [optimization-manager](../src/service/optimization-manager.ts)、[tool-optimization-service](../src/migration/application/migration-tool-optimization-service.ts) | improvement；保留两种权限范围，不扩大文档编辑器权限 |
| 多轮优化与外部等待 | [improvement-task-service](../src/migration/application/migration-improvement-task-service.ts) | improvement 的统一优化编排；保留轮次、基线、冻结测试、等待 Builder／配置、恢复与人工采纳 |
| 独立审查 | [candidate-inspection-service](../src/migration/application/migration-candidate-inspection-service.ts)、[task-agent](../src/migration/tasks/infrastructure/task-agent.ts) | improvement 提供审查接口，迁移和优化选择不同审查策略 |
| 交付与历史 | [task-export](../src/migration/tasks/application/task-export.ts)、[export-service](../src/migration/application/migration-export-service.ts)、[history-routes](../src/interfaces/http/history-routes.ts) | migration 交付，assets 与查询层提供历史；未验证下载、验证范围和发布限制保留 |

保留的是业务行为和约束，不要求每一个原函数名都保留。不同实现有矛盾时明确列出规则差异，不能静默选择更宽松版本。无法由测试或合同确定的业务差异须单独确认，不把重构当作隐式产品决策。

## 目标模块与接口

采用总体方案中的 assets、runtime、evaluation、improvement、migration、agents 模块。接口由消费方应用层或能力公开入口声明，装配层注入具体实现；shared 只保存跨模块稳定合同及通用工具。

| 接口职责 | 必需输入 | 必需输出 | 主要调用者 |
| --- | --- | --- | --- |
| 准备评测 | 目标、任务来源、要求、环境能力、判据版本 | 固定任务及检查计划、缺项 | 对比评测、迁移、优化 |
| 执行案例 | 方案版本、案例、环境、预算、取消信号 | 执行记录与证据引用、最终清理回执 | evaluation |
| 执行检查 | 检查版本、单侧／双侧／静态材料引用 | 状态、指标、证据与异常分类 | evaluation、迁移技术检查 |
| 诊断规划 | 任务目标、要求、源码与允许的运行证据、历史 | 问题假设、归因、动作与验证计划，或弃权 | 迁移、优化、评测报告 |
| 改造候选 | 父方案、修改计划、范围、执行权限 | 候选引用、差异、未完成项，或等待外部交付 | 迁移、优化 |
| 审查变更 | 原版、候选、要求、计划、真实证据 | 逐项审查结论、风险、未验证项 | 迁移、优化 |
| 选择与下一步 | 目标、候选集合、结果、审查、剩余预算 | 保留／拒绝、继续／等待／停止及依据 | 优化编排、迁移修复编排 |

所有耗时调用支持取消、超时、关联 ID 与版本记录。Agent 结果统一表达完成、弃权及结构错误，但各角色业务产物保持专用合同；不把评测结果、迁移方案和修改清单塞入任意 JSON。

诊断允许纯源码或基于运行证据两种输入形态。当前规划器依赖 sourceJobId 的部分由适配器收集，公共诊断端口不强制每次都有评测记录。Judge 可直接接收双侧证据；独立代码审查可以在实际业务运行前进行。

## 状态与存储的统一方式

以方案引用、验证计划、执行记录、检查记录、诊断计划、候选和实验轮次连接现有存储。先增量关联，不批量重写历史；迁移任务保留企业目标和确认流程，优化任务引用方案及验证计划，不嵌入完整 MigrationProject 或 BundleTask。

过渡期旧入口可以通过薄适配器调用新能力，同一业务命令只有一个权威写入方。禁止让一个操作分别更新两套任务状态而无一致性保证。对结果保存、候选激活和人工采纳采用版本检查与幂等键；长任务恢复先判断已执行到哪一步，不能重放可能产生副作用的业务调用。

历史记录提供读取及必要的显式转换，保留原 ID 和证据来源。继续执行旧任务时重新校验必需字段；缺失部署身份或验证材料时标记需要验证，不能补造已通过状态。原协议或 API 的兼容需求按消费者审计确定；没有注册的路由不因文件存在而自动重新暴露。

运行失败、业务失败、检查故障、证据不足、弃权、等待外部条件、预算耗尽、取消分别保存。取消后迟到的结果可以作为执行事实归档，但不能激活候选或采纳。重启恢复只恢复可证明安全的步骤，避免后台再次生成、重复写入或重复计费。

## 分阶段实施

每个阶段按小型完整调用链交付，并保留切换与回退路径。回退只影响新任务的实现选择，不覆盖已经保存的证据或在两个执行器中同时重放真实任务。

### 阶段零 全项目基线与接口确认

盘点路由、服务装配、后台回调、Python 入口、存储及测试依赖。将上面的能力清单细化为调用者—实现—行为—测试—目标归属台账，标记实际活跃、兼容、仅测试和待确认，不以新旧命名。

确认跨模块数据合同、资源生命周期、错误分类与角色任务；区分执行 Agent、平台诊断改造 Agent、Judge。登记现有工作区改动，审阅已经产生的角色试改，不直接覆盖或视为既定结构。

验收：每项有效能力有归属和验证方法；普通评测的内部环境依赖、Builder 等待、多轮优化及复用验收均在清单中。架构不要求重新接回另一套 UI。

### 阶段一 统一 Agent 与诊断改造接口

先抽出材料收集、诊断判断、候选修改及独立审查的接口。保留当前迁移的 ANALYZE、GENERATE、REPAIR、REVIEW 行为；复用现有改进规划器和文档／工具编辑实现。模型接入、指导加载、工具装配及组成记录归入 agents，企业政策仍由迁移场景提供。

指导资产版本化，但代码强制权限不随指导变更。原生 Skill 加载和无工具调用的预加载分别适配，记录实际选择与装载；不将所有 Skill 固定拼进 system prompt，也不强迫无工具编辑器变为工程 Agent。

验收：迁移和优化可调用同一诊断接口的不同任务配置；只读与可写权限不退化；完成、弃权、非法输出、取消、超时都有明确结果；每个候选能追溯指导和执行配置。此阶段不丢弃现有优化编排，调用方可以逐步切到新端口。

### 阶段二 统一 Runtime 执行与评测核心

先迁入服务环境解析与现有调用方，消除普通评测依赖迁移业务门面的倒置关系。保留 RuntimeAdapter 与 Launcher，明确资源属于整次运行还是每个案例；多轮对话保持同一实例，cleanup 和取消管理不重复。

提取执行记录、检查记录及公共评测服务，以适配器接入现有各 Judge、加载核验、文件核验和技术验证。保留 Promptfoo 的现有调度职责，先让它与迁移验收使用公共执行和检查，不同时更换框架与评分规则。

验收：单候选、A/B、Runtime／服务／方案比较和迁移验收保持原结果含义；一次执行可供多个检查使用；检查异常与业务失败分开；配置变化、运行身份、成员加载和清理回执仍被核验。固定证据回放验证适配，不为对照而重复执行真实写入任务。

### 阶段三 收敛迁移编排与数据关联

将源码诊断、依赖补充、方案确认、原生能力绑定、工程改造、Runtime 准备、技术验证、业务与跨环境验收、交付接到统一端口。收敛两套项目实现中重复状态转换；保留独立企业规则和有效后台消费者。

增加任务与方案、候选、验证计划、执行记录的关联。历史记录先可读，继续执行通过显式校验及转换接入。逐项解除原存储依赖后，才停止重复写入或删除对应实现。

页面延续七步：方案阶段准备验收要求，允许提前准备环境；技术检查与业务验收分清；候选变化后解释哪些证据失效。保持未验证下载与正式交付状态的区分。

验收：完成含共享工具的多 Skill 迁移、失败修复、Builder 交付、配置补充与跨环境复用验证；后台环境解析与相关历史查询保持可用。任何移除的实现都能对应到已验证的替代能力。

### 阶段四 统一目标优化过程

抽取现有多轮服务的预算、证据固定、候选选择、等待 Builder／配置与恢复规则，接入统一方案和评测端口；保留普通单轮文档优化。先使用原有选择规则做等价适配，再以独立策略加入效果审查、多指标选择和其他扩展。

对比页面默认最多一轮，迁移中的标准化修复保留其业务目标；标准化达标后另设效果目标启动优化。两种入口共享诊断、改造、评测、历史和预算能力。当前最佳可交付方案与探索方案分别管理。

验收：同一优化编排可针对文档、工具与 Runtime 改造任务；每轮有诊断和验证依据；等待后继续不丢历史；关键回归不能被总分提升掩盖；轮次、重复评测和内部 Agent 迭代分开；留出材料不会进入编辑上下文。

### 阶段五 增加评测扩展与企业交付

按企业案例依次增加通用脚本／外部验证、业务状态准备与恢复、重复可靠性、多轮用户模拟、Judge Skill、完整材料复评。增加最小自定义 Runtime 接入样例和能力自检。Builder 源码交付通过版本化扩展加入，绑定原工程、构建产物和受测部署。

每种扩展给出输入输出、证据需求、权限、副作用、超时、取消、成本和缺项处理。先实现代表性适配器再稳定接口，避免先做动态插件市场或配置语言。调用代码使用已注册实现与版本引用，任务输入不能指定任意可执行模块。

验收：新增一个检查器、Runtime 适配器或选择策略时，无需复制主流程；旧协议按原能力运行；未支持的状态观测和源码交付明确显示缺项。模拟结果不替代真实集成验收。

### 阶段六 优化策略自身评测

使用独立的优化任务集合比较指导版本，测量业务收益、成本、回归及弃权行为。复用普通优化、评测、候选和审查能力，目标资产变为优化指导，平台权限和评分不可改。

验收：策略可固定版本、比较并回退；改善来自多个任务的可验证结果；业务优化中途不会自动切换策略。该阶段对应 #28，不应作为完成基础重构的前提。

## 与三个 Issue 的关系

| Issue | 主责 | 协作与边界 |
| --- | --- | --- |
| #26 标准化 Agent 组成与职责 | 全项目角色盘点、诊断改造审查端口、指导与工具权限、执行实现与追溯 | 阶段零和阶段一为主；为 #27 保留所有有效调用，不以角色整理删除后台能力 |
| #27 统一底座与完善评测优化 | Runtime 与资产引用、评测核心、迁移编排收敛、普通优化循环及扩展 | 阶段二至五为主；与 #26 先确定合同，可并行迁入，不新增第四套业务模型 |
| #28 优化策略持续改进 | 策略任务、跨任务评测、版本选择与回退 | 依赖 #26 的指导版本和 #27 的评测优化能力；不承接被重构误删的基础功能 |

三个 Issue 的验收共同包含能力保留、现有页面连续性和架构边界。范围较大时用子任务或小型 PR 切片，保持三个目标不变。

## 验证矩阵

| 代表性场景 | 必须证明的行为 | 已有测试基础 |
| --- | --- | --- |
| 整组迁移与修复 | 多成员和共享文件完整，原版不变，候选冻结 | migration-bundle、migration-plan-workflow、Python test_bundle_runtime |
| 诊断与方案 | 不凭摘要补造方案，证据引用有效，原业务要求覆盖 | migration-standardization、migration-task-agent-output、migration-improvement-planner-output |
| 工具候选修改 | 仅授权文件、真实技术检查、失败不激活 | migration-tool-optimization、test_enterprise_tool_contract |
| 单轮文档改进 | 文档白名单、二进制保留、同环境绑定、无留出泄漏 | optimization-cycle、optimization-state-race、optimization |
| 多轮优化 | 预算、回归保护、外部等待、恢复与候选选择 | migration-improvement-task、migration-improvement-planning |
| Runtime 与 Builder | 实际部署与能力核对、过期失效、原生能力复用 | migration-task-builder、migration-runtime-rebuild、migration-runtime-reuse |
| 跨环境复用 | 固定验收范围与候选，不能用文本声明代替实际调用 | migration-reuse-acceptance、migration-reuse-acceptance-model |
| 运行与证据 | 多轮保持会话、完整与缺失证据有区别、异常可追踪 | runtime-launcher、runtime-launcher-stream、runtime-launcher-multi-turn |
| 取消与重启 | 取消后不采纳，进程及资源按归属清理，不重复业务副作用 | 既有取消／状态测试，加公共执行和优化恢复场景 |
| 历史与协议 | 原记录可读、不补造已验证结论、旧协议不意外失效 | migration-task-compatibility、runtime-builder-contract，加历史转换案例 |
| 前端流程 | 原导航与七步保留，状态来自证据，修复与优化目标明确 | migration-entry-progress、migration-activity-presentation，加现有 UI 脚本回归 |
| 架构与扩展 | 无循环和跨层依赖，新实现通过公开接口接入 | migration-architecture，扩展到全部公共模块 |

这些测试名是现有文件的基础定位，并不表示已覆盖全部目标。实施时为缺失行为补充必要测试。规则与适配使用固定证据；角色用受控模型替身验证边界；企业效果使用指定样本和真实 Runtime 在线验证，不能以离线测试替代效果验收。

## 前端代码收敛

保留现有 CSS、组件外观和业务导航，将 App.tsx 内联评测逻辑逐步迁入 features/evaluation；迁移继续使用 features/migration。复用 API 客户端、状态订阅、证据展示和优化轮次组件，不把两个页面合成一张万能表单。

公共显示状态由后端能力结果映射，保持“已生成”“能运行”“业务达标”“优化达标”“可交付”的区别。错误提示提供可执行下一步：环境错误进入环境配置，Judge 故障进入重评，业务缺陷进入诊断修复。用户可以查看历史过程，默认无需阅读内部 Agent 角色与调用 ID。

## 交付物与收尾条件

### 第二批实施：优化闭环与独立效果 Review（2026-11-01）

已接通两条现有页面入口：对比评测结果下的 Skill 改进面板，以及 Skill 迁移的“验证实际效果”步骤。两者使用 `src/improvement/application/optimization-loop.ts`，按“诊断 → 调整 → 复测 → 独立审查 → 选择实验起点”逐轮运行。用户设置目标、开发集目标通过率和最多轮次；默认一轮、最多五轮，页面默认 30 分钟时间预算。轮次耗尽、达到目标、弃权、需要外部调整、取消和故障均留下明确结束原因。

每轮保存基线、实验候选、复测记录引用、诊断假设、独立 Review、选择原因和 Agent 组成。Review 接收本轮起点、候选和此前推荐版本的实际执行证据与文件变化，不只是评分摘要。普通案例回退由 Review 结合目标判断，接受时需说明取舍；用户明确指定的必须通过案例仍由平台检查。实验候选不覆盖原资产，也不自动替换迁移任务的当前候选。

推荐版本与继续修复的起点分别记录。Review 的 `KEEP_CANDIDATE` 更新推荐版本并作为下一轮起点；`CONTINUE_CANDIDATE` 仅切换下一轮诊断、调整使用的代码与评测证据，并给出修复方向。预算耗尽时未获推荐的实验版本只作为实验记录保留。该语义同时接入对比评测、整组迁移及已有后台持续改进任务；后台 Builder 等待与恢复沿用对应实验版本。

对比评测继续使用原有 Skill 文档编辑器、Launcher 和评测任务。迁移继续使用原有整组代码 Agent、冻结候选、标准化审查和联合验收，可调整已有授权范围内的 Skill 与工具代码。Runtime 或配置问题进入持久化等待，完成后继续本轮复测与 Review；工程内有对应 Runtime 源码时先生成独立代码候选，再等待 Builder 构建交付。后台已有迁移持续改进任务的 Builder 等待／恢复能力保留，复用同一 Builder 准入能力，不另造交付协议。

现有页面新增目标与轮次设置、逐轮诊断和审查结果，以及“选择审查通过的候选”。导航、迁移七步与样式延续原设计。对比评测中手工重新复测会重新 Review；采纳前检查当前评测条件及留出集结果。已消费的留出题不能重新作为优化依据，取消和服务关闭会终止在途优化。

边界：这批完成的是正常候选优化闭环，不是 #28 的优化策略自我改进。未启用自动发布或部署；未知 Runtime 故障不会用改提示词掩盖。整组迁移支持 Builder／配置等待与同轮恢复；对比评测的文档编辑入口仍只改文档，工程与 Runtime 改造由迁移任务承接。评测方案本身需要修改时保持等待说明，但需停止原实验、重新确认方案后建立新任务，不能沿用被改变的验收标准。

等待与恢复：公共循环保存等待类型、实验候选、剩余时间和当前轮次。迁移任务冻结测试集、Judge、方案和原始候选；等待不占用时间预算或运行并发，服务重启不会重放调整动作。Builder 需求关联优化轮次和实验候选，带入诊断的能力合同；已知原交付时带入重建基线，拒绝同产物重放。原页面可下载工程源码与诊断、生成需求、导入交付并继续。恢复时核对输入与交付归属，重新执行开发集，记录受控的前后环境变化供独立 Review 判断整套方案收益；拒绝新方案时恢复此前推荐的配置和交付绑定，历史不删除。重复恢复请求幂等，等待可取消。

等待能力验证：全量 Vitest 161 个文件通过（1268 项通过、2 项跳过）；类型检查和核心／Web 构建通过。新增覆盖 Builder 等待、工程源码改造后交付、同轮恢复、重复请求、等待状态重启、冻结测试保护、配置等待与取消，以及 Review 拒绝新 Runtime 时恢复原配置和交付。`FINANCE_VERIFY_WAIT_BUILDER=1` 浏览器脚本覆盖单 Skill 与多 Skill 的工程下载、需求生成、交付准入、同轮复测、独立 Review、人工选择、留出验收、已验收导出和移动端布局。上述验证使用受控 Agent、Judge 与 Launcher，验证工程流程而非真实模型收益。

验证记录：全量 Vitest 161 个文件通过（1246 项通过、2 项跳过）；最后补充候选回执归属检查后，6 个相关文件的 68 项闭环与兼容测试通过。类型检查、核心与 Web 构建通过。`FINANCE_VERIFY_OPTIMIZATION_LOOP=1` 下的真实浏览器／API 测试覆盖目标和轮次设置、自动诊断修复复测、独立 Review、人工选择、已验收 ZIP 下载及移动端布局。Agent、Runtime、Judge 使用受控测试端口，验证的是工程闭环，尚未进行真实企业模型的效果验收。

目标驱动选择调整后的验证：全量 Vitest 161 个文件通过（1261 项通过、2 项跳过），类型检查与核心／Web 构建通过。新增覆盖普通回退的解释性接受、实验版本连续修复、与此前推荐版本对照、明确必须通过案例、预算耗尽不自动推荐，以及两条迁移流程和对比评测的实际版本／证据传递。随后补充手工复测有回退时重新由 Review 判断的断言，对比评测 5 项测试通过。浏览器脚本同时开启 `FINANCE_VERIFY_OPTIMIZATION_LOOP=1` 与 `FINANCE_VERIFY_REVIEW_CONTINUATION=1`，验证两轮“继续修复→推荐候选”、人工选择、已验收导出和移动端布局；仍使用受控 Agent／Runtime／Judge。

### 第一批实施记录（2026-11-01）

已抽出共享 Agent 执行层、改进诊断合同、逐项验收接口、Runtime 案例执行和执行证据检查。迁移诊断／实施／标准化审查、文档编辑、改进诊断及迁移 Judge 使用版本化角色声明；后两者的实际调用已从迁移文件中拆出并保存组成记录。对比评测与整组验收共用案例执行入口，现有实例生命周期和报告结构保持兼容。

角色指导、权限上限和超时由平台控制；诊断和 Judge 显式禁用业务工具。迁移 Judge 的指导内容纳入身份摘要，验收规则变更不复用之前的身份。对格式纠错保留原有判定约束，弃权保留明确原因，不伪造候选。

后续仍需完成：公共资产与环境装配、所有 Judge／验证器的接口接入、三种场景的统一编排及优化策略扩展、完整独立 Review、原有页面的流程状态接入。现有后台迁移服务与服务环境解析回调继续运行；本批没有删除这些能力，也没有将尚未接入的效果 Review 宣称为已完成优化闭环。详细入口见 [Agent 组成记录](agent-role-composition.md)。

本批验证：`pnpm check`、核心及 Web 构建通过；Vitest 160 个文件通过，1239 项通过、2 项跳过；Python 角色、整组 Runtime 和企业工具合同共 23 项通过。新增覆盖共享执行取消／失败证据、规则与 Agent 结果并存、角色超时、模块依赖边界及六文档候选兼容性。这些是离线功能回归，尚未进行真实企业 Runtime 和模型的效果验收。

交付完整的能力调用台账、模块职责与公开接口、版本化记录说明、扩展样例、阶段回归结果，以及维护文档。发布包和部署镜像包含实际运行依赖的指导资产、检查器与协议资源。

只有在替代调用、生效配置、存储读取、取消恢复、交付语义及测试均核对后，才移除重复实现。最终项目不靠新旧目录区分业务路径；维护者能从职责定位代码，后台和前台共享相同基础能力，新增评测或优化方法无需再复制整个服务。
