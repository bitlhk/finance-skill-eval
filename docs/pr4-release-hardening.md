# Skill 迁移执行边界

上传、检查、生成和下载候选不需要执行脚本。技术验证或 OpenJiuwen 调用 Script Tool 时，默认拒绝本机脚本执行。

仅在专供可信代码的本地工作区设置 `FINANCE_EVAL_TRUSTED_LOCAL_SCRIPTS=1`，并重启评测服务及 Runtime。子进程使用最小环境、临时 HOME，超时和输出超限终止执行；这些措施不构成文件系统或网络沙箱。陌生上传代码必须交给另行隔离的执行环境，不能在存放凭据的共享服务器上启用此开关。

公开 Demo 保持脚本执行关闭，继续支持已有精选技能的 MCP 在线评测。迁移工作区仍仅限私有部署，不扩大公开路由权限。

MCP 技术验证区分协议响应与工具执行：`isError=true` 必须失败，缺少合法 CallToolResult 结构也不能通过。

验证命令：

```sh
pnpm check
pnpm test
pnpm build:web
python3 -m unittest integrations.openjiuwen.test_script_process
```
