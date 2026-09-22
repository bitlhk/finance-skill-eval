# Skill 迁移六项修复

## 内容保留

工具的 sourcePaths 是分析关联路径，不是删除清单。打包只移除所选工具独占的实现代码；SKILL.md、references、assets 不能因此删除。缺少原指令或正文为空时失败，不再生成通用业务模板。

## 候选 MCP 接入

完整执行携带 runtimeMcpBindings，包括候选 digest、文件清单、启动与准备命令及工具范围。RunManager 优先使用候选绑定，不预检或借用同名旧环境服务。OpenJiuwen 在会话工作目录内启动候选服务，校验绑定 digest，list 后装配实际工具，并通过 ExitStack 清理。取消整个会话时仍由 supervisor 清理进程树。预登记的外部 MCP 保持原授权校验。

这是可信内部代码的 LOCAL_TRUSTED 模式，不是执行不可信代码的安全沙箱。

## Script 执行规格

完整执行使用技术验证生成的同一份 launch argv，取消固定 Python 3.11。PEP 723 直接由 uv 执行脚本；项目使用 pyproject 与可用锁文件。旧客户端没有 launch 时采用相同包内解析规则。工具错误保留类型和受限长度的信息。

源 Schema 缺失但有已引用样例时，仅将样例字段暴露为调用提示，不声称它是完整或必填的正式 Schema，并在候选 findings 中标注。

## 自动验收与下载

运行完成、候选 digest 核对和业务验收分别记录。自动验收要求成功调用证据、必備规则和每个 Judge 维度至少 3/4；缺少定义/证据不能通过。toolExpectations 区分 mustSucceed 与 mustNotCall，允许提前停止案例不调用后续计算。旧案例没有该字段时按 requiredTools 要求成功证据，采取保守判定。

当前自动验收不代表原环境等价验证或人类专业签署。未验收候选仍可下载审阅，但前端提示、文件名 -unverified 和后端 x-migration-acceptance 响应头标明状态。

## MCP 调用结果

验证 CallToolResult 结构；isError:true 或非法结果失败。合法业务 unavailable 响应本身不是协议错误，是否符合业务预期由冻结案例与质量验收判断。

## 出题依据

冻结 sourceInspection，候选再分析不能覆盖。读取 skillFile 所在目录下的 references/*.md。旧记录没有原始分析时单独分析原资产，不拿候选替代。原样例输入传入题目生成器；已有主体编号的样例必须至少有一道对应核验题，不允许全部换成虚构编号。异常处理和提前停止由明确工具预期的确定性回归保障，不依赖一次 AI 出题覆盖所有分支。

## 附加边界修复

- Script/java 不再进入允许生成的计划，表单切换 Script 时移除 Java。
- A4 必须交付所有授权工具且语言一致，不能部分结果进入打包。
- 技术验证启动失败清理工作目录；服务就绪超时清理进程。
- 再生成时恢复 MODIFY 的原内容，而非把原指令一起删除。
- 浏览器 scanner fixture 使用真实 AST_PARSED/TEXT_INSPECTED 状态。

## 回归

- 最终 TypeScript 完整测试：45 文件、198 测试全部通过，包含 10 项新回归。
- 最后契约/下载修改后定向复测：28 测试通过。
- Python 包启动、锁文件、绑定入口与服务清理：4 测试通过。
- 核心/前端类型检查及构建通过。
- 浏览器回归通过；A2 sourcePaths 显式包含 SKILL.md，导出仍保留原停止规则，并断言未验收下载提示和文件名。
- 真实 A2/A4/出题/OpenJiuwen/Judge 运行产物保存在 reports/migration-e2e-2026-09-17T01-58-40.629Z；复用了同日 01-53-40 运行已完成的 A2 资产分析。最终状态以该目录的 migration-report.json 为准。

真实结果：候选 4bfcc65e5031 保留原五步 SOP；空 MCP 配置下自动启动候选服务；实际 read_file、get_acceptance_order、calculate_acceptance_total 全部 completed，税额 6.00、合计 106.00。真实 Judge 四维全部 4/4，自动验收 PASSED，导出成功。原运行环境对照仍 NOT_RUN，不声称原环境等价。此前一次 A4 仅部分产物可映射，被拒绝；完整性检查保证不会把这种部分交付继续打包。

最终编译版本重新加载同一已完成任务，仍为 PASSED，acceptance.reasons=[]，minimumDimensionScore=3、requiredToolEvidence=true。候选 MCP 的 60128 端口确认已关闭，临时运行服务与配置均已清理。既有后台进程需要重启以加载修复，未进行 Git 提交。
