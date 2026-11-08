# 完整 Agent 工程接入（#27 首批实现）

现有迁移页面上传时选择 Skill 包或完整 Agent 工程。旧客户端未传类型时仍按 Skill 包校验，历史任务无需迁移数据。工程说明选填，不填写密钥。

Skill 包沿用原有 SKILL.md 校验；完整工程只经过公共文件安全、数量与容量校验，保留原始快照，不根据文件名自动登记资产。深层目录、嵌套示例或尚未规范的 Skill 不阻止导入。

上传完整工程后，页面启动 PREPARE。它是现有 BundleAgent 的一种任务模式，复用任务锁、取消、活动记录、角色装配、读写工具和快照仓库，不另建编排器。runtime-preparation 角色使用简短的指导 Skill，自行阅读入口、加载代码和依赖，选择必要适配与验证命令。平台只验证文件范围和输出结构，不规定技术栈或调查步骤。

准备结果与执行回执保存在 task.preparations；每次候选文件单独冻结，原始 source 永不覆盖。补充信息后继续从上次准备版本工作。重新准备会使当前迁移方案失效，历史方案保留。已有迁移候选后不再允许修改准备输入。后续诊断读取准备版本及报告，生成迁移候选时才进行严格的交付资产校验。

## 可复用的底层执行能力

`integrations/openjiuwen/project_execution.py` 的 execute_project_command 接收工程目录、参数数组、工作目录和超时，返回真实退出状态、有限输出及输入文件摘要。Agent 的 run_project_command 仅包装此能力，不包含业务决策或语言分支。

管理员需预置 Docker Linux 镜像并设置 `FINANCE_EVAL_PROJECT_EXECUTION_IMAGE`。镜像需提供 sh、cp、chown、setpriv 及项目所需运行环境；执行时不自动拉取镜像。容器启动时只使用必要的能力读取受限的只读工程目录并准备临时副本，随后清除全部 Linux capabilities，以 UID/GID 65534 执行用户命令。每次命令使用新容器，不提供网络、宿主环境凭证或 Docker socket，并限制时间、内存、CPU、进程数和输出。多步构建可由 Agent 使用一次 shell 命令组织；构建文件不带回，源码修改使用已有候选文件工具。缺少镜像或依赖会明确返回不可运行，而不降级到宿主直接执行上传代码。

Windows 开发环境可由管理员设置 `FINANCE_EVAL_DOCKER_WSL_DISTRIBUTION` 指定已有 WSL 发行版，并可选设置 `FINANCE_EVAL_DOCKER_WSL_USER` 指定有权访问其 Docker 的用户。发行版需要提供 `python3` 和 `wslpath`；平台通过标准输入传递命令参数、转换工程路径并调用 Docker，仍使用相同的只读挂载、无网络和资源限制；镜像需要预先存在于该 Docker 中。未配置时继续使用当前系统的 Docker 命令。

执行回执由工具生成，绑定执行时文件摘要，不由模型填写。后续编辑可能让回执与最终准备版本不同，不能把旧回执当成最终版本验证。生产执行环境还需按企业部署要求管理镜像、依赖和外部访问；本次未接入凭证或网络授权管理。

## 当前边界

工程准备后可在原页面选择基线 Runtime、模型和测试集，执行正式业务基线。BASELINE 与迁移验收调用同一个 acceptMigrationTask，复用 Runtime 工厂、executeEvaluationCase、evaluateMethods、checkExecutionEvidence 和现有 Judge，以及实例清理和证据报告。不会把准备命令的输出当作业务答案。

基线配置与迁移候选配置分别保存，测试集复用现有 schema、编辑器和存储。每次基线绑定准备版本、完整工程摘要、配置、测试集、Judge 标识及实际环境快照；run.purpose=baseline，记录在同一 runs 历史中。业务 FAILED 也可建立基线，Runtime、执行证据或 Judge 不完整则为 INCOMPLETE。重新准备或改变配置/测试集/Judge 后旧记录保留，不再标为当前基线。基线通过不授予迁移导出或候选验收资格。

