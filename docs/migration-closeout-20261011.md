# 2026-10-11 复用验收续验记录

本记录关闭自动跨部署复用验收的证据缺口，不宣称八个 Skill 已全部重新验收。

## 固定版本与修改

- Eval 执行版本：`4af5566aaa1ab41ca629f79ef8999ce509bb91b3`。
- Builder：`7f3e2141fb6232722b11f355c30934e377cfdeba`（实际授权 worktree）。
- Harness：`1cf4f0a969269b74920da547601053cc343636b5`，本次没有运行 Java Harness。
- 实际运行器：原生 Python OpenJiuwen `0.1.17.post1`；执行模型 DeepSeek，Judge GLM，沿用本地真实配置。

修复执行前覆盖与执行后判定的阶段混淆；重新规划读取同一完整绑定的独立覆盖反馈，
不自动循环到通过。补充可选 Script 实际进程启动/退出回执，逐调用核对 ordinal、摘要、
case scope 和退出状态，不冒充 OS 隔离或内存审计。Builder 用实际 worker 解释器探测软件版本，
Eval 独立冻结每个部署的事实。缺失仍未知，不推断远程服务或其他解释器的版本。

同时修复隐藏的失效部署选择与私有能力探测写入 bytecode 导致不可变产物漂移的问题。
最终 Judge 明确逐 check 输出协议，失败诊断只记录固定词表的结构信息，不公开原始模型响应。

## 真实前端续验

沿用已确认的六项原复用要求及不可变报销候选
`811475539db689b3f9ad0243028c744a5d1375fa7d01e25c88b2b26627aa8d7f`，
没有修改业务逻辑、删减要求或人工编写本次计划。

1. 两份实际 Launcher 分别通过交付准入；不是同部署别名或仅创建新实例。
2. 真实模型生成六个案例，两组部署；独立 COVERAGE 通过，前端确认并运行。
3. 六个业务案例全部通过；其中三轮案例保持真实会话，实际采集三次不同 Script 进程回执。
4. check Judge 六项全部 PASSED，核对实际关联回执及两部署探测的 Python `3.12.14`。
5. 两组运行均报告 `RELEASED`。刷新后仍通过，下载页三项交付检查通过。
6. 实际 UI 下载 ZIP，五个文件名称和内容与不可变候选逐字节一致，不含测试数据或凭证。

任务：`reuse-test-74480672-d465-442c-8d16-0065edc7350b`。
运行：`run-f28e36c4-594d-4b5c-8824-279cc29a5d72`、`run-8ccb4899-6320-475d-a63b-26538d130ba4`。
详细本地证据：`reports/cross-deployment-ui/process-evidence-progress.json`。

第一次真实执行六个业务案例均通过，但最终 Judge 格式非法，原任务保持 INDETERMINATE；
后续成功来自新的真实运行，不覆盖旧结果。此前覆盖阻断及 Builder 探测失败也保留。

## 回归及未完成范围

Eval：128 个测试文件通过，927 项通过、2 项跳过；Builder 相关六组测试 170 项通过。
本次是原候选的续验：原诊断、生成、留出复核与采用保留历史来源，没有伪装成本次全新执行。
下载页业务门槛使用该同一候选已有的有效最终复核，不代表新部署另做了一轮独立留出复核。

八 Skill 账本仍未全部签收。员工余额、采购、退款、供应商资料、当前应收查询/快照消费流程，
以及付款例外的预期阻断仍需固定版本的相应 UI 证据。历史通过、续验通过与预期阻断必须分开统计。

## 验收要求纠偏与方案修订 UI 验证

后续纠偏在历史数据副本上执行，不修改上面记录的业务结果或源码。
首次真实模型修订仍继承旧方案的进程/内存判据，未确认，截图保留在
`reports/reuse-policy-ui/01-first-revision-overpromise.png`。这是生成依据的锚定问题，
不是通过放宽 Judge 或修改业务脚本解决。

生成依据改为原始源码与实际契约，不将历史生成方案当作业务需求输入后，
通过前端再次调用真实 `deepseek-v4-flash-0731`，一次调用约 81 秒，生成四项验收：
混合类别金额与违规结果、餐饮上限边界、缺失文件错误、不同报销单的业务结果隔离。
原有金额、规则和错误契约保留；隔离判据不再要求逐进程身份或内部内存审计。
截图：`reports/reuse-policy-ui/02-business-centered-check.png`。

