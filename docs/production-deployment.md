# 生产部署

本套脚本面向可信运维人员使用的私有工作区：一个 Node API/迁移协调器，一个 OpenJiuwen Runtime，真实模型和 Judge 由企业提供。单 Skill 和多 Skill 统一在一个完整候选工作区中执行，任务验收时加载全部成员。代码与排障位置见 [当前架构](current-architecture.md)。

| 方式 | 入口 | 日志托管 |
| --- | --- | --- |
| Linux 直接部署 | [Linux 指南](production-linux.md)、deploy/linux/manage.sh | systemd/journald |
| Docker Compose | [容器指南](production-docker.md)、deploy/docker/manage.sh | Docker json-file 轮转 |
| Windows 服务 | [Windows 指南](production-windows.md)、deploy/windows/manage.ps1 | WinSW 文件轮转 |

根目录 Dockerfile/compose.yaml 是旧版 Node-only 示例；scripts/start-openjiuwen.cmd 是开发启动入口。完整生产部署使用上表入口。

## 共同约束

- Node >=22，pnpm 精确匹配 package.json（当前 10.34.4）；Python 3.11–3.13、uv 0.12.13，按 integrations/openjiuwen/uv.lock 安装。记录实际 Node 补丁版本、OS 和镜像 digest，基础镜像标签本身不是不可变制品。
- 数据目录仅允许一个 API 进程写入。当前文件存储不支持共享目录多副本、负载均衡双写或滚动升级。升级安排维护窗口，停止流量和任务后停机备份。
- 默认预检要求至少 1 GiB 空闲磁盘，FINANCE_EVAL_MIN_FREE_MB 可提高阈值；这只是启动检查，运行期需要磁盘告警。容量包含源码、候选、证据、日志、缓存和备份。
- 示例为单工作区令牌访问，令牌至少 32 个随机字符。企业 SSO/多租户须另行配置账户模式并验收；此处健康检查不代表账户模式验证。
- 仅 API 经 HTTPS 反向代理暴露。Runtime 具有执行代码能力，必须保留在 loopback 或私有容器网络。Runtime 没有独立认证或强沙箱，接入者、导入 Skill 和宿主权限须处于可信边界。
- 模型/MCP/包源的 DNS、出口、代理和证书由现场配置。默认镜像含 Node/Python；迁移 Java 等目标还需企业安装相应工具链并验收。

## 配置与预检

复制 deploy/examples/production.env 和 .runtime.local.example.json 到私有配置目录，填写 API 令牌、Analyzer/Judge 地址与密钥、Runtime 执行模型。FINANCE_EVAL_AGENT_MODEL_ID 必须匹配 runtime.json 中启用的别名；迁移 Agent 使用该模型，Judge 使用 JUDGE 三项或通用 MODEL 配置。

dotenv 作为数据解析，不由 shell source/执行。配置不进入 Git、镜像或普通日志。Linux 权限 0640（服务组可读）或 0600；Windows 限制 ACL；容器挂载的 runtime.json 必须允许 UID 1000 读取。

模型出口依赖代理时，在服务的受保护 env 中显式设置 `HTTP_PROXY`、`HTTPS_PROXY`，并用 `NO_PROXY=localhost,127.0.0.1,::1` 排除本机 Runtime；容器还应排除 `runtime` 等内部服务名。Python Agent 和 Node Judge 都支持这些变量，Judge 的独立请求连接池会保留超时限制并遵循代理配置。不要依赖交互终端或 WSL 自动注入的代理：systemd/SCM 环境可能不同。使用同一服务实例完成真实模型验收，单独在终端请求成功不能证明服务出网正常。

```sh
node deploy/preflight.mjs --env /absolute/private/production.env --ports
node deploy/health.mjs --env /absolute/private/production.env
```

预检覆盖占位符、绝对路径、端口、构建文件、真实 Python 导入和直接依赖固定版本、目录权限、磁盘。服务运行后不要对自身端口使用 --ports。健康检查验证 API、匿名请求拒绝、令牌访问、多 Skill Runtime 能力；**不调用模型，也不证明模型权限和业务验收成功**。

在 UI 目标环境中填写服务端可达的 Runtime 地址：原生部署通常为 http://127.0.0.1:56362，Compose 为 http://runtime:56362。浏览器只连接 API。

Runtime 执行超时读取请求 limits.timeoutMs，范围 10–900 秒，缺省 300 秒；该执行计时不含并发队列等待。网关超时需要覆盖排队和执行时间，服务停机则使用独立的较短清理期限。

## 上线与恢复验收

1. 预检、启动、健康检查；检查外部只能通过 HTTPS 访问 API。
2. 用真实迁移 Agent、Runtime、Judge，导入至少两个 Skill，完成整体迁移、联合验收、整体修复、留出验证和导出，核对成员、共享文件与冻结版本。见 [多 Skill 文档](multi-skill-migration.md)。
3. 在测试机运行 `node scripts/verify-production.mjs --env ...`，验证真实进程启停、冲突和崩溃恢复。它使用新临时数据和访问令牌，不修改现有数据，不消耗模型调用。
4. 停机备份，恢复到新目录并校验 hash；再用独立实例加载恢复数据，验证记录和候选可读，才算完整恢复演练。
5. 接入 [日志与告警](production-logging.md)，记录责任人、保留期、RPO/RTO、令牌和证书轮换流程。

对已安装的 SCM/systemd 服务运行真实 UI 验收时，在测试机设置以下环境变量，再运行 `node scripts/verify-bundle-migration-live-ui.mjs`：

- `BUNDLE_LIVE_ENV_FILE`：测试机上受保护的配置文件，包含目标服务访问令牌及真实 Judge 配置。
- `BUNDLE_LIVE_SERVICE_URL`：浏览器可达的 API 地址，例如 `http://127.0.0.1:56361`。
- `BUNDLE_LIVE_RUNTIME_URL`：API 服务端和测试机均可访问的 Runtime 地址，必须以 `/` 结束。适用于本机原生部署或专用测试网络；不要为测试开放公网 Runtime。
- `FINANCE_RUNTIME_CONFIG`：测试机可读取的真实模型配置路径，用于校验报告中的模型身份。

`MIGRATION_LIVE_MEMBERS=1` 验证单 Skill；缺省或 `3` 验证三个 Skill。两种场景均使用相同统一流程，报告记录成员数量。

设置 `BUNDLE_LIVE_SERVICE_URL` 后，测试直接使用现有服务，不启动独立 API/Worker，不开启服务端详细 dump，也不停止现有服务。它会通过 UI 创建唯一命名的三 Skill 任务与 Runtime 登记，调用真实模型并保留业务数据，执行开发集、必要的整体修复、独立留出集及交付包下载。测试须在已授权的验收实例执行；结果在 `reports/bundle-live-*/result.json`，其中 `deployment=EXISTING_SERVICE` 可区分服务级与独立进程验收。未设置该地址时保留原有临时进程测试方式。

备份包含密钥和业务内容，须放在企业加密存储并限制权限。SHA256 检测损坏，不提供签名或加密。恢复工具拒绝覆盖和越界路径，只写新/空目录；活动数据切换由运维在停机时执行。升级失败选择旧代码后保持停机，先判断数据兼容性，必要时恢复快照。不要将静态语法检查视为实际部署或真实模型验收。