## Launcher 的完整工程执行约定

沿用现有 capabilities、instances、execute、cleanup 接口和 RuntimeExecutionEvidence，不新增执行服务或 Trace 格式。兼容扩展如下：

- Launcher 在 features.projectExecution 明确声明支持原工程；缺省视为不支持。
- 创建实例传 executionMode=agent_project、skills=[]、assets=完整工程文件、contentDigest=冻结工程摘要。configuration/secrets、测试文件及多轮输入仍使用现有字段。不注入合成 SKILL.md、替代 Agent 或 Harness 工具。
- 支持方需按原工程入口和实际依赖启动 Agent，保持原有工具/Skill 加载行为。可以使用工程准备阶段交付的适配代码；原工程改造不交给外部 Builder。
- execute 返回实际业务输出与证据，metadata.projectExecution=true、contentDigest、instanceConfigurationDigest 和 workspaceFilesDigest 必须与实际运行匹配。loadedSkills 可报告原工程实际加载的内部 Skill，无需冒充平台注入成员。进度/原生事件和 Trace 沿用现有 Runtime 观测通道；此标识本身不替代底层执行证据。
- 原有仅支持 Skill 装载的 Launcher 不会被自动视为支持工程执行。平台目前不内置任意工程的自动部署器；需接入或适配真实支持该能力的 Launcher。缺少能力时记录未完成原因，不回退到用新 Agent 模拟旧工程。

正式基线复用已有执行规则校验和 Judge；业务基线本身不代表已完成等价迁移。以下评测能力同样供迁移验收、优化复测和对比评测使用，页面延续原设计。

## 过程与产物证据

三种接入均遵守 [Runtime 公共接入合同](../src/resources/agents/v1/references/runtime-integration.md)。现有 execute 返回 metadata.process，声明 processEvidence，不要求 OTLP、公网接收端或新接口。准备 Agent 复用原工程回调、消息或流式事件；非流式只有最终答案时，在执行侧采集后汇总返回。原工程的 OTel 可继续使用，但不是平台前置条件。

COMPLETE/PARTIAL/UNAVAILABLE 仅描述声明范围内的采集状态。缺失和截断必须说明，远程工具内部埋点不是要求。平台沿用证据索引 /process、产物 metadata.artifacts 和业务状态 metadata.state，复用既有 Judge、诊断和 Review。历史 telemetry 不删除或改写。

Builder 仍只构建新 Agent，构建能力要求 processEvidence；完整工程适配由 runtime-preparation Agent 完成，不新增固定工作流。
## 可组合的检查

每个测试案例可增加 `evaluationPlan`。不提供时保留原规则和模型 Judge。示例：

```json
{"version":"1","checks":[
  {"id":"amount","version":"1","kind":"RULE","rule":{"operation":"equals","reference":"/output","expected":"42"}},
  {"id":"receipt","version":"1","kind":"SCRIPT","evidenceRefs":["/artifacts/0/content"],"script":"import json\ne=json.load(open('evidence.json'))\nprint(json.dumps({'checks':[{'id':'receipt','status':'PASS' if '42' in e['artifacts'][0]['content'] else 'FAIL','reason':'Check actual receipt','evidenceRefs':['/artifacts/0/content']}]}))"}
]}
```

支持 RULE、SCRIPT、STATE；STATE 使用同一验证器检查已保存业务状态，不另建业务连接器。规则支持 equals、contains、exists、numeric_tolerance、set_equals。每项有 version、required（默认 true）、evidenceRefs、timeoutMs。证据引用是 JSON pointer，可读 /output、/process、/toolCalls、/toolEvidence、/artifacts、/state、/usage、/execution。需要证明调用覆盖时，应同时检查 /process/status 等于 COMPLETE 且 scopes 包含相应范围，不能仅从空调用列表推断未调用。旧 /telemetry 仅供历史证据兼容。