前端确认并刷新后，方案 `reuse-04b00783-5216-4b55-bf2e-27092129ae51` 保留两版历史，
旧 `runs` 与 `reuseAcceptanceResults` 与原记录完全一致。旧候选摘要未变，仍绑定旧方案。
后端返回 `workflow=GENERATE`、`reuseAcceptance=STALE`、`delivery=UNVERIFIED`。
修复生成页错误展示旧候选“已准备好”的问题后，实际页面显示“等待新方案实施”，
不提供借用旧通过结果进入下一步的按钮，刷新证据为
`reports/reuse-policy-ui/03-confirmed-refresh-gate.png`。

本次只证明真实方案修订、重新确认、持久化和新旧证据隔离；未执行修订后的重新生成、
业务评测、留出复核或复用验收，不属于新的完整迁移签收，也不能提高八 Skill 签收数。
测试宿主记录 HEAD 加工作树源码摘要，并明确标为未提交版本，不冒充固定发布版本。

本次改动的最终低并发回归：129 个测试文件通过，941 项通过、2 项跳过；
核心、示例与前端类型检查通过，前端构建通过（保留已有 bundle 体积警告）。
此前一次全量运行出现共同约 20 分钟停顿后的三项失败，原报告保留；
三组独立重跑及新的全量运行通过，未修改断言或超时标准。
最终回归报告：`reports/reuse-policy-final-low-concurrency.json`。

## 修订方案的完整迁移闭环（后续实际执行）

本节接续上面的方案修订验证，不覆盖历史结果。原始诊断沿用真实来源，
本版重新生成、候选分析、独立审查、工具验证、业务评测、留出复核、采用、
复用验收、刷新和浏览器下载均实际执行。

### 固定版本与候选

- 生成、独立审查与业务/留出执行的 Eval：`464bb50`。
- 后续复用计划、双部署验收与下载的 Eval：`5889743aceebf44bf19aa58759415e44b7318104`。
  两次宿主均由干净工作树启动，后者复制前者实际数据，不重新判定旧结果。
- Builder：`7f3e2141fb6232722b11f355c30934e377cfdeba`；实际部署仍为前文两份独立
  Native Package，包摘要 `79d8d48551bf270c72f93d7e2fb37088e64f246d2892b2828c86aa7efac3253a`。
- Harness 仓记录版本 `1cf4f0a969269b74920da547601053cc343636b5`；本例运行 Python
  OpenJiuwen，不宣称 Java Harness 被执行，也不宣称本轮发生 Builder 重建。
- 方案：`reuse-04b00783-5216-4b55-bf2e-27092129ae51`（本轮未再改动已确认要求）。
- 候选：`expense-compliance@2.0.0-migration.2`，摘要
  `55fd510990a4aa4bce1d0c5c1792bef79fd853e72d310452b1fc51bd036248fc`。
- 分析、生成和执行配置为真实 DeepSeek；Judge 为真实 `glm-5.3`，不是替身模型。

### 实际结果与关联证据

| 环节 | 结果 | 记录 |
| --- | --- | --- |
| 重新生成与候选独立审查 | 完成；审查一次调用约 19 秒 | 生成总耗时约 398 秒，候选与本版方案绑定 |
| 工具试运行 | 1/1 通过 | 本版候选的真实 Script 调用 |
| 新开发集 | 3/3 通过 | `run-c17840df-8aa1-4136-86ab-56fca043f799` |
| 最终复核 | 开发题 3 + 独立留出题 3，6/6 通过 | `run-a5bfeff3-9db5-4aab-8770-fddf776dbe38` |
| 前端采用 | `ADOPTED`；无需多余改写 | `improve-ebc930bf-04b3-40f9-919a-5713922ca514`，`finalConsumed=true`、`finalVerified=true` |
| 复用计划 | 原要求 4 项，独立覆盖审查通过 | `reuse-plan-e5abedd6-e6bd-4181-ac3f-47c193cea6c1` |
| 双部署复用验收 | 8/8 案例、4/4 要求通过 | `reuse-test-ab9e177f-1dd8-4ade-983e-70c8aebef628` |
| 主部署运行 | 4/4 通过；两个案例各真实续接两轮 | `run-da265534-3519-40f9-b7d9-30d9a6d440c0` |
| 附加部署运行 | 4/4 通过；两个案例各真实续接两轮 | `run-ea7dabd2-7bdb-432e-9e38-d329b96086d6` |
| 释放运行资源 | 两组均有 `RELEASED` 回执 | 各运行记录的 `finalization.resources` |
| 刷新与下载 | `VERIFIED`、无交付缺口；浏览器实际下载并重新计算摘要 | 导出摘要等于上述候选摘要 |

