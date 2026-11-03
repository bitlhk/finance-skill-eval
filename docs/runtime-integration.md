# Runtime 接入与工程适配

三种入口共用的完整说明在 [Runtime 公共接入合同](../agent-roles/v1/references/runtime-integration.md)，也是工程准备 Agent 实际加载的资源。

- 自定义 Runtime：按现有 Launcher 接口返回结果与 metadata.process。
- Builder：构建合同要求 processEvidence，返回的 Launcher 使用同一格式。
- 完整工程：准备 Agent 在 candidate 里复用原框架回调、消息或事件采集，非流式也随最终结果返回过程。

不增加接口，不要求 OTLP、共享收集器或反向连接。历史遥测仍可读取。统一过程定义为 src/shared/contracts/runtime-process.ts；校验和旧工具证据投影在 src/evaluation/domain/runtime-process.ts。现有证据查询、Judge、诊断和页面复用 /process。

使用 pnpm runtime:check 检查声明和实际响应。compatible 只说明能力声明；execution 检查协议及关联，不代表业务验收通过。PARTIAL/UNAVAILABLE 明确缺口，不阻断纯答案评测，也不能作为过程通过的证明。
