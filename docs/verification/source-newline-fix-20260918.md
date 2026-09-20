# 源码换行统一与引用校验（2026-09-18）

仅优化分析工作区及源码引用的换行处理；condition schema 和 service_url 注入契约尚未修改。

## 实现

新增 src/service/source-evidence.ts。SourceEvidenceValidator 为每轮不可变源码快照缓存统一为 LF 的文本视图；find 定位引用起始行，containsAtLines 验证指定行区间的引用。源文本与引用中的 CRLF、单独 CR 都统一成 LF，无需判断操作系统。不合并空白，不放宽为 token 模糊匹配，不改变原文件字节或 SHA256。

迁移工具/Skill 基线、Runtime Harness 与安全证据使用该公共方法定位引用；依赖 references/schemaEvidence/resolutionEvidence/调用链证据共用本轮缓存；模型辅助静态诊断同样使用公共方法验证行区间。

A2 创建一次性分析工作区时启用 normalize_text=True，仅将已知文本扩展名、可严格解码 UTF-8 且不含 NUL 的字节输入统一换行，显式使用 newline="\n" 写入，避免 Windows 再转换。二进制、未知扩展名、非法 UTF-8 及含 NUL 的资源原样复制。原始上传包始终保留；A4 的工作区默认行为和原文件比较逻辑未变，以避免把分析视图变化当成交付修改。

## 验证

51 项 TypeScript 相关回归通过；3 项 Python 工作区测试通过；核心 TypeScript 编译通过。

复验未修改的真实 A2 输出与原始 ZIP（测试显式提供历史工作区）：

- 报销：状态 COMPLETE，拒绝引用为 0，规则文件已可识别。
- 余额：拒绝引用由原来的 9 条降为 0；仍为 PARTIAL，剩余 service_url 契约未确认。

记录：reports/source-newline-fix-20260918.json。此次没有重新调用真实模型或重跑四案例全部页面链路；采购/退款的 condition:null 问题仍保留。
