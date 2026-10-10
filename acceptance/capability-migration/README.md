# 多能力边界验收

这是三个独立 Skill，不把同一个 Skill 的变体重复计数。与原四个企业 Skill、一个 OpenJiuwen 综合 Skill 合计八个验收 Skill。

| Skill | 迁移边界 | 验收目标 |
| --- | --- | --- |
| supplier-dossier | 宿主目录发现 + 文件读取，两项能力同时满足 | 真实诊断、生成、已有 Runtime 合同复用、2 开发 + 3 留出案例、采用、复用验收与验证下载 |
| receivables-ledger | 大接口响应保存在工具侧查询快照，后续调用按用户选择消费 | 保留逻辑迁移为共享 MCP，不转交 Builder；3 开发 + 4 留出案例、采用、复用验收与验证下载 |
| payment-exception | 已有文件能力，但缺少可信人工审批与暂停恢复 | 拒绝部分匹配，保留并导出全部三项需求，不创建假 Runtime 绑定 |

付款例外的预期是阻断，不能把它计为迁移成功或 Runtime/Judge 已通过。它不包含真实付款操作。
正向路径包含成功、缺件、冲突、不可信文件、跨任务隔离、大响应预览与完整数据的区分、选择发票、空账本、精度、客户不存在、伪造引用和无效选择。

`source/` 是唯一交给迁移 Agent 的输入。`manifest.mjs` 保存独立业务服务数据、开发题与冻结留出题；没有把留出答案写进 Skill。
`test_ledger_source.py` 直接核对源工具逻辑，仅属离线回归，不算真模型验收。

## 执行

先配置真实迁移、优化与 Judge 模型。使用 Builder 的真实 package Launcher，显式启用 `--native-file-listing`；原配置默认仍只有 read_file。
连接信息只放在私有文件，通过 `MIGRATION_TEST_LAUNCHER_INFO` 指定，禁止提交令牌。

```powershell
$env:MIGRATION_TEST_LAUNCHER_INFO='C:/private/connection-info.json'
$env:MIGRATION_TEST_OPTIMIZER_ROLE='MIGRATION' # 仅测试进程显式复用已配置的真实迁移模型
pnpm build
node --env-file=.env.local scripts/verify-capability-skills-ui.mjs
```

可用 `CAPABILITY_TEST_SKILLS` 选择逗号分隔的 Skill ID；缺省执行全部三个并重新诊断与生成。
排查平台接入问题后，可显式提供 `MIGRATION_TEST_RESUME_DATA` 续测单个 Skill 的真实迁移记录副本；
此时诊断与生成标为 REUSED_REAL，重新通过 UI 配置、试运行与评测。总入口不允许续测，也不能把续测记为全新迁移。
脚本启动独立 Eval、合成业务服务和浏览器，结束后关闭；外部 Launcher 由启动者管理。
公开报告仅保留通过状态、阶段、案例与检查项；源码诊断、运行记录和失败详情留在临时私有目录。

总入口 `scripts/verify-migration-acceptance-ui.mjs` 已接入三项，输出分别统计 `migratedSkills`、`expectedBlockedSkills`、`freshRealSkills`、`continuedRealSkills`、`failedSkills` 与 `fullExpandedScenarioAcceptancePassed`。
历史 `fullFiveSkill*` 字段仍只代表原五个，不偷换为八个；配置了八个并不意味着八个已通过。

## 验收推动的修复

首轮供应商运行真实调用了 list_files 和 read_file，但目标 Judge 的旧过滤逻辑删除了 read_file 调用，
导致业务答案正确仍被判 INDETERMINATE。已修复为共享证据投影：业务 toolCalls 与
runtimeSupportToolCalls 分开，辅助调用只传名称和状态，不传文件内容、路径或读取摘要。
目标验收、候选质量和匿名对比均使用同一投影；模型指引明确，辅助能力调用可验证文件类要求，
但不自动视为额外业务操作。原失败记录保留，不能人工改判或通过放宽用例消除失败。