脚本仅在管理员镜像中运行 Python，读取 evidence.json，输出 `{"checks":[{"id":"...","status":"PASS|FAIL|UNVERIFIED","reason":"...","evidenceRefs":["/output"]}]}`；score 可选且为 0–1。非零退出、超时、无效 JSON 属于 ERROR，而非业务 FAIL。未提供所需证据属于 UNVERIFIED。每个验证器使用隔离的临时副本，不能修改已保存证据；没有 Docker/镜像就明确报告不可用，不退回宿主执行。

## Judge、诊断与重新评分

criterion-judge 与 improvement-diagnosis 使用只读 evidence-model 执行配置，加载各自原有 Prompt、Skill 和参考资料，增加 query_evidence。它通过结构化工具请求查询冻结材料（JSON pointer、分页），不注册业务工具；最多 7 次查询加一次结论，整次调用仍受角色时间预算约束。Judge 按评分项返回引用，缺少材料时 passed=null；不存在的引用不被接受。诊断可按需读完整工程代码、当前和基线案例，区分业务、工具、Runtime、输入和评测缺陷。查询及模型用量记录与结论保存。

正式运行和重新评分都调用相同评判函数。`POST /api/migration-tasks/:id/rescore` 接收 runId 和可选 evaluationPlan，保存独立重评记录；原测试输入和原执行证据保持冻结。旧记录缺少要求定义时明确要求补跑。重评不修改 verifiedRunId、不采纳候选，也不重新运行业务。对比页通过 `POST /api/runs/:jobId/rescore` 使用已冻结完整评判方案重新评分；旧报告没有完整方案时不从现有配置猜测。

现有结果卡展示分项判断、已完成评判数量、Trace 覆盖范围、产物和历史重评。ERROR、SKIP、UNVERIFIED 不计为通过；可选质量检查保留结果，强制检查会影响验收。独立效果 Review 继续决定候选采纳，不由单个模型评分替代。

## 回答质量与执行检查分离

量表项可指定 `scope: answer | execution`。迁移测试集使用与 criteria 一一对应的 `criterionScopes`，现有编辑器可逐项选择。历史未标注项目继续作为执行与业务验收，不自动猜测其含义。显式标记的回答质量项目与执行项目分别调用同一 Judge 角色，分别保存结果；任一必需检查失败时不能用回答质量抵消。

回答质量调用仅获得任务、判据、最终回答与明确选择的业务事实，query_evidence 也只可访问这些材料。对比与候选质量 Judge 使用同一投影。执行检查保留调用过程与原始证据访问。原有专业目标／工具合同 Judge 仍属于执行验收，其材料权限不作为匿名回答评分的权限。

需要核对实际金额等事实时，方案可定义 `answerEvidence: [{"id":"amount","reference":"/state/amount"}]`，或选择 `/toolEvidence/0/result/amount` 等叶字段。只有有界字符串、数值和布尔值可以进入回答评分，禁止传递整个工具结果、Trace 或执行日志；失败或截断的工具结果不当作成功业务事实。提取规则版本、来源引用和可用性另存，不转发过程来源给回答评分。回答本身或业务值仍可能泄露身份，不能保证完全盲评。

当前 Judge 策略使用 separated-assessment-v1，新旧结果分开保留。修改判据范围后需用统一标准重评基线与候选。该实现及自动请求隔离测试不替代 #24 要求的真实模型校准与对照实验。

## 独立问题分析和重复评判

基线与验收报告提供“分析本次评测问题”，调用 `POST /api/migration-tasks/:id/analyze-run`，输入 runId。分析读取该次运行冻结的工程快照与开发集证据，与优化循环共用输入构造和 improvement-diagnosis Agent；不调用业务 Runtime，不修改工程，不采纳候选。报告绑定运行和工程摘要并另存，可取消。留出集不进入修改诊断，防止独立入口绕过优化的材料隔离。