业务题验证混合类别、150.00 边界和缺失单据；独立留出题验证 0.10+0.20、
空明细、超过餐饮上限的合法 taxi 金额。复用计划按原四项要求在两个已准入部署
分别执行，连续调用使用真实会话续接，验证不同单据结果不串扰。
源码/规则事实与执行结果按相应证据层级核对，没有增加通用内部内存审计要求。

下载包实际为 `SKILL.md`、`assets/rules.json`、`scripts/check_expense.py`、
`scripts/README.md`、`scripts/runtime-dependencies.json` 五项。
`verifiedDeliveryEvidence` 进一步校验当前方案、候选、配置、最终复核、复用任务
和导出摘要一致；历史复用结果逐项与修订前数据对照，保持不变。
刷新后的前端证据：`reports/reuse-policy-ui/05-revised-full-closure.png`。

### 本轮失败和边界仍明确留存

首次验收计划与留出任务并行发生冲突，服务拒绝保存计划，没有借用或改判旧计划。
另一调用出现 `unresolvedQuestions` 类型错误，截图
`reports/reuse-policy-ui/04-plan-format-block.png` 保留。
未保存原始响应，不能声称已确认该次错误的具体原始类型；后续增加有限的字符串/列表
表示兼容和不含正文的结构诊断，未知/null/缺失字段仍拒绝，业务判据不进行转换。
后续真实 PLAN 输出该字段为数组，并独立通过 COVERAGE；不是把前一次失败改成通过。

本例的修订迁移链可以阶段性签收，但不能据此把八 Skill 全部改记为通过，
也不能替代“发现 Harness 问题 → Builder 重建 → 新 Launcher 准入 → 恢复评测”验收。

本轮最终全量回归：947 项通过、0 失败、2 项跳过，报告
`reports/reuse-policy-closure-regression.json`。核心、示例与前端类型检查通过，
前端构建通过。另有针对性回归 64 项，以及格式兼容与工具隔离纠错回归 28 项通过；
这些单元/集成回归与上面的真实模型 UI 证据分开记账。

## 2026-10-12：同一任务的真实 Harness 重建与最终采用

本节记录新的实际任务，不覆盖之前失败的留出复核。固定执行版本：
Eval `f0112afd562e32b4eef7440ac3de3fe6d80ccd63`，Builder
`01a0e686d6566688e2e1858e57974a83ba185d74`；Harness 仓版本不变，本轮仍运行
Python OpenJiuwen Native Package，未运行 Java Harness。执行和规划使用真实模型，
Judge 使用本地已配置的真实 GLM 模型。

### 已证实并修复的平台问题

上一条任务 `improve-daba2c68-120b-4347-8ba2-5c3925337757` 的开发集通过，但
最终复核 `run-013d8121-976e-4220-811e-f84875f66622` 只有 3/4 通过，保持 FAILED、
未采用。订单 ORDER-002 的计算工具真实调用失败，不是 Judge 误判。
源码与实际调用摘要对照证明：候选分析遗漏了计算工具的 inputSchema，登记层随后
丢失源工具已确认的 `subtotal`、`tax_rate` 顶层字符串参数，模型传入了嵌套 input 对象。

修复不改业务脚本或金额规则：仅当工具映射、原始合同、已确认方案和当前候选的独立
一致性审查全部匹配时，登记层保留原合同；显式的新合同不被覆盖，也不从测试样例猜 schema。
新运行记录已实际包含两个必填字符串字段。原失败记录及截图
`reports/runtime-rebuild-ui/01-contract-loss-block.jpg` 保留。

### 本次同一任务的实际执行

候选摘要始终为 `1f518ae718f6ad8ee1e74ebfa8901bcbf5ce912d809fbfc79caaeae46ac6dfe1`。
新的测试任务在开始改进前冻结开发题及两个不同提问的留出题；留出题不供规划和 Builder 使用。
这不是把上一任务已消费的留出题重新记为未见数据。业务事实来自原始 Skill，
不宣称订单数据本身在源码中不可见。

