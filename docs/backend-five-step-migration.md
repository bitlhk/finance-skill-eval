# 后端五步迁移记录

## 约定与范围

前端保留现有主题、页面和操作入口。HTTP API、账户身份、任务、资产、Git 文件版本和历史留档继续使用原有合同和持久目录。后端直接位于 `src/`，不增加 Python 包名目录。

用户已确认撤掉旧 npm 编程接口，保留 HTTP 和命令行。原 npm 导出、TypeScript 控制器和回调注入方式随之移除；不再保留可执行的旧后端。命令 `pnpm serve`、`node dist/service/server.js` 和 `finance-skill-eval replay --pack … --out …` 进入同一 Python 实现。

## 1. 明确职责和数据合同

| 位置 | 责任 |
| --- | --- |
| `web/` | 页面、输入、流式展示、表单提示 |
| `contracts/platform/` | 请求 JSON Schema、公开响应类型、前端评测方案格式校验 |
| `src/api/` | HTTP、认证、工作区上下文、流式输出、CLI |
| `src/migration/` | 迁移任务控制、Agent 续接、基础验证、效果评测、Builder 衔接、交付 |
| `src/evaluation/` | 固定对比流程、评测方法、证据核验、Judge、重复运行、重评和人工复核 |
| `src/improvement/` | 优化任务控制、目标预算、工程调整适配和版本选择规则 |
| `src/agents/` | 主 Agent、诊断 Agent、Criterion Judge、独立 Review 的调用装配 |
| `src/runtime/` | Jiuwen Runtime、业务 Launcher、MCP、Builder、模型和隔离工程执行适配 |
| `src/storage/`、`src/assets/` | 持久化、跨进程协调、Git、会话记录、资产和交付安全 |
| `integrations/openjiuwen/` | 框架会话、实例调度、检查点、上下文处理和业务 Worker |
| `src/resources/agents/` | Prompt、指导 Skill 和参考材料 |

`src/` 已没有 TypeScript。前端不导入后端源码。`evaluation-plan.js` 只供页面检查表单结构，后端使用公开 JSON Schema 和所属能力的业务检查独立验证请求。

## 2. 收敛前端边界

页面继续使用已有 HTTP/SSE 协议。配置是否有效、运行是否完整、重复运行统计和人工意见的当前结论由后端返回；页面负责展示与输入。

工作产物、计划进度、对话、用户补充信息与暂停续接继续走同一迁移会话，没有为了语言迁移新建页面或另一套任务模型。

## 3. 收回迁移控制器

`api/migration_routes.py → migration/service.py` 是唯一公开迁移控制链。主 Agent 通过 `runtime/agent_client.py` 调用 Jiuwen Runtime，不由 TypeScript 拉起一次性 Agent 进程。

现有 `control.py`、`lifecycle.py`、`execution.py`、`acceptance.py` 和 `optimization.py` 继续作为共同规则。`execution_ports.py` 与 `acceptance_service.py` 直接接入这些程序，复用仓储、业务 Launcher、Judge、Builder 和 Review。没有复制一个 Python 工作流再与旧工作流并存。

基本验证和效果验证分开记录、诊断和修复。主 Agent 自主读取指导 Skill、代码和工具，决定分析、调整、询问或验证；应用控制器固定负责权限、幂等、证据归属、预算与安全交付。

## 4. 收回评测与优化控制器

`api/run_routes.py → evaluation/service.py` 保持固定对比流程：冻结题目与配置、运行、收集证据、判定、汇总和清理。真实业务重复运行与仅重评 Judge 是不同操作；重评不再次执行业务，也不改写原报告。

业务运行统一使用 `runtime/launcher.py` 和 `evaluation/execution.py`。规则、模型、脚本、状态和执行标准等方法通过原有评测程序组合；模型通过不能覆盖必选脚本失败，缺失证据不能算作成功。原工程、候选效果、匿名对比和跨 Runtime 对比共用底层能力。

`api/improvement_routes.py → improvement/service.py` 负责独立优化任务。现有 OpenJiuwen 优化协调 Agent 自主调用诊断、调整、评测和独立 Review；平台不再通过标准输入输出回调 TypeScript。工程调整复用迁移主 Agent 和 Git 工作区，Skill 与随包工具可以一起修改。

优化保留目标、轮次、时间预算、必须通过的案例、用户提问续接、独立留出集、Review 和人工采纳。一般案例回退交给 Review 结合目标权衡；可以在新版本上继续修复。只有审查认可的版本才能成为最终推荐；采用决定不覆盖原始资产或远程部署。

人工标注、争议裁决和 Judge 校准统一在 `evaluation/human_review.py`，复用历史 RFC 8785 指纹，旧标注仍按原证据归属显示。

## 5. 切换入口、部署和旧实现清理

