# Runtime Builder 接入

单 Skill 和多 Skill 都在迁移任务的「Runtime 适配与登记」阶段接入 Builder。平台导出整组需求和冻结源码，外部 Builder 构建、部署后回填 Result；平台执行 v2 整组生命周期检查，通过后绑定版本并进入业务验收。

## 操作步骤

1. 完成工程分析与候选生成，在运行配置中设置模型、入口指令、超时和脚本权限。未选模型时使用交付 Runtime 的默认模型。
2. 在「Builder 构建与交付」选择目标 Runtime。存在需要 Runtime 原生提供的能力时，在可选的原生能力合同中填写 `requiredCapabilities`；自动生成部分包含全部成员、共享服务、工程分析和运行设置。
3. 点击「生成并下载 Builder 需求」和「下载绑定的候选源码」。下载的 ZIP 对应需求记录中的候选，候选后来发生变化也不会悄悄换成新版本。
4. 将两份文件交给外部 Builder。Builder 核对摘要，构建、部署 Launcher，并返回带统一任务回执的 Result JSON。
5. 选择服务端配置的信任引用，导入或粘贴 Result，点击「验证并绑定 Builder 交付」。平台核验摘要、原生能力合同、模型、协议和资源限制，真实装载全部成员，执行连通检查并删除实例；成功后自动选择交付环境及模型。
6. 执行开发集、独立留出集验收，下载已验收交付包。Builder 生命周期检查不代替业务测试。

平台当前以文件交换对接外部构建，没有自动提交、轮询 Builder 构建 API 的客户端。已有合适 Runtime 时可以直接选用，不必经过 Builder。

## 服务端准入配置

在 API 的受保护环境配置中设置允许的 Launcher 地址前缀，再重启 API：

```dotenv
FINANCE_EVAL_LAUNCHER_TRUST_JSON=[{"reference":"builder-prod","label":"生产 Builder 交付","baseUrlPrefix":"https://runtime.example.com/launchers/","credentialEnv":"BUILDER_LAUNCHER_TOKEN"}]
```

`BUILDER_LAUNCHER_TOKEN` 的实际值由 API 服务进程环境提供。无需认证时将 `credentialEnv` 设为 `null`。浏览器只选择 `reference`，Result 不携带凭据。这个配置控制 Launcher 交付准入，不是 Builder 构建 API 地址。

## Builder 协议

保留现有 `finance.runtime-build-requirements.v1` / `finance.runtime-build-result.v1` 外层合同，通过有版本的 `extensions.migrationTask` 扩展表达统一任务。外层 `target.protocols.instance` 是 Launcher 基础 v1 协议；扩展明确要求同时实现 v2 整组实例。**即使只有一个成员也必须支持 v2**，不能忽略扩展并返回仅有 v1 能力的交付。

需求扩展 `finance.migration-task-build-profile.v1` 包含：

- 任务 ID、原始源码摘要、候选 ID 和整组摘要；
- 1～10 个成员的入口、版本和内容摘要，以及完整文件路径清单；
- 业务目标、目标环境要求、已有工程分析；
- `instanceSchemaVersion=finance.skill-eval.runtime-instance.v2`、`multiSkill=true`；
- `settings` 中的模型、入口指令、超时、Harness 工具，以及 `services` 中的共享 MCP 启动声明。

需求不包含测试集、冻结留出题或连接密钥。原生能力合同不会从自然语言分析自动推断成已验证合同；已知原生依赖需要填写完整的输入、输出、错误及约束定义。

Result 继续提供匹配的 `requestId`、`requirementsDigest`、Launcher 描述和构建验证记录，并必须在 `extensions.migrationTask` 提供：

```json
{
  "schemaVersion": "finance.migration-task-build-receipt.v1",
  "taskId": "从需求复制",
  "candidateId": "从需求复制",
  "candidateDigest": "从需求复制的64位十六进制摘要",
  "instanceSchemaVersion": "finance.skill-eval.runtime-instance.v2"
}
```