| 环节 | 实际证据 |
| --- | --- |
| 新基线 | `run-91648f08-e2ca-4571-a4a0-289a457710f3`：正常订单因两次迭代上限中断，缺失订单停止分支通过 |
| 同一改进任务 | `improve-5943f6eb-977a-42c2-a4b7-744ad7a1b299`，前端观察 WAITING_BUILDER 并下载实际需求 |
| 冻结需求摘要 | `4509587a6dfaaa6cd268da31cab584d7b13e6465d0d52572256b472d842e6480` |
| 真实 Builder | 真实 Codex construction agent；逐条审核确定命令，未禁用审批；独立契约测试 PASSED |
| 新产物 | `05a590c27a9e89e4917c714b162881982e8f699e68a6696a9a9f017ce76a1e12`，独立部署 `runtime-07b24e60bbc3666b30217bec` |
| 修改范围 | 实际 worker 与基线逐字节比较：长度相同，仅 1 字节变化，agent 迭代预算 2 → 6；业务工具和 Skill 不变 |
| 独立准入与恢复 | 前端导入实际 Builder Result，Eval 独立准入，点击恢复原任务，非另建通过任务 |
| 恢复后的开发集 | `run-5e870d6d-e37e-4dbb-9e3e-f77545889a51`：2/2，HARNESS 改进 PROMOTED |
| 最终复核 | `run-8441ccce-6eb5-4213-821d-69f74efc0f4c`：4/4，包含实际税率和币种优先于用户猜测的留出要求 |
| 前端采用 | 同一任务 ADOPTED，finalConsumed / finalVerified 均为 true |

`verifiedHarnessRebuildEvidence` 已针对实际等待快照、当前服务报告和最终任务执行通过，
校验同一任务、同一需求摘要、不同产物与部署、恢复运行、当前最终复核和采用。
不含令牌的结果为 `reports/runtime-rebuild-ui/02-same-task-rebuild-evidence.json`；
前端采用截图为 `reports/runtime-rebuild-ui/02-same-task-adopted.jpg`。

本节已关闭“发现问题 → Builder 重建 → 新 Launcher 准入 → 原任务恢复 → 留出复核 → 采用”
的真实验收缺口。该新配置的复用验收与下载另行核验，不借用失效的旧结果，也不把八 Skill
全部记为本次通过。当前版本完整回归 974 项通过、0 失败、2 项跳过；类型检查通过。
报告为 `reports/runtime-rebuild-ui/regression-f0112af.json`。

### 同一已采用任务的新配置复用验收、刷新和实际下载

2026-10-12 02:29，上述同一任务已完成最后交付链，不再只停在业务复核。
复用执行版本 Eval `97d0c6e`，全量回归版本 `83a43e7`（后者仅更新测试、冻结批次和说明，生产实现不变）；Builder 版本同上。

- 计划 `reuse-plan-8a8b9fb3-5006-486b-aa13-97d53e0a9604`：通过真实模型独立 COVERAGE，保留全部 5 项原方案要求。人工编辑只纠正判据：去掉非原承诺的每调用独立 OS 进程强制条件，核验两工具输入 schema，以实际 `toolResultInputMatches` 核验原样传参。先前 INCOMPLETE 记录未改判。
- 实际复用任务 `reuse-test-f9587ed1-c528-417c-b1e3-18fb16fc2856`，运行 `run-3a3dbd46-3854-4f9b-95c0-6733aad472a5`：4/4 案例、5/5 原要求通过。含真实双轮不可用订单停止、完整 ORDER-002 工作流、ROUND_HALF_UP 舍入、不同请求不串扰。
- `toolResultInputMatches` 实际记录前一个查询工具与后一个计算工具的 `subtotal`、`tax_rate` 值匹配；原实参不公开。这是值相等和调用先后证据，不是内部因果或内存证明。
- 前端刷新后重进同一项目，交付页仍显示三项通过。实际点击下载，得到 `openjiuwen-portability-acceptance (1).zip`；6 个文件的内容指纹精确等于已采用候选 `1f518ae718f6ad8ee1e74ebfa8901bcbf5ce912d809fbfc79caaeae46ac6dfe1`。
- 针对当前实际服务报告与真实下载，同时运行 `verifiedDeliveryEvidence`、`verifiedHarnessRebuildEvidence`，均通过；delivery=VERIFIED、gaps=[]。新实例验收未冒充跨部署；跨部署证据来自上文 expense 的两独立部署，二者分别记账。

