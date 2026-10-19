# Skill 统一迁移与任务验收（单 Skill / 多 Skill）

## 使用方式

在「Skill 迁移」直接新建任务。一个任务导入 1–10 个 Skill，无需选择单 Skill / 多 Skill 模式；
同一个迁移 Agent 读取完整源码，可以同时修改多个 Skill、共享工具与入口指令。
每轮产出一个冻结整组候选，联合验收直接使用这个候选，无需到独立评测入口重新组装。

保留七个阶段：

1. **选择 Skill**：填写任务名称、业务目标、目标平台与约束。可选已有资产、导入多个 ZIP/Markdown，
   或上传包含所有 Skill 和共享源码的工程 ZIP。整组工程保留相对目录；独立资产分别置于 members/member-N 下。
2. **诊断与迁移方案**：Agent 读取全部成员和共享源码，输出整体方案、变更范围和缺失信息。
   缺失信息只指阻止实施迁移、需要用户补充的内容；目标明确由运行时提供的业务数据，以及未要求的调度文件或 README 不应阻止生成。
   真实信息缺失时补齐工程重新导入；此版本尚无任务内源文件补充编辑器。
3. **生成迁移结果**：跨 Skill 改造并冻结完整候选。页面按文件展示前后内容和候选历史。
   静态入口、frontmatter、路径、服务文件与工具名称检查通过只表示清单有效，不表示业务验收通过。
4. **Runtime 适配与登记**：选择已登记 Launcher、模型、可选文本入口指令和案例时限。
5. **验证能否运行**：检查 Launcher 的 multiSkill 能力、模型、容量和服务支持；
   实际启动、脚本/MCP 调用仍由联合验收验证。
6. **任务验收**：保存任务级测试集，用整组候选运行。失败后可点击「让 Agent 查看整组并修复」，
   生成新候选并整组重测。
7. **下载结果**：导出全部 Skill、共享文件、候选清单及有效验收报告。
   未通过的版本只能作为候选材料导出，不标记为已验收。

单 Skill 是只有一个成员的同一流程，多个成员时进行整组联合验收；不要求每轮修改全部成员，也不要求每个案例调用全部成员。

旧任务从「旧版任务记录」访问，可保留原流程继续处理或复制选定资产转入统一任务，旧结论不会继承。既有整组任务直接出现在统一任务列表。代码与排障入口见 [当前架构](current-architecture.md)。

## 输入格式与边界

每个成员需要独立的 SKILL.md，YAML frontmatter 含非空字符串 name、description。
成员名称不能重复，入口不能嵌套。整组 ZIP 上限 8 MiB，展开后上限 32 MiB / 1000 文件。
目标 Runtime 有自己的容量限制，以能力检查为准。文件支持文本和二进制资源。

已有共享源码放在原有位置即可，不要求创建 orchestration/。
如果有供 Agent 使用的文本调度指令，可在运行配置中指定其工程相对路径。
第一版由原生 Agent 动态选择并使用多个 Skill；不解析或执行任意工作流引擎配置，
不将多个 SKILL.md 拼成一段大提示词，也不强制每个任务使用全部成员。
现有工作流若必须由专用引擎执行，需要单独的 Runtime 适配，分析时应报告这个缺口。

包内 MCP 的真实启动参数、文件清单和工具名由迁移 Agent 交付。已有外部 MCP 通过登记的执行环境绑定。
需要额外业务凭据或上下文的服务仍须在执行环境侧完成配置；不要把真实密钥写进源码或测试集。
托管账号沿用平台工具准入政策，不因整组模式放开自定义 MCP、脚本或 Harness 执行。

## 工作区与产物

迁移进程建立独立临时工作区：

```text
source/       原始完整源码，文件工具只读
candidate/    当前候选完整副本，Agent 可跨成员编辑
task/         成员清单、业务目标、目标约束、已确认方案及开发反馈
```

