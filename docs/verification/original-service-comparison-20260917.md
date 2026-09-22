# 原服务接入对比验收

测试页先选择目标评估或原服务对比，再呈现相应配置。测试集可导入或 AI 生成；原服务模式可只提供任务，不要求额外写目标。缺少独立目标的题集只能用于有原服务基线的对比。

原服务支持 HTTP POST JSON 模板、嵌套请求字段、JSON Pointer 响应映射与纯文本响应。请求头从平台进程环境变量读取。SC 计划冻结源关联、候选资产、题集和配置摘要；源关联是用户声明，不伪装为原 Runtime 已加载。原服务响应获取成功记录 CAPTURED。模型输出校验要求覆盖、索引唯一及两侧逐字引用；超时、执行失败、字段不存在、伪造引用与无法判定不成为验收通过。

真实链路结果：[result.json](../../reports/original-service-comparison-2026-09-17T15-01-55-777Z/result.json)。使用 deepseek-v4-flash 和 OpenJiuwen 0.1.17.post1。

- 首轮真实 A2 在约 123 秒完成源码分析，识别 read_document 为 Runtime Harness；之后复验复用其原始输出和完全相同的源码 ZIP，没有用固定伪造分析替代。
- A4 复用上一轮真实模型交付的原实现与独立插件包装层；本次没有重新调用 A4，原实现内容逐字核对一致。
- 通过实际迁移 API 完成导入、检查、候选打包、测试集冻结、环境注册和 validate/openjiuwen；左侧实际 HTTP 服务独立调用原 Python 实现，右侧实际 HTTP Worker 使用 DeepAgent 加载迁移插件和 Skill。
- 两侧均实际读取同一受控文档；右侧成功调用原名 read_document，候选摘要匹配；左侧不声称原 Runtime 身份已核验。
- 请求模板将任务放在 request.message，case_id 为同题 ID；原服务响应映射 /data/result。服务确实收到受控 Authorization，未收到验收要求。
- 实际对比模型返回 equivalent=PASS、wrong-target=FAIL；两侧一致没有让故意错误的验收目标通过。
- 原服务基线 CAPTURED，整体候选验收仍因故意负例失败，导出保留 unverified 标识。这是测试预期，不是全部业务用例通过。

首轮缺少阅卷模型配置、后续引用拼接与要求拆分错误均保留原记录，没有覆盖成成功。修复模型提示后，先在相同真实回答上复核，再重新执行完整 HTTP 与模型评估链路通过。独立复核记录：[result.json](../../reports/original-service-rejudge-2026-09-17T15-00-44-889Z/result.json)。模型重试明确无效引用、实际与预期索引；始终保持严格校验。

验证范围是本地可信源码、受控凭证与文件读取 Harness。未证明生产企业身份系统、任意协议、两个 Runtime 完全等价或所有企业源工程均可正确迁移。SSE/轮询型原服务协议未纳入此首版 HTTP POST JSON/文本接入。

相关 TypeScript 回归覆盖原服务实际 HTTP 请求、认证头、任务映射、失败与超时、两侧引用、模型重试、前端选择及跨阶段绑定。Core/Web 类型检查、核心构建和前端生产构建通过。