证据 `reports/runtime-rebuild-ui/03-verified-delivery-evidence.json`，刷新后下载页截图 `reports/runtime-rebuild-ui/03-current-verified-download.jpg`。
本例已闭合“批准方案 → 生成审查 → 基线发现 Harness 问题 → Builder 重建 → 独立准入 → 原任务恢复 → 留出复核 → 采用 → 新配置复用验收 → 刷新 → 实际下载”链。
原始生成/批准沿用真实记录，本轮不记为从空白新生成。八 Skill 的历史与当前续测仍分别保留；本例闭环不把其他样例自动改为通过。

本轮额外发现并修复：新增观测说明误进入执行合同指纹，导致已批准方案失效。观测说明保留在 Judge 指导中，执行语义合同恢复稳定，不改写批准记录。
全量回归 `83a43e7`：987 通过、0 失败、2 跳过；核心、示例、前端类型检查通过。报告 `reports/runtime-rebuild-ui/regression-current.json`。

### 企业退款续测与当前尚未完成的复用证据

实际生成候选 `dd0e6a960b8ff07d08ae90ad6d9bb82c6e63b10ae26aef795132f3676c2f320e`，独立候选分析和方案落实审查通过，MCP 技术验证 1/1。此前运行 `run-521cd65b-87fc-44be-8211-590ca9f4fa62` 因 Builder 拒绝已声明的 runtimeToolConfig，在创建实例前返回 `RUNTIME_TOOL_CONFIG_UNSUPPORTED`；失败保留，不改判。

Builder `92ddec15ff8191343ba63433dc07b5be5763a984` 实现已声明实例上下文到 MCP 请求 Header 的绑定。只消费实例提供的值及其秘密引用，不读取宿主环境变量、不导入用户指定 Provider、不改业务入参；拒绝头碰撞、传输保留头和 X-Workspace-Root 覆盖。相同绑定的业务工具在案例内共享 Client/MCP 生命周期，不共享不同上下文。新的两个不可变部署实际独立准入；部署准备使用 API，不记为 UI 准入测试。

Eval `806e01f5f3a740d9b9c1b4fb409a437ee0991c9c` 通过 UI 运行：开发 `run-c1613adf-40c1-4053-a3be-9b6d4d64050d` 为 3/3；冻结留出与开发复核 `run-bf60821a-3e5a-428c-a46b-0127a984e69e` 为 5/5。任务 `improve-e8d4978e-8f3c-45a9-b7a1-e600c0d7ab97` 已实际采用，finalConsumed/finalVerified 均为 true；因开发已通过没有优化迭代，不宣称本例执行了 Harness 重建。

复用计划的真实独立覆盖审查返回 INCOMPLETE：模型将工作区 JSON 误当作 BUSINESS_SERVICE_URL 上的 HTTP 服务，且原方案的政策端点故障、负向鉴权要求未具备实际执行配置。没有执行这个不可覆盖的计划，没有将 5/5 业务通过记为复用或下载闭环。需对齐真实外部测试资源与验收程序，而不是放宽金额、错误、鉴权或隔离要求。Builder 本轮 Windows/SPI/包发布及上下文回归 148 项通过。

### 原源码退役交付能力

修正装配缺口：可选 `skillDelivery.retiredSources=[{path,reason}]` 让迁移模型显式声明被本次迁移替代的原实现/注册胶水，不按文件名自动删除。仅从新候选排除，原上传资产及字节保持不变；完整相对路径、非空理由、唯一性和数量受限，拒绝不存在文件、文档/配置/业务资源、运行数据，以及未迁移工具仍消费的共享源码。删除及理由展示在产物差异中，候选分析和原方案独立一致性审查保持不变，不因清单合法自动判通过。旧交付不需要增加该字段，没有新增 Runtime 协议版本。

全量回归 1012 通过、0 失败、2 跳过，核心、示例、前端类型检查和构建通过；报告 `reports/runtime-rebuild-ui/regression-source-retirement.json`。其中源码退役 24 项和 UI 等待状态 1 项新增回归通过。此处记录实现与回归，不冒充应收快照样例已完成新的真实 UI 迁移。

### 应收候选实际恢复审查及规划错误分类