读/搜索工具可查看整个工作区，写/编辑工具只能写 candidate/。
分析阶段使用只读 Explore Agent，生成和修复阶段使用 Code Agent。
迁移阶段不开放通用 shell，只提供专用编译检查；整组尚无单工具合同注册表，
因此不挂载会始终返回 UNKNOWN_TOOL_CONTRACT 的单 Skill 契约测试工具。实际业务调用在联合验收时执行。
非空模型回答只有 JSON 格式损坏时，最多进行一次不带工具的真实模型格式修复；
空回答、执行错误和预算耗尽继续报告失败，不生成替代结果。
不将业务源码中的 skills/ 误当作 Agent 自身目录过滤掉。
生成失败或取消不会发布半个候选。进程临时工作区清理后，原始源码、已发布候选和失败状态仍由服务保存。
失败尝试重新发起时从上一个已发布候选重建工作区，不承诺恢复 Agent 未交付的临时修改。

持久化位于每个账号数据目录的 migration-bundles/：

- tasks/：任务、候选清单、尝试和验收记录。
- snapshots/：原始及各候选的完整文件快照，内容以 base64 保存。

成员内容未变化时继承成员版本与摘要，但每轮整体交付使用独立候选 ID。
共享文件属于整组摘要，即使成员摘要不变，共享依赖变化也会产生新的整组候选。
相同内容的不同迁移尝试仍是不同候选，报告不会自动转移。

## 联合验收与修复

测试集复用现有自然语言验收格式：

```json
{
  "name": "采购审核",
  "cases": [
    {
      "id": "over-budget",
      "input": "审核申请金额 8000 元、可用预算 5000 元的采购。",
      "criteria": ["明确指出预算不足 3000 元。", "不得声称申请已经批准。"]
    }
  ],
  "holdoutCases": [
    {
      "id": "boundary",
      "input": "审核申请金额等于可用预算的采购，说明判断依据。",
      "criteria": ["正确处理等于预算的边界。"]
    }
  ]
}
```

cases 和 holdoutCases 各最多 8 题，支持 workspaceFiles 提供案例数据。
每题创建独立 Runtime 实例，整组 Skill 在同一实例中可用，案例之间独立运行。
实际业务事实由执行模型取得；Judge 按每项标准判断，缺证据不能通过。
多轮案例仅在目标 Launcher 声明 multiTurn 时可执行；当前内置 Worker 不声明该能力。

每次验收冻结候选、运行配置、模型、环境能力及测试集。
已装载成员由 Runtime 实测回执核对，Skill 激活与工具调用单独查看，不能把装载等同于调用。
取消、模型失败或未完成案例不算通过；工具失败的真实证据交给 Judge 按业务标准核验，不能用工具已装载替代成功调用。
回收信息保留 Runtime 实际回执；缺回执记录 UNKNOWN，不宣称资源已释放。

开发验收失败时，迁移 Agent 接收该次任务和真实结果/断言反馈，能够修改任意相关成员。
测试集与留出案例不会整体挂载进迁移工作区。留出失败不直接用于自动修复，
需通过开发回归案例重现；本系统不声称用户手工复制过的案例仍然保持独立。

当前实现手动触发「整体修复 → 整组重测」，不自动无限重试。
同一任务一次一个操作，进程内整组操作上限 2，重试 key 幂等且绑定完整请求。
重启会将未结束尝试标记 INTERRUPTED、未结束验收标记 INCOMPLETE，重新发起不会覆盖历史。

已验收导出要求当前候选、配置和测试集一致，最近匹配运行通过；
有留出案例时最近匹配运行必须为留出验收。导出前再次检查环境版本与能力；
环境变化需重验。下载成功不表示已经部署。

## Runtime 接入

Launcher 保留 v1 单 Skill 接口，同时在 features 声明 multiSkill: true，
接收 finance.skill-eval.runtime-instance.v2。详见
[v2 合同](../contracts/runtime-launcher/finance.skill-eval.runtime-instance.v2.schema.json)。