默认服务入口为 `api/__main__.py` 和 `api/server.py`，使用 FastAPI/Uvicorn。开发启动器和部署管理器选择项目专用解释器并启动该 HTTP 服务；Node 只承担启动、前端构建和一次性旧资产排序元数据导出。

旧 npm 导出、TypeScript 后端、标准输入输出能力桥、仅供旧 SDK 使用的内部模型/评测代理、旧格式校验 Node 子进程及相关 SDK 示例已删除。`dist/service/server.js` 和 `dist/cli.js` 是保留原命令路径的薄启动文件，构建时重新生成。

Git 版本信息在接收任务前准备，报告生成不启动 Git 子进程。工程 Git 操作统一使用非交互文件句柄；Windows 上并发原子替换的短暂共享冲突使用有限重试，损坏 JSON 仍然报错。

Python API、主 Agent Runtime、被测业务 Launcher 是三个角色，可分别部署；现有 Docker 配置及 Windows/Linux 管理器均能显式管理它们。用户自定义 Launcher 可以远程部署。主 Agent Runtime 的实例调度、会话、检查点及上下文压缩继续复用框架。

多副本当前使用约定的共享持久目录。任务和优化执行归属由跨进程文件锁保护，不使用副本内缓存作为事实来源；进程死亡后释放锁，恢复依据持久任务与 Runtime 执行日志核对。

## 验证口径

- 旧 SDK 测试针对已经撤销的类和回调注入方式，随旧接口退役；范围与原生回归入口记录在 `verification/python-backend-cutover.json`。不以新旧测试数量宣称一一等价。
- `pnpm check` 检查公开类型和前端；`pnpm test:web` 检查页面与交互；`pnpm test:python` 使用检查过的项目环境发现后端测试。
- `scripts/verify-native-http.mjs --ui` 从正式启动入口运行真实 HTTP/SSE、对比评测、冻结证据重评、报告导出、人工复核、Git 工程创建、完整工程上传，并通过浏览器检查原页面。
- `tests/live_native_platform.py` 是显式开启的真实模型联调，启动独立数据目录中的 API、主 Agent Runtime 与业务 Launcher，验证真实缺陷的评测、优化和迁移。测试数据与用户原工程分开。

完整业务工程的兼容性以其真实运行结果为准；普通 HTTP 上传通过不等于该工程已完成业务迁移验收。

本轮实际检查、模型切换及联调问题记录见 [Python HTTP 切换验证](verification/python-http-cutover-20261106.md)。

### 2026-11-07：完整企业工程真实回归

在包含四个 Skill、九个实际业务工具的完整 Agent 工程副本中完成迁移与真实运行，基线使用原 AgentScope 入口，目标使用 OpenJiuwen Launcher 和共享 HTTP MCP。原工程的 32 个文件散列保持不变。基础验证与效果验证分别留档；正式导出核对当前文件、配置、测试集及独立审查，不复用过期版本的通过记录。

- 当前工程的 23 项测试通过，包含同一个 MCP 服务的双用户交叉与并发访问、缺失和非法身份拒绝、订单归属及越权后状态保持、员工查询数组和字符串两种输入。身份来自可信请求 Header，继续由原业务服务校验权限；部署方沿用既有网关或登录认证，Header 本身不是认证。
- 六个业务场景通过：权限查询、聊天身份篡改、信息不完整时的澄清、六轮预订—修改—取消、真实图片识别、员工目录查询。
- 四组八个原工程对比案例的目标与必要执行检查通过。相对输出盲评为目标三胜、原工程两胜、三平，原始评价保留；不能把业务达标解释为全部输出优于原工程。
- 独立优化在冻结条件下完成一轮诊断、调整、真实复测、独立 Review 和采纳；结论仅覆盖其选择的开发案例。本轮身份和参数契约修复另作回归，不虚增优化轮次。
- 当前文件版本的独立基础与效果 Review 通过，正式交付导出通过已配置密钥扫描。未执行的留出集、其他框架、生产单点登录和外部 Builder 重建不列为已验证能力。

本次实际联调修复了 MCP 包装层把逐请求身份退化为进程用户、丢失员工查询联合输入类型，以及 Runtime 固定工具超时低于源图片工具等待上限的问题。Runtime 复用任务超时预算；连接清理异常保留真实过程并报告失败，进程退出诊断不再被缺少过程字段的错误覆盖。原失败记录保留。

最终代码回归：`pnpm test:python` 414 项通过、3 项跳过；OpenJiuwen 适配层 170 项通过、1 项跳过；`pnpm check`、15 个文件共 40 项 Vitest、`pnpm build` 和 `git diff --check` 通过。真实业务数据、运行日志与模型配置继续存放在原有私有数据目录，不作为源码的一部分。