应收项目 `migration-4fcc99ef-ab0f-47a0-b28f-993e9a477eea` 的真实迁移模型已使用退役清单替换原注册胶水，候选摘要为 `3ba98978a0cb5ca5bf2f1baf054c91fbed7a63f3c533a4ca65545376ca299e2c`，版本 `2.0.0-migration.3`。原始上传未修改。独立候选分析通过；默认思考预算的审查达到 32768 输出上限而未形成结果，失败原记录保留。仅在续测进程使用同一真实模型的低思考预算，恢复同一候选未完成的独立审查，31 秒、一次真实调用通过，没有重新生成候选或放宽检查。查询工具对实际外部账本 AR-200 的技术验证通过；完整复用仍待执行，随机无效引用不能代替前一任务真实引用的跨任务失效验证。

退款重新规划的三个真实调用并非源码引用失败，而是方案遗漏原诊断的两项依赖标识 `business_service_url`、`auth_token`。旧日志将全部设计问题记为 SOURCE_EVIDENCE，现区分 DESIGN_CONTRACT，并将必须覆盖的原始 dependency.key 显式传入规划上下文与修复反馈。仍拒绝缺项或别名，不自动映射或修改原方案；最终错误文字也区分契约和源码问题。全量回归 1013 通过、0 失败、2 跳过，报告 `reports/runtime-rebuild-ui/regression-design-contract.json`；类型检查和构建通过。真实模型修复后续测另行记录，不把回归当作新迁移通过。

### 真实续测发现的执行阻塞与候选修复入口

退款按精确依赖标识重新规划后，真实模型产出方案 `reuse-9bcdeda6-26cc-4265-bd28-a1ea4e0b934c`，前端批准并生成候选 `fb930e6fc1b0ad92f51d6f89bb4049e31b955d77dc1ab077c1b31aba3802e0a0`，独立分析和方案落实审查通过。实际 MCP 调用失败：模型错误使用 Python `ToolResult(structuredContent=...)`；当前 FastMCP 2.14.7 的实际参数是 `structured_content`。原候选和失败结果保留。指导模板现明确区分 Python 参数与 wire 字段；Python 模板真实 HTTP tools/call 验证文本 JSON 与 structuredContent 相等，不能以启动/list 通过代替调用通过。

同时修复手工候选导入：已生成候选的独立修复包需新版本、同一 Skill 身份、完整声明文件，并先按冻结方案执行独立候选分析及落实审查。失败不替换旧候选；成功保留启动/准备/绑定声明及工具身份映射，不沿用旧执行声明或旧分析指纹。历史运行按旧摘要保留，新候选必须重新执行技术、业务和复用验收。页面不再用普通诊断覆盖已完成的方案审查。新增 8 项回归，全量 1048 通过、0 失败、2 跳过；类型检查及构建通过，报告 `reports/runtime-rebuild-ui/regression-manual-candidate-revision.json`。修复包的真实 UI 采用结果另记，不把实现测试记为候选通过。

应收计划的真实独立 COVERAGE 已通过，并由前端启动三组、五案例验收；运行 `run-04f30960-b10e-4ae5-8b86-beab69def03d` 在实例准备时被 Builder 92ddec1 以 `MCP_PREPARE_UNSUPPORTED` 拒绝，未执行任何业务案例或实际引用绑定。候选声明的是 uv 依赖版本准备命令，问题属于 Launcher 支持边界，不是 Judge 失败；保留 INDETERMINATE，后续须使用实现兼容合同且重新独立准入的部署，不能删改记录或静默丢弃准备步骤。

### 通用跨运行组真实结果绑定

### 2026-10-12 续测修复与版本边界

#### 实际续测结果及第二个执行器缺口

固定 Eval `c818968a394e81d33f76648ef29a7b386464b471` / Builder `da5a1a30a856f1200fff4a59d794b8619997249d` 后，两份真实新部署均独立准入。退款修复候选 `67b845d7fcd5739fb3c59684ea4983240cd579d1b3cca4226cf599b1a81cd767`（2.0.0-migration.2-api.1）真实独立诊断及方案审查通过，后者 17 秒一次调用；前端采纳，旧候选和失败保留。实际 MCP 试运行通过。

