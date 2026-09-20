# 调用链 condition:null 支持（2026-09-18）

输入 schema 支持 condition 为 string、null 或省略；null 规范化为 undefined，持久化边结构省略 condition 属性。字符串条件保留，不改变端点与源码证据的校验；数字、布尔、对象或数组条件仍拒绝。

20 项相关 TypeScript 回归通过，核心编译通过。包含无条件边规范化、字符串条件保留、错误端点及非法 condition 类型验证。

复验原始采购/退款真实 A2 输出（不改模型输出、不重新调用模型）：采购的 3 条 condition:null、退款的 2 条 condition:null 不再导致整份图 UNAVAILABLE。两个案例现为 PARTIAL。

采购仍有 request_json 辅助函数被引用为业务 toolName，当前引用归属校验拒绝它，连带其引用的节点不能确认；部门配置也待补。退款源码引用均通过，拒绝引用为 0，business-api 依赖契约仍待确认。这些属于后续诊断问题，不在本次 null 修复范围。未宣称完整端到端通过。

原始输出复验记录：reports/chain-null-condition-fix-20260918.json。