应收账款首次接入还发现，仅供 MCP 启动使用的 SERVICE_ENV 被同时发送为内容为空的 runtimeToolConfig，
使 Launcher 在执行前拒绝配置。已改为仅在存在实际上下文绑定或鉴权注入时发送 runtimeToolConfig；
MCP 的环境变量引用仍然保留，实际 Header/鉴权注入不受影响。

能力诊断的防御性检查避免错误类型持久化后导致报告接口崩溃。随后加入共用的模型结果纠错入口：
A2/A4 无法解析 JSON 时，在原执行结束后通过无工具模型调用修正输出；改进规划会核对结构、
整理无歧义的枚举格式，并有限次反馈字段错误。A4 格式纠错失败不会再次执行代码生成。
纠错不能补造业务事实、源码证据或缺少的 Runtime 能力；缺实质信息仍需弃权或标记需求不完整。
付款例外暴露出另一类语义问题：源 Skill 明确调用由宿主负责的原生能力时，不能因目标 Runtime
尚无实现就改判为业务 MCP。A2 指引已按来源和调用合同判定归属，不按权限高低或目标实现状态判定。
若诊断没有业务 Tool 和逐 Tool 决策，生成阶段直接保留并规范化原 Skill 文档，不调用 A4 编造工具或空的迁移说明。

## 2026-10-08 实际验证记录

以下均为历史版本记录，不代表当前版本重新验收。应收账款旧版的 open/close 工具已从当前源码移除；历史失败记录保留原名称，不能沿用为新版通过证据。

- supplier-dossier：全新真实诊断、生成、Runtime 执行与 Judge；最终 5/5 通过，并通过 UI 采用和刷新确认。
  报告：`reports/capability-skills-ui-1791429249771/result.json`。
- receivables-ledger：修复配置传输问题后，复用本次真实生成的产物续测；三个 MCP 协议试运行通过，
  开发集大账本通过，空账本在 close_ledger 返回 LEDGER_REFERENCE_INVALID，故失败。
  改进规划没有取得工具结果证据而选择 ABSTAINED，未进入最终留出集或采用，不能宣称 5/5 通过。
  运行记录包含实际工具结果，但规划输入目前只有调用名称/状态及 Judge 评语，后续需补齐受控的事实证据投影。
  报告：`reports/capability-skills-ui-1791430771552/result.json`。
- payment-exception：首次全新诊断/生成后的能力核对正确返回缺少 request_approval，但测试定位到多个页面警告而中断。
  修正测试定位后复用原产物续测，真实的目标 Runtime 重新诊断把 request_approval 改判为缺实现的业务 MCP，
  导致导出需求只有文件两项能力，验收再次失败。审批语义仍出现在诊断文字中，但未保留在 Runtime 能力合同内；
  因此未完成完整需求导出验证，也不能把这次运行计为预期阻断验收通过。
  报告：`reports/capability-skills-ui-1791431128987/result.json`。

修复后，payment-exception 重新从前端走全新真实诊断与生成，再选择实际 Launcher 做目标复诊断：
三项原生能力均保留在完整需求 YAML 中；因目标缺少 request_approval 且另两项合同不完全匹配，
Runtime 复用返回 409，页面没有写入虚假绑定。该 Skill 没有待迁移业务 Tool，候选包保留源文档，
A4 调用次数为 0。此用例是预期阻断验收通过，未运行 Runtime 业务案例或 Judge，不能算迁移成功。
报告：`reports/capability-skills-ui-1791434300834/result.json`。

新增用例仍保留上述失败门槛；离线测试通过不替代真实 UI 验收，也未宣称八个 Skill 全部新跑通过。
Eval 回归：88 个测试文件通过，454 项通过、1 项跳过；Builder 相关七个测试模块共 300 项通过。
