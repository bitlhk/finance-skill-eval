# Python HTTP 后端切换验证

本轮将 HTTP 主入口和迁移、对比评测、优化、人工复核控制器统一到 Python。用户已确认撤掉旧 npm 编程接口，保留原 HTTP 和命令行入口。原始业务数据、账户配置、资产、历史报告和 Git 工程未删除。

## 已通过的检查

| 检查 | 结果与边界 |
| --- | --- |
| 项目解释器 | `.venv-openjiuwen`，Python 3.12.14，OpenJiuwen 0.1.17.post1，与锁文件一致 |
| 类型检查 | `pnpm check` 通过，涵盖公开声明和现有前端 |
| 前端回归 | 15 个测试文件、40 个断言通过 |
| Python 业务回归 | 384 项：381 通过，3 项按条件跳过；不包含外部真实模型验收 |
| 模型与会话专项 | 93 个检查通过，覆盖原生及文本工具传输、错误反馈、角色选择、框架会话、工具登记、审查冻结、Runtime 与优化协调；另有模型超时和 SDK 重试专项检查 |
| 原生 HTTP 与浏览器 | 认证、资产目录、对比报告、SSE、冻结证据重评、导出、人工复核与校准、Git 任务持久化、完整工程上传通过；正常路径与 `/migration/` 私有子路径页面均通过 |
| CLI | 原 replay 入口生成 JSON/HTML 报告；`runtime:check` 使用公开能力合同通过，不把协议符合当作业务验收通过 |
| 企业工具示例 | 原生 Python 合同与实际 MCP 示例离线验证通过；不代表真实企业远程服务通过 |
| 部署配置 | Windows 三服务 XML 配置检查、5 项部署设置测试、WSL 的 Linux/Docker 管理脚本语法检查通过；未安装系统服务 |
| 实际 Docker 部署 | WSL Docker 完成三服务启动、框架实例调度、认证、自动重启、持久化、备份/独立恢复及同产物标签升级/回滚；容器内执行原生 HTTP 八项接口检查通过 |
| 实际工程隔离执行 | Windows 经 WSL 执行工程/验证器隔离测试 12 项通过；Linux 容器内部工程通过共享临时目录在宿主 Docker 执行，原工程未改变 |
| 实际开发服务 | Python API 56361、业务 Launcher 56362、主 Agent Runtime 56363；认证、工作区目录及两类 Runtime 健康检查通过 |

SDK 测试退役清单与替代回归入口在 [python-backend-cutover.json](python-backend-cutover.json)。测试数量不代表新旧 SDK 行为逐项等价。

## 真实模型联调

测试通过公开 HTTP 启动任务，使用实际 Jiuwen Runtime、业务 Launcher、模型 Judge 和工程 Agent。输入为隔离目录中的本地纯计算 CLI 及 Skill，包含“容量等于人数”错误边界；不调用真实会议室预订服务，不修改用户原工程。

旧模型 `Qwen/Qwen3.5-122B-A10B` 的真实业务执行、过程证据与评判已通过；其优化、迁移在多次调用后被供应商 TPM 限流拒绝。事件表明已有成功文件读取，不是 HTTP 或 Runtime 启动失败。小请求也已单独验证可用。

按用户要求，主 Agent、优化与内置业务模型绑定已切换为 `Qwen/Qwen3.5-27B`，独立评审仍为 `deepseek-v4-flash`。更换执行模型后建立新基线，未将旧模型报告与新模型候选混合比较。

第二轮从当前规则重新建立基线并通过完整优化：六次源版本业务执行、答案与过程判别 → 诊断 → 主 Agent 联合修改 Skill 和实际 CLI 源码 → 六次候选业务执行与判别 → 独立 Review → 采纳。基线相等边界失败、另外两例通过（2/3）；候选三个案例均通过（3/3），Review 为 KEEP_CANDIDATE，最终状态 adopted。全部运行与原资产分别保存。证据目录为 `artifacts/native-live-x5p1kqh0`，原模型中断或格式不兼容的失败记录也保留。

公共工具适配及版本登记修复后，又通过公开入口重新跑完一轮真实优化：`opt-48966692-7625-47c8-a3dc-65e31874deb4`，复测 `run-2bda115b-138a-4421-a93a-c35ddc6b19b1`。实际变更同时包含 `SKILL.md` 和 `scripts/check_capacity.py`，三例全部通过，独立 Review 为 KEEP_CANDIDATE，`targetReached=true`，最终 adopted。该轮没有复用上次候选作为成功结果，也没有替换模型、工程 Agent 或 Judge 为固定返回。最终三流程汇总 `verification.json` 的 `completed=true`，成功日志为 `logs/python-native-live-final-optimization.log`。