应收新计划 `reuse-plan-5b271b33-5be4-4a44-b51d-93f5d6d3aa1e` 经真实覆盖审查通过。第一组运行 `run-81e9321e-7f3b-47db-aa04-77d20ac74c6b` 的 3 案例全部通过；后续组准备因 INPUT_BINDING_UNAVAILABLE 停止，未冒充跨部署通过。原因是实际 MCP 仅返回单个 text JSON 内容块，授权结果投影为 JSON 编码的内容块数组；原绑定器仅识别对象/对象 JSON。现支持准确解码唯一 text JSON，不接受多内容、图片、非 JSON 或猜测字段，原结果和摘要不改变。88 项相关回归、全量 1065 通过/0 失败/2 跳过及类型检查通过；报告 `reports/runtime-rebuild-ui/regression-mcp-text-input-binding.json`。

退款新开发题 `run-749dc797-e52b-4498-b46b-e98790e3d36d` 仅 1/3 通过，但全部实际工具响应的两通道回执 MATCH。失败原因不是 Judge：连接的旧合成接口实际只有 RF-001/RF-002（政策 PAID），冻结计划使用 RF001/RF002（政策 PENDING）；实际请求正确但返回 ORDER_NOT_FOUND。另建 `scripts/serve-refund-business-acceptance.mjs` 的显式独立 IT 测试服务，数据与已冻结计划一致；原接口、候选业务代码、判据与失败记录均不覆盖。真实 UI 更新服务地址和公开合成凭证后重新试运行，不使用模型回答模拟业务服务。新配置的业务/留出/复用验收另记。

退款人工修复包的真实 A2 诊断把候选目标协议 SDK 标为 KNOWN + RUNTIME + KEEP，违反原有归属/动作合同，导入原子拒绝、旧候选未替换。现完善通用指导：源框架胶水与业务工具自身声明的目标协议 SDK 分开判断，后者按实际实现和声明证据归属 TOOL + KEEP；不按 SDK 名字自动改标签或跳过依赖验证。另外已核对当前 OpenJiuwen SDK，init_model 无 extra_body 入参；A2/A4 改为在公共 invoke/stream 上传递可信运行配置及角色环境变量的扩展参数，保留原客户端、回调与流实现，上传内容不能配置这些参数。5 项 Python 模型配置测试通过。

Builder 本地提交 `da5a1a30a856f1200fff4a59d794b8619997249d` 支持受限 uv 锁定版本 import/version 准备探针（不接受任意 shell、索引 URL、未固定版本或其他内联程序），以及实际 MCP tools/call 文本 JSON 与 structuredContent 摘要比较。两项能力从不可变 worker 实际探测并冻结，旧部署不能继承主机新源码的声明。Builder 114 项相关回归通过。

Eval 发布可选 v1 字段及严格比较回执 schema：成功调用序号、工具名、验证身份与流结束必须关联；MATCH/MISMATCH 校验两摘要关系，缺失或无效不推断一致。规划和 Judge 可用实际回执，不用源码或单一结果投影代替观察。全量 1058 通过、0 失败、2 跳过，报告 `reports/runtime-rebuild-ui/regression-mcp-channel-observability.json`；构建通过。事实归属实验新证据批次为 `fact-provenance-v9`，旧批次摘要及结果不覆盖；冻结不代表已执行，Runtime 协议仍 v1。新 Builder 部署及退款/应收真实续测须另记，不改写已完成的主闭环。

复用验收计划增加可选 `inputBindings`：指定更早运行组的来源案例、当前候选业务工具、成功调用序号及授权结果字段路径，以 `{{reuse:id}}` 替换后续查询模板。只允许短标识符、有限数值或布尔值；不传秘密、文件、完整大结果或模型指令，不改变判据。来源必须已完成、Runtime 身份已核实、流已完成且工具真实成功；未采集、省略、缺字段或不匹配时停止后续组，不使用随机引用或模型回答代替。来源和消费案例必须映射到同一原验收要求。

实际执行仍为独立组和任务，不共享 MCP 内存。保留来源案例/job/tool/调用序号/字段路径以及值、模板与查询摘要回执供最终独立核验，不在回执里重复原值。旧计划无需补字段，已批准执行合同指纹保持不变；这是测试执行器的数据传递扩展，不是业务迁移策略菜单。针对性测试 105 项通过，包含缺失证据前停止的服务集成测试；全量 1040 通过、0 失败、2 跳过，报告 `reports/runtime-rebuild-ui/regression-real-input-bindings.json`；类型检查、构建通过。真实 UI 验证另行记录。