两个重评接口均接受 repetitions（1–5，默认 1），重复的是固定材料的 Judge／检查，不是业务执行，更不是优化轮次。对比重评还可指定 alternateOrder，支持的双侧质量 Judge 会交替交换实际 A/B 输入，并将结果映射回原左右侧；其他 Judge 明确拒绝该选项。每次记录分别保存，显示有效判定一致率和覆盖率，异常与无法判断不从总次数中剔除。重复一致不等于判断正确；业务重复运行和业务状态恢复是独立能力，见下节。

现有测试编辑器提供规则、脚本、状态检查卡片，保留高级 JSON。规则现支持完全相等、包含、存在、数值容差与集合相等。数值容差不把字符串强制转成数值；集合比较忽略顺序和重复项。复杂业务状态仍由脚本检查，缺少状态时保持无法验证。

## 业务初态、最终状态与恢复

案例可配置 `stateFixture: {fixtureId, version, initialStateDigest}`。它引用测试环境中已登记的版本化初态，摘要按项目 canonicalSha256（规范化 JSON）计算，不允许填写任意重置命令。Launcher 须在 `features.caseStateLifecycle` 声明支持；程序在执行业务前检查能力，旧 Runtime 不会忽略要求后继续执行。自定义 RuntimeAdapter 可实现 supportsCaseState，并在 execute 返回同一回执合同，平台仍校验关联和摘要。

Launcher 适配器复用原实例，在其串行执行区调用 `POST /v1/runtime-instances/{instanceId}/case-state`。请求包含 schemaVersion=finance.case-state.v1、operationId、runId、caseId、side、fixture 和 phase（prepare / capture / restore）；调用与回执核验实现在 `src/runtime/launcher.py`、`src/evaluation/case_state.py`。响应回显关联字段，并提供 status、stateDigest、可选 state 与 message。prepare/restore 的摘要必须与指定初态一致；capture 必须返回真实状态内容及匹配摘要。版本或关联不一致都不算完成。

测试环境负责将 operationId 绑定到专用隔离空间或排他租约，不能让并发左右侧相互重置。prepare 应同时准备干净的业务初态和该次会话；capture 读取允许采集的业务状态；restore 恢复初态并关闭该操作。三者必须幂等，关闭后迟到的 prepare 不得重新修改状态，且服务应能处理请求丢失与租约过期。相关服务及凭据由环境配置管理，不注册为业务 Agent 工具，不要求 Agent 自己恢复。该接口需要真实 Launcher／测试环境实现，本仓不会假装已能重置任意企业数据库。

即使业务失败或用户取消，程序仍尝试采集和恢复；准备最多 30 秒，采集和恢复分别有独立的 10 秒预算。恢复失败会阻止该 Launcher 适配器后续业务执行。状态回执随案例和最终清理记录保存；资源释放不代表业务恢复。依赖恢复的迁移任务会停止后续案例与重复运行。状态缺失、摘要错误或恢复失败使执行验收不完整，不能用于交付通过。

## 业务重复运行

迁移测试集可配置 executionRepetitions（1–5，默认 1）。基线、候选验收和优化复测复用 acceptMigrationTask，逐次执行原有完整测试集；每个案例仍有独立 Runtime 实例。每次记录保留原 ID、配置、测试集、Judge、初态及产物关联，通过 repetition 的 groupId/index/total 组成一次实验组。

重复运行要求所有开发和留出案例都有 stateFixture，或由用户明确声明 repeatSafety=read_only。只读声明是用户对场景的约束，不是平台证明请求绝无副作用。出现运行／证据／评判不完整时停止后续次数；失败的业务判断可以保留并继续下一次明确授权的测试。不同配置、Judge 或 Runtime 环境的记录不能组成同一完整组。