SDK 的有限重试通过服务端 `FINANCE_EVAL_MODEL_MAX_RETRIES` 配置，部署默认仍为 3。本机低 TPM 联调和开发服务配置为 12，仍使用既有调用超时。没有为限流增加另一套任务重放或供应商调用实现。真实长会话仍观察到明显等待时间，不能据此宣称并发性能已达生产要求。

## 本轮联调发现并修复的问题

- Windows 下阻塞读取停止指令会妨碍数值依赖初始化：服务停止通道改为可用字节轮询，保留原停止协议。
- Git 子进程继承输入或管道阻塞：工程 Git 操作统一使用非交互文件句柄和有限超时；报告只读取启动时准备的代码版本信息。
- Windows 原子文件替换时短暂共享冲突：公共 JSON 读取器加入有限重试，损坏数据仍报错。
- Launcher 声明接收采样参数却没有应用：参数现已传给实际模型，并返回核验回执。
- 执行失败后仍触发昂贵过程 Judge：改为记录未核验原因，不为不存在的完整执行评分。
- Criterion Judge 不能读取 Markdown 包装的 JSON：复用已有宽容解析，再核对标准、字段和证据；不放宽业务判断。
- 候选文件读写路径不一致：读写现在共同识别 `candidate/...`，不再写入重复候选子目录；原工程与任务资料的相对路径也受到写入保护。真实框架文件工具与多 Skill 编辑的 28 项回归通过；无效联调轮次已取消，没有进入采纳。
- Docker 基础镜像的系统 Python 3.11.2 不符合项目要求：改为由 uv 安装并使用受管理的 Python 3.12，解释器位于容器共享可读目录。部署停止操作覆盖 API、主 Agent Runtime 和业务 Launcher 三项服务。

实际 Docker 结果见 `logs/python-http-docker-smoke-final.log`、`logs/python-http-docker-native-api.log` 和 `logs/python-docker-shared-execution.log`。部署测试的独立 Review 检查使用缺少证据时的拒绝路径，不冒充真实模型审查。

- 长评测工具被框架默认 300 秒截断：复用 SDK 单工具的超时声明，由框架上限和既有模型、业务、任务预算约束；不修改 SDK 或另造调度器。
- 文本工具兼容模式向只允许一个 system 消息的网关发送两个 system：合并原始前置 system 消息与工具目录，保持内容和优先级；SDK 两次真实调用形态回归通过。
- 单次评测入口混入持续优化参数，Agent 重复填空基线：将两个工具入口分开，共用原提交、验证和续接实现；实际 NativeHarness 回归确认单次评测只调用一次模型，不要求优化基线。
- 工具拒绝原因没有进入对话：现在展示脱敏后的原因；空模型响应也明确说明工作和已完成验证已保留。
- 答案质量与过程核验混用：答案 Judge 不接收执行标准，不因答案未展示工具日志扣分；过程 Judge 继续独立核对真实证据。专业评分明确采用 0–4 的绝对分，不用 0/1 胜负标记替代。
- 网关流式响应停顿或只返回思考片段：允许 Runtime 模型设置 supportsStreaming=false，主 Agent 与业务 Worker 都复用 SDK invoke 获取完整响应；平台 HTTP/SSE 和中间工具事件不变。SDK 重试次数与超时配置也应用到业务 Worker。
- Windows 普通绝对路径和扩展长路径被误认为不同目录：公共路径校验按同一文件系统身份核对，保留原工程只读和目录边界；33 项相关回归通过。
- 公共文本工具适配兼容完整 JSON 调用、连续 JSON 调用，以及含明确 JSON 参数的完整 XML 调用，保留进展说明和全部调用，不只提取第一个参数对象。工具名与参数对象须明确；参数规范化、校验及错误反馈复用 SDK 和原工具，不在适配层重复拒绝后误当成最终回答。仅缺最外层一个结束括号且完整参数对象可确定时补齐结构，不补写字符串、字段或值；参数截断、残缺 XML 及示例不执行。已发布候选在调整阶段中断也可核对摘要后接续，不重新修改。
- 27B 在长主会话的一次原生调用中返回残缺 `query_delivery_tools` 标记及大量空白，未执行工具：没有猜测执行残缺请求，主 Agent 按角色使用既有文本工具兼容模式；不改变业务 Launcher。角色隔离与显式绑定优先级的模型回归通过，小请求已分别实测原生与兼容模式均可调用工具，因此不将该故障描述为模型完全不支持原生工具。
- 文本兼容多轮历史混入原生调用记录，模型重复漏参：出站历史统一转为明确的工具名、原参数和标注为数据的工具结果；SDK 会话内部仍保留原工具记录。完整调用优先于通用回答 JSON 提取，不将调用里的参数误当成最终回答。真实 SDK 和边界解析回归通过。
- 实例明确失败被误记为传输没有结果：私有实例返回经过限制的异常类型，Runtime 记录为明确的 FAILED 结果；内部定位日志只保留异常类、源文件名和行号，不转发原异常中的凭据或业务内容。
- 交付审查继承工程模型、看不到工具登记事实：审查子 Agent 使用已配置的 JUDGE 模型；主 Agent 查询实际登记，审查者读取冻结登记材料，不要求用户猜测内部状态。
- 单次测试集缺少原工程效果基线时无法最终审查：共用 Review Agent 新增 GOAL 模式，只审查目标达成和证据范围，不记录虚构基线或提升/回退；原比较和持续优化模式保持真实基线。状态、引用、旧配置失效及完整交付的专项测试通过，同一 SDK 子 Agent 的独立上下文测试也覆盖两种模式。
- 单次评测返回后旧续接限制挡住再次评测：同一主 Agent 可以按原目标修复并复测，仍须满足 Runtime、测试集和证据条件；不能借此绕过已有优化轮次。32 项主 Agent 与独立 Review SDK 回归通过。
- 单次效果 Review 后错误套用优化停止提示：普通迁移继续完成原任务中尚缺的基础验证、交付审查和产物，不因效果达标就跳过交付；真正的优化仍遵守目标与轮次。
- 相同工具重复登记生成新版本：内容和登记完全相同时保留原版本及证据绑定，真正改变文件或工具契约时才生成新版本。真实的旧重复版本保留审计，联调对当前版本重新评测，没有修改旧评测的身份。
- 文件读取工具仍宣称只接受绝对路径：说明改为实际已支持的任务相对路径，减少模型手工拼接 Windows 长路径的错误；原有工作区读取边界不变。