v2 保留 /v1/runtime-instances 传输端点，用 schemaVersion 协商内容：
skill 为 null，bundle 包含完整 ZIP、ZIP 摘要、整组摘要和成员清单。
Worker 校验整个 ZIP 和每个成员内容，再按各自入口装载真实框架 Skill。
内部用于 MCP/Script 的包视图不是对模型公布的合并 Skill。

内容摘要算法：路径按 Unicode 码点顺序（等价有效 UTF-8 字节排序）排列，
依次散列 UTF-8 路径、NUL、原始文件字节、NUL。成员摘要覆盖入口所在目录的所有文件，路径仍相对整组根。

证据 metadata 必须返回 bundleDigest 和 loadedBundleMembers，
且与 requested bundle 的 id、skillId、version、skillFile、artifactSha256 完整匹配。
缺失成员、错误摘要或不同配置的响应不能通过。

内置 OpenJiuwen Worker 已接入原生多 Skill rail。成员按清单 skillId 注册，支持多个包都以 skill/SKILL.md 为入口；
实际目录保持不变。每题独立副本，运行中改写已装载源码会使证据失败。
验收执行器不得临时修补候选代码，也不得通过复制后修补、猴子补丁或重新实现绕过候选缺陷。
Worker 同时检查包内原件与业务工作区同路径副本的字节一致性，案例显式提供的输入数据不受副本检查影响。
Judge 根据完整工具证据检查其他运行时修补行为；修补后得到正确答案仍判失败，交由迁移 Agent 修改新候选后重新验收。

## 接口与测试

新客户端统一使用 `/api/migration-tasks`。`/api/migration-bundles` 作为同一服务的兼容别名继续可用；旧 `/api/migrations` 保留历史功能。`POST /api/migration-tasks/from-legacy/:id` 接收 name、goal、target、selection（source/candidate），复制旧资产新建任务并记录 origin，不修改旧记录。

磁盘 `migration-bundles/` 与 `finance.skill-migration.bundle.v1` 保持不变。新增 requestId/agentRunId/origin 都是可选字段，旧记录不需要离线转换。Runtime v2 成员下限由 2 扩展为 1，API 和 Runtime 需一起升级。

### 部署升级

同时部署新版控制服务、前端与 OpenJiuwen Launcher/Worker，重新启动 Launcher 后检查
capabilities 的 multiSkill 字段。只更新前端不能使旧 Runtime 获得多 Skill 能力。
旧单 Skill 任务的数据和 v1 调用继续保留，无需迁移历史数据。

迁移 Agent 复用既有 MIGRATION 模型配置、FINANCE_RUNTIME_CONFIG 和 Python 环境；
可通过 FINANCE_EVAL_MIGRATION_PYTHON 指定解释器，通过 FINANCE_EVAL_MIGRATION_PROJECT_ROOT
指定服务代码所在目录。整组 Agent 使用 FINANCE_EVAL_AGENT_MAX_ITERATIONS 的预算，
默认 120 轮，不按单个工具的数量缩减。联合验收仍分别使用所选 Launcher 执行模型与 JUDGE 配置。
未配置模型时会显示未完成原因，不生成模拟的迁移或通过结果。

整组分析使用只读 Explore Agent，生成和修复使用 Code Agent；它们都能看到全部成员和共享源码。
生成、修复只提供文件操作和编译检查，不暴露依赖单工具契约注册表的测试工具。
业务是否成立由后续真实 Runtime 与 Judge 联合验收判断。
若模型已返回实质回答但 JSON 格式损坏，最多额外调用一次真实模型整理格式，禁止调用工具；
空回答、执行错误或轮数耗尽不会被转成成功结果。FINANCE_EVAL_AGENT_DUMP 可保存私有诊断，
包含阶段、工具轨迹、模型调用计数、原始回答和格式修正记录；模型密钥和配置服务地址会被遮蔽。