将完整扩展计入 RFC 8785 canonical JSON 的 `resultDigest`。Schema 与完整示例见 [Builder 合同](../contracts/runtime-builder/README.md)。Launcher 必须声明 `features.multiSkill=true`，返回整组及所有成员的真实装载证据；存在必需原生能力时，在线声明必须与所请求合同和约束匹配。生命周期检查执行真实模型调用，返回 `CONFORMANCE_OK`，并验证实例清理。

候选 ZIP 直接以工程文件为根。`candidateDigest` 使用平台文件树算法：按 UTF-8 路径字节排序，逐项散列 `路径 + NUL + 文件原始字节 + NUL`，使用 SHA-256；它不是 ZIP 字节摘要。Builder 应保留候选文件内容和成员入口；Runtime 构建产物有独立的 `artifactSha256`。

## 版本绑定与失效

绑定记录保存候选 ID / 摘要、需求和交付摘要、部署 ID / 产物摘要、运行配置摘要及登记环境快照。每次验收记录绑定 ID；已验收导出还会重新检查在线环境。

| 变化 | 处理 |
| --- | --- |
| 生成或修复出新候选，即使文件内容相同 | 旧需求不能回填；生成新需求 |
| 保存了不同的运行配置 | 绑定失效；按新配置生成需求 |
| 生成新需求 | 旧需求仍保留，但不能用于当前交付；旧验收不能用于新需求 |
| Runtime 能力、登记信息变化或交付过期 | 检查、验收或已验收导出时拒绝；重新交付 |
| 完全相同的 Result 重试 | 重新检查生命周期，保持同一绑定 ID，不重复新增历史 |
| 切换为已有环境 | 显式解除当前 Builder 选择，保留历史；重新验收 |

同一 `deploymentId` 的交付记录不可变；不同 Result 必须使用新的部署身份，或显式选择已有环境重新验收。检查失败不会绑定任务。若环境登记成功后任务落盘失败，环境可能作为未绑定记录保留；重试会复用它，不会删除其他任务可能正在使用的环境。数据目录仍要求单 API 写入者。

交付包新增 `migration/runtime-build-requirements.json`、`migration/runtime-build-result.json` 和 manifest 中的绑定信息。UI 展示当前绑定状态和交付历史。历史验收记录始终保留，不能冒充当前版本通过。

## HTTP 接口

所有接口沿用工作区鉴权；`/api/migration-bundles` 保留为相同服务的别名。

| 方法 | `/api/migration-tasks/:id` 下的路径 | 用途 |
| --- | --- | --- |
| POST | `/runtime-build-requests` | 冻结需求；body 含 baseCandidateId、runtimeType、timeoutMs、harnessTools，可选 modelId、entryInstructionsFile、requiredCapabilities |
| GET | `/runtime-requirements.yaml?requestId=…` | 下载当前或指定历史需求 |
| GET | `/runtime-build-requests/:requestId/source.zip` | 下载需求绑定的候选源码 |
| POST | `/runtime-deliveries` | 回填 `{result, trustReference, name?}`；校验、生命周期检查并绑定 |
| DELETE | `/runtime-builder-selection` | 切换为已有环境，保留历史 |

回填是同步长请求，期间同一任务写入串行执行；客户端超时后先刷新任务状态，再重试同一 Result。不会因浏览器断连而删除已成功登记的环境。代理请求期限应覆盖能力发现、实例启动、执行和清理。

旧任务仍使用 `/api/migrations/:id/runtime-requirements.yaml` 和 `/runtime-deliveries`，保持原 v1 行为；不能用旧接口处理新的 `bundle-*` 任务或绕过 v2 检查。

## 验证命令

```sh
pnpm exec vitest run tests/migration-task-builder.test.ts tests/runtime-builder-intake.test.ts
pnpm test:ui:migration:builder
```

上述回归使用确定性的 Agent / Judge 和 HTTP 协议测试环境，覆盖 1 / 3 成员、版本失效、拒绝路径和 UI；不作为外部 Builder 产品或真实业务模型的验收报告。真实部署使用相同 UI 和接口回填实际 Builder Result，并执行业务测试集。
