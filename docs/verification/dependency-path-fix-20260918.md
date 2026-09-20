# 诊断依赖路径校验修复（2026-09-18）

仅修复路径校验，不改源码换行匹配、condition schema 或 Runtime 注入契约。

A2 Python 执行器在结果顶层返回实际 workspaceRoot，TypeScript 通过执行元信息传递给依赖分析；不读取模型 judgement 中的根目录。相对路径和工程内绝对路径统一定位资产文件清单中的唯一文件，再验证实际引用内容。Windows 支持盘符大小写、斜杠差异与 UNC；POSIX 保留大小写敏感。禁止工程外路径、其他轮次的工作区路径、磁盘切换和仅凭文件名后缀猜测。无根目录的绝对引用无法确认，不猜测来源。

references、schemaEvidence、resolutionEvidence、调用链 evidence、resolvedPaths 使用相同的路径校验方法；持久化证据路径仍指向资产文件清单。依赖已解析文件去重；无法定位的 resolvedPaths 保留具体 issue。没有改前端或交付格式。

回归覆盖合法与非法 Windows/POSIX/UNC 路径、缺失文件、大小写歧义、真实引用校验，以及平台服务对可信元信息的传递与模型根目录伪造拒绝。

复用未修改的报销真实 A2 输出，验证时显式提供该轮已知根目录：assets/rules.json 的 availability 恢复为 AVAILABLE，resolvedPaths 正确定位到 assets/rules.json。记录在 reports/dependency-path-fix-20260918.json。该轮整体状态仍为 PARTIAL，保留此前换行引用等问题；没有宣称四案例全链路通过，也没有重新运行模型。
