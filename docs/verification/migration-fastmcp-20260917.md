# Python MCP FastMCP 交付验证

新生成的 Python MCP 服务改用独立包 FastMCP 2.14.7。迁移 Agent 的系统指令、交付技能包、Python 服务骨架以及平台传给 A4 的 deliveryContract 已同步更新。

业务工具通过具名函数、类型注解和必要的 Pydantic 约束定义接口；实际 tools/list 结果与基线核对，差异记录原因。Credential 与隐式上下文继续从当前 HTTP 请求的声明 Header 读取，获取和刷新凭证属于 Runtime Provider，不新增 MCP 身份建立或鉴权门槛。

服务声明自身依赖，Streamable HTTP 端点 /mcp，读取 PORT、监听 0.0.0.0。骨架使用 get_http_headers 和 FastMCP.run，不依赖平台安装的 openJiuwen。

检查结果：TypeScript 编译通过，30 项相关迁移回归测试通过（reports/migration-fastmcp-tests.json）。

真实生成入口：`node scripts/verify-migration-live-delivery.mjs --regenerate reports/migration-live-delivery-2026-09-17T09-37-30.583Z`。此模式复用已保存的真实 A2 诊断，重新调用真实 A4，不将回放输出表述为新模型生成。验收启动生成的服务并检查实际业务 Header，脚本在独立 workspace 执行。

真实 A4 结果：PASSED，上游 deepseek-v4-flash，约 291 秒。报告目录 reports/migration-fastmcp-delivery-2026-09-17T10-15-37.416Z，模型输出、生成文件、契约请求和技术验证结果均已保存。Python MCP 服务实际导入独立 FastMCP 2.14.7，包含 Dockerfile 与 README；Docker 镜像构建尚未执行。

最终接口路径复验：复用上述新模型输出，在 reports/migration-delivery-repack-2026-09-17T10-22-14.644Z 重新打包验收，result.json 为 PASSED。按生成服务的完整接口 URL 配置 BALANCE_SERVICE_URL，受控业务后端实际收到 /balance、account=A1、正确 Credential 与租户 Header。旧服务使用根地址配置，最初的生成验收沿用了该设置；补验收已严格检查请求路径，未修改模型业务代码。

该复验目录中的 candidate-unverified.zip 是最终交付包。Script 在独立 workspace 消费包内费率资源，输入 amount=100 得到 fee=2.5。包内无重复原始费率资源或 legacy_runtime.py。

验证范围仍不包含生产企业 Provider、完整原版对比或专业业务效果评审，因此交付 ZIP 保持 unverified 标记。