验收要求整组次数齐全且全部通过；最后一次通过不能覆盖前面的失败。优化与诊断读取同组结果。页面展示通过、失败、缺失／无法验证次数，所有计划次数都留在分母；这里只报告样本结果，不把有限次数的一致性宣传为概率保证。对比页面可选择 1–5 次业务运行，并明确确认全部案例只读；未声明只读时，后台要求全部实际运行案例配置 stateFixture。冻结证据回放不能设置多次业务执行。题集和 Judge 在实验组开始前冻结，每次复用 runEvaluation 和 Runtime 工厂，各自生成运行 ID、证据、回收记录与报告。页面逐次展示结果，未执行次数保留；主报告为最近一次完成的运行，不能代表整组。取消、运行异常和判定不完整阻止后续次数；优化输入汇总全部计划次数，失败或缺失不能被最后一次通过覆盖。重评和人工复核入口目前仍针对主报告，逐次报告以只读证据展示。

## 人工标注、校准与争议复核

迁移基线／验收报告和对比报告共用“人工标注与 Judge 校准”卡片，以及 GET/POST `/api/evaluation-reviews`。仅私有工作区开放，沿用原工作区访问鉴权。source 为 `{kind:"migration",id:taskId,runId}` 或 `{kind:"comparison",id:jobId}`；GET 返回冻结材料摘要、可标注判定项、当前及历史意见和统计。

POST 接收 `{source,sourceDigest,entries}`，支持一次导入 1–200 条。每条记录包含 targetId、reviewer、kind（ANNOTATION 或 ADJUDICATION）、outcome、reason、evidenceRefs。结论按目标限定为 PASS/FAIL/UNVERIFIED，或左右侧偏好 left/right/tie/UNVERIFIED。引用必须存在于该案例保存的材料中；整个批次通过校验后才保存。页面提供当前报告的导入模板。

同一标注者修订时必须提供 supersedes 指向其当前意见；历史不删除。不同标注者存在分歧时，争议复核记录用 resolves 引用全部当前意见。出现新的标注或修订后，旧复核结论不自动覆盖新分歧。标注者名称为自行填写，当前没有宣称它是已认证的专家身份或新增组织权限体系。

记录以报告摘要绑定，来源变化后旧意见保留但不计入新材料统计。人工意见存于独立 evaluation-reviews 仓库，不覆盖机器判定，不修改 verifiedRunId，不触发候选采纳、模型调优或业务重跑。留出集复核意见不会自动进入修改 Agent 的输入。

统计按案例、评分标准、两侧偏好、检查方法分组，报告已标注／未标注、分歧、机器未判定、人工无法验证及可比较项的一致率。分歧和无法判断不算机器正确，也不静默混入一致率分母。该一致率衡量所选标注样本的判定一致性，不等于全测试集准确率或人工标注必然正确；现有人工复核卡片同时展示重评版本的跨 Judge 校准。仅将证据摘要匹配、判据未变化的重评与原标注比较；按案例 ID、判定范围和标准标识匹配，不依赖数组顺序。重复重评逐次展示，缺失判定项仍保留在覆盖统计，新增项单独列为未标注。判据变化、证据关联不明或标识重复的版本明确标记不可比较。人工意见不会复制到新报告或改变原判。这里使用重评已记录的 Judge 身份，不新增模型选择或自动调优；真实专家校准实验仍需后续开展。

## AgentScope 示例工程接入检查