### HTTP 与回归检查

资源根为 /api/migration-bundles，只有私有工作区可访问。
POST 根路径关联 sourceAssetIds；POST /upload 接收工程 ZIP，query 提供 name、goal、target。
analysis、generate、repair、acceptance 是异步 POST，返回 202 和任务快照；
请求必须提供 key、baseCandidateId，修复还需 runId，验收可选 phase。
PUT /configuration 和 /suite 保存运行配置及测试集。
GET /:id 查看进度；POST /:id/cancel 取消；GET /:id/export 下载。
所有实例仍使用既有账号目录隔离与访问令牌校验。

```sh
pnpm check
pnpm build
pnpm exec vitest run tests/migration-bundle.test.ts tests/runtime-bundle.test.ts
python -m unittest integrations.openjiuwen.test_bundle_runtime integrations.openjiuwen.test_instance_manager tests.test_skill_runtime
pnpm test:ui:migration-bundle
```

浏览器回归使用真实页面和服务，但 Agent、Runtime、Judge 使用显式测试替身；
框架加载测试调用实际 OpenJiuwen SDK，验证同一个 Agent 能读取全部成员。
文件工具测试使用真实 SDK 读写工具验证跨成员修改、原始源码只读及二进制保留；仅模型调用使用替身。
这些测试不等同于客户业务、真实模型或目标部署验收。部署后必须用真实服务和测试集执行整组验收。

### 真实模型端到端 UI 验收

`pnpm test:ui:migration-bundle:live` 使用真实浏览器、生产服务实现、真实迁移 Agent、
本分支 OpenJiuwen Worker 和已配置的 Judge，不接受任何 bundlePorts 注入。
测试输入在 acceptance/multi-skill-procurement/，包含预算查询、采购审核和审计报告三个 Skill，
以及实际 Python 业务代码。测试数据仅作为案例工作区文件交给 Runtime；留出案例不会挂载给迁移 Agent。

运行前配置：

- BUNDLE_LIVE_ENV_FILE：可选，现有私有模型环境文件路径；只读取，不复制密钥。
- FINANCE_RUNTIME_CONFIG：私有 Runtime 模型配置 JSON 的绝对路径。
- FINANCE_EVAL_MIGRATION_PYTHON：安装了 OpenJiuwen 与 uvicorn 的 Python 解释器。
- Judge 使用既有 FINANCE_EVAL_JUDGE_* 配置。

脚本启动独立本地 Worker 和私有测试服务，通过页面导入、诊断、生成、配置、验收、下载。
开发验收失败时最多请求两次真实 Agent 整体修复；留出失败直接记为失败，不把留出答案反馈给修复。
每次运行保留 reports/bundle-live-*/ 下的任务、截图、原包、实际候选与完整执行证据；
result.json 明确记录真实模式及成功/失败。测试结束会关闭自己启动的服务。
验收范围是本地 OpenJiuwen 与实际配置模型，不能据此宣称其他目标部署已通过。

2026-10-18 的真实执行结果、发现的问题与修复见
[真实模型端到端验证报告](verification/multi-skill-live-20261018.md)。

真实 UI 测试通过 `MIGRATION_LIVE_MEMBERS=1` 或 `3` 选择成员数量，同一套 Agent、Runtime、Judge、页面和断言路径执行；报告记录 memberCount。

Builder 产出的 Runtime 如何登记、旧任务的交付接口与新流程的支持范围，见 [Builder 接入](runtime-builder-integration.md)。

## Builder 统一接入

在「Runtime 适配与登记」生成需求、下载该需求绑定的候选源码；外部构建部署后回填 Result。平台执行 v2 整组生命周期并绑定候选、需求、交付和配置版本。修复生成新候选或配置变化后需重新交付，或明确切换为已有环境再验收。旧需求和交付保留历史，已验收导出还会核对在线环境。详见 [Builder 操作与协议](runtime-builder-integration.md)。