本机内置 Runtime 模型配置有效上下文预算和 `thinking_budget=2048`；主 Agent 单独通过角色配置设置 `enable_thinking=false`，输出预算从遗留的 128,000 调整为 8,192。参数经真实 SDK 请求验证，均属于本机可信配置，不由上传工程提供。参数定义见 [SiliconFlow Chat API](https://docs.siliconflow.cn/docs/api/chat-completions-post)。这些配置不提高供应商配额。

本机工程基础测试配置复用 WSL Ubuntu 中已有的 `python:3.12-slim-bookworm` 镜像，不修改用户工程或全局 Python。最终镜像使用正式 `deploy/docker/Dockerfile` 完整构建，包含当前前端、契约与 Python 代码：`finance-skill-eval:python-http-final-check`（`b43f7634b0fe`）。三服务实际启停、Runtime 实例、异常重启、持久化、备份恢复与同产物标签升级/回滚通过，未调用模型。

正式镜像只读、无网络的 9 项 SDK 检查也通过。部署证据见 `logs/python-http-production-final-build.log`、`logs/python-http-production-final-smoke.log`、`logs/python-production-final-sdk.log`。原开发端口 56361/56362/56363 已用最终代码重启，健康、认证、工作区及两种 Runtime 检查通过，未删除原任务和资产。

真实迁移已通过：任务 `bundle-052906bb-bb73-4f3a-8d77-11b54080761f`，当前版本 `candidate-9652ef22-fedd-4819-91a4-d765d181ab4a`。基础命令回执及独立审查覆盖本次范围，当前版本运行 `bundle-run-05008c30-c6cb-4622-b81d-0102c67c3235` 三例全部通过，独立 GOAL Review 认可达标，`deliveryVerification` 成立。通过 `export?verified=true` 下载正式包后，将包内 CLI 放入隔离环境再执行三个边界，全部通过。证据见 `artifacts/native-live-x5p1kqh0/verification-migration-complete.json` 和 `migration-delivery.zip`，完整成功日志为 `logs/python-native-live-migration-structural-repair.log`。

失败/中断的调试任务不计为验收通过。测试工程为隔离的本地纯计算 CLI，不能据此宣称用户完整企业 Agent 或其远程 MCP 服务均已验收。