已检查 agent-project-example：源码包含 4 个 skills/*/SKILL.md，app/agent.py 负责注册 Skill、读取指令和装配 Python 工具，app/main.py 提供会话与聊天接口。已用现有 MigrationTaskService 上传并读回 27 个源码文件，冻结快照一致；排除了本地密钥、数据库、日志、虚拟环境与缓存，未修改原工程。该检查仅验证完整工程导入，不代表 Agent 准备或业务基线通过。

工程准备 Agent 应保留原 AgentScope 执行入口和用户确认流程，适配现有 Runtime Launcher 的工程执行合同。原工程的 OTel 可以保留，但接入平台应在 execute 响应汇总 metadata.process，不依赖平台接收异步导出。会议室写操作需要隔离的业务初态与恢复，会话删除不能代替撤销会议室预订。正式基线仍需兼容运行环境和 Launcher 证据适配；此前命令回执与埋点试验不能替代业务基线。

公共接入要求已收敛到 [Runtime 公共接入合同](../src/resources/agents/v1/references/runtime-integration.md)，并作为工程准备 Agent 的实际加载资源。Builder 和工程 Launcher 共用能力检查，命令行入口为 `pnpm runtime:check`。

### 真实过程联调

运行 `pnpm build:core` 后执行
`node --env-file=.env.local scripts/verify-project-process-live.mjs <AgentScope示例工程目录>`。
此脚本使用平台已有模型配置调用真实模型，在临时完整源码副本中启动原 Agent HTTP API
和独立会议室 HTTP 服务，使用独立数据库；不修改原工程。测试桥仅适配该示例工程，
不是通用工程运行器，也不替代 Builder。

联调经过真实 Launcher HTTP 生命周期、共享 executeEvaluationCase、接入校验、
Criterion Judge 和证据文件保存。用例仅查询 U001 的地点权限，预期 A座、B座。
现有 Agent API 返回的工具事件缺少参数和明确状态，因此按 event 原样纳入 process，
标记 PARTIAL；不伪造工具终态。Judge 可依据已返回的查询结果判断当前标准，
不能据此证明未发生其他调用。报告保存在命令输出的临时路径，失败判定也保留报告。

该检查不覆盖页面上传、准备 Agent 自动改造、远程 Builder 部署或迁移优化全流程；
这些阶段不能因本检查通过而宣称验收完成。

`node scripts/verify-external-agent-otel.mjs <本地 AgentScope 工程目录>` 是保留的历史 OTLP 试验脚本，不是新接入验收步骤。统一验收使用 `pnpm runtime:check` 检查 Launcher 能力与实际 execute 响应，再通过现有业务基线入口运行任务。

### 中断后的工作草稿

迁移生成和修复 Agent 成功修改工作文件后，平台将未验收的草稿保存到当前任务的数据目录。任务因超时、服务重启或其他错误中断后，重新发起同一操作时，可自动恢复匹配的最近草稿；源文件、基础版本、目标、方案或反馈发生变化时不会复用。活动记录会提示恢复情况。

草稿只用于继续工作，不是正式候选，不代表契约测试或独立 Review 已通过。用户主动取消或完成该操作后开始的新工作不会自动续用此前草稿；正式候选仍需完整提交、检查和冻结。草稿属于任务数据，应随工作区数据一起保护和备份。

迁移配置可通过已有 Launcher 合同的 `runtimeToolConfig` 声明工具请求头与运行上下文绑定，与对比评测使用同一能力。敏感值只能填写 Runtime 侧环境变量引用，不保存在任务配置里；非敏感的测试身份可作为固定值。该配置按运行实例确定，不能单凭它证明同一实例中多用户逐次调用的身份隔离；需要分别执行案例并保存实际证据。Builder 需求只包含所需能力，不包含这些业务上下文值。

原工程从登录态或 Header 取得身份时，迁移产物应保留请求级身份边界。Runtime 通过现有 `contextBindings` 或已登记的企业 `authProvider` 为每次 MCP 调用构造独立 Header；MCP 从当前请求读取，不把用户固定在服务进程环境中、不缓存最近用户、不要求聊天补报，也不把身份放进业务参数。部署方负责让身份来自经过认证的登录/会话上下文，不能直接信任外部自报 Header。缺失身份应明确失败且不产生业务写入。基础验证应使用同一个 MCP 服务进行双用户交叉与并发调用，核对权限、订单归属和缺失身份的拒绝行为；这些工具边界测试与模型驱动的业务效果评测分别记录，不能相互替代。
