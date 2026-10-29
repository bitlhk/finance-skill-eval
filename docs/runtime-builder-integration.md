# Builder 接入

Builder 只接收 Runtime 能力需求。业务 Skill、入口指令和业务配置属于实例启动，不参与 Runtime 制品构建。

## 操作流程

1. 在 Eval 选择 Skill、完成诊断并生成整体候选。
2. 在“选择与配置 Runtime”中选已有环境，或导出 Builder 能力需求。指定目标平台、架构和容量；原生能力须有完整输入、输出、错误、权限、副作用和隔离合同。
3. 将需求交给 Builder 的 `engineering/build_runtime.py` 或 Runtime 构建控制台。Builder 用自己的验证资产检查真实执行与资源释放，返回 Result；构建进程退出后部署独立运行。
4. 回填 Result 并选择管理员预先配置的信任引用。Eval 校验协议、需求摘要、制品、部署、能力及证据，实际启动平台验证实例，执行工具并释放。
5. 进行启动检查，随后运行开发和留出用例。每个案例的新实例装载完整 Skill 集合。
6. 联合验收通过后导出交付包。

需求导出和回填 API：`/api/migration-tasks/:id/runtime-build-requests`、`runtime-requirements.yaml`、`runtime-deliveries`。Builder 本身不调用 Eval 的任务 API，也不接收 taskId、candidateId、Skill 源码或留出集。

## 版本与失效

| 对象 | 标准协议 | 绑定内容 |
|---|---|---|
| 构建需求 | finance.runtime-build-requirements.v3 | 能力合同、平台、功能和容量 |
| 构建结果 | finance.runtime-build-result.v3 | 请求摘要、能力证据、制品及部署 |
| Launcher | finance.runtime-launcher-descriptor.v2 | 服务身份、协议及能力摘要 |
| 能力 | finance.runtime-capabilities.v1 | 实际模型、平台、功能和限制 |
| 启动 | finance.runtime-instance.v1 | skills[]、资源、配置与超时 |

旧构建协议、迁移 profile/receipt、旧实例格式和旧任务桥接均不再接收。历史文件不会自动删除。

Skill 或配置改变使业务验收失效；不会仅因成员数量或内容变化要求重建 Runtime。复用仍需满足实际容量和能力。Judge 配置、测试集、运行环境或候选变化后必须重新验收。Runtime 启动/执行证据不完整与 Judge 服务故障需先排障，不作为自动改写候选的业务失败。

## 运维

构建输出目录含私有连接信息和模型配置，仅服务账户可读；不要上传或放在静态网站目录。Result 不含凭据。清理只有收到明确 RELEASED 回执才成功，404 或空响应不能证明资源已释放。

Linux/WSL、Windows、Docker 安装入口见 [部署说明](production-deployment.md)。两端协议升级应一起发布，先备份旧数据；旧任务不会自动恢复。WSL 服务须设置 `NODE_ENV=production`，使用 Linux 私有状态目录，避免 SDK 在 Windows 挂载目录创建日志并修改权限。

[完整边界与实施检查项](runtime-contract-boundary.md) · [机器合同与示例](../contracts/runtime-builder/README.md)

## 部署时的启动与网络核对

Windows 宿主使用每次启动唯一的 launchId 核对就绪状态，避免虚拟环境启动器和实际 Python 进程 PID 不同导致误判。异常退出恢复依赖 Windows Job Object 的进程归属；旧组仍存在或归属无法确认时拒绝恢复，不自动重放已中断业务。

出口代理需显式配置到构建进程、Runtime 宿主和容器，并排除本地 Launcher 地址。Docker 的解释器和系统库必须匹配；不能假设宿主虚拟环境可直接移植到其他基础镜像。具体操作见 Builder 部署文档。Windows 与 Docker 的恢复验证均应包含恢复后的真实 Skill 执行和释放，只有端口可连通不足以证明恢复成功。

Builder 独立镜像通过 `engineering/build_runtime_image.py` 构建；`runtime_container.py init` 使用只读配置生成部署，`start` 仅挂载状态卷运行。宿主和原生 Runtime 的解释器、锁定依赖均在镜像内。导出容器 `/state/release/result.json` 回填 Eval，并配置同一 Linux host 网络下的 Launcher 信任地址及令牌。单个与多个 Skill 都在案例启动时注入，无须分别构建镜像。模型配置只在初始化时挂载，之后保存在私有状态卷中。

完整联调脚本 `scripts/verify-runtime-boundary-live.mjs` 可设置 `BOUNDARY_CONTAINER_IMAGE`、`BOUNDARY_CONTAINER_NAME`、`BOUNDARY_CONTAINER_VOLUME`，通过真实 Docker Builder 构建和回填，随后运行真实迁移 Agent、Runtime、Judge 的单/多 Skill 开发与留出验收。使用新容器名和新卷；在 Linux 下以 root 或 UID 10001 运行以正确设置配置权限。Eval 自身的运行依赖仍在 Eval 环境中，不能将其宿主解释器挂载进 Runtime 容器。
