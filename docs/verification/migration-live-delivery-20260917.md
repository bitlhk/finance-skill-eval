# 真实模型 A2/A4 迁移验收

模型：本地 enterprise-model 绑定，实际上游 deepseek-v4-flash。A2 与 A4 都调用真实模型，没有固定分析或生成输出。

报告目录：reports/migration-live-delivery-2026-09-17T09-37-30.583Z。

结果：PASSED。A2 约 202 秒，A4 约 176 秒。

输入是受控企业余额与服务费 Skill：余额从原执行上下文消费字符串 Credential 和 tenant_id，服务费从脚本同目录 rates.json 读取费率。没有使用生产企业数据或生产凭证。

实际结果：

- A2 依赖诊断 COMPLETE，源码引用拒绝数为 0；正确区分 Runtime Credential、租户标识、原上下文机制，以及 Tool 费率资源和业务接口。
- A4 生成 Python MCP 服务和 Python command 脚本，交付绑定与环境变量配置模板一致。
- 配置模板不含真实测试值；生成阶段的余额业务调用明确 callExecuted=false，服务启动/工具发现已验证。
- 生成后配置测试值，平台实际启动 MCP 服务并调用 balance。受控业务 HTTP 后端确实收到 account_id=A1、正确 Credential 和租户 Header。
- Script 在独立 workspace 执行，通过脚本位置定位包内费率资源，输入 amount=100 得到 fee=2.5。
- 候选 ZIP 可导出；仍标记 unverified，没有完成专业效果评审或完整原版对比。

本轮发现的问题：

- 脚本打包为 skill/scripts/quote_fee/scripts/quote_fee.py，Agent README 仍使用生成时的 scripts/quote_fee.py。Skill 中平台追加的执行指引和 Runtime 启动索引已经使用实际路径，因此技术执行通过，但 README 不能直接按旧命令复制运行。需要统一打包与交付文档的路径重写。
- 包内存在重复费率文件及不再被新 Tool 使用的原上下文模块，后续需完善归属清理。
- 此版本配置消费最终 Credential，尚未验证企业 Provider 的获取、刷新和动态身份接入。

交付包修复复验（2026-09-17）：

- 复用上述真实 A2/A4 原始输出，通过修复后的平台流程重新生成候选，没有重新调用模型，也没有手工改写模型代码。
- 最终报告：reports/migration-delivery-repack-2026-09-17T09-52-02.600Z，result.json 为 PASSED；修复后的包为该目录下 candidate-unverified.zip。
- 脚本入口为 skill/scripts/quote_fee/quote_fee.py，费率资源为同目录 rates.json；README 命令与入口一致。重复原始费率文件和已迁出的 legacy_runtime.py 已清理。
- 清理依据诊断中的 resolvedPaths 和工具归属；仍被未迁移工具消费的依赖保留。文档路径按文档所在目录重写，源包归一化阶段对已替换入口产生的误报也消除。
- 平台实际启动生成的 MCP 服务，受控业务接口收到正确 Credential 和租户 Header；脚本在独立 workspace 实际执行并得到 fee=2.5。
- “未验证生产企业 Provider”具体指：测试使用预设最终凭证，未接入企业真实身份系统或鉴权 SDK，未验证动态凭证获取、刷新及权限失败。这是 Runtime 接入的验证范围，不能表述成 Tool 应实现身份建立。
- ZIP 仍标记 unverified，因为尚未完成专业效果评审和完整原版对比。

这次执行验证真实迁移模型与实际工具调用；没有调用真实执行模型来验证完整 ReAct command 选择，也没有证明任意企业源工程都能正确识别和迁移。

可复现入口：scripts/verify-migration-live-delivery.mjs。原始 A2/A4 结果、候选代码、配置模板与技术验证结果均保存在报告目录。source.zip 与 candidate-unverified.zip 可用于审阅。
