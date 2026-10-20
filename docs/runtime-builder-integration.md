# Runtime Builder 接入

1～N 个 Skill 都在迁移任务的「Runtime 适配与登记」阶段接入 Builder。平台导出所选 Skill、可选依赖及冻结需求，外部 Builder 构建、部署后回填 Result；平台执行 v2 整组生命周期检查，通过后绑定版本并进入业务验收。

## 操作步骤

1. 完成工程分析与候选生成，在运行配置中设置模型、入口指令、超时和脚本权限。未选模型时使用交付 Runtime 的默认模型。
2. 在「Builder 构建与交付」选择目标 Runtime。存在需要 Runtime 原生提供的能力时，在可选的原生能力合同中填写 `requiredCapabilities`；自动生成部分包含全部成员、共享服务、工程分析和运行设置。
3. 点击「生成并下载 Builder 需求」和「下载绑定的 Skill 与依赖」。下载的 JSON 直接包含 skills[]、说明文本及可选依赖，对应需求记录中的候选，候选后来发生变化也不会悄悄换成新版本。
4. 将需求 YAML 与 Skill JSON交给外部 Builder。Builder 核对摘要，构建、部署 Launcher，并返回带统一任务回执的 Result JSON。
5. 选择服务端配置的信任引用，导入或粘贴 Result，点击「验证并绑定 Builder 交付」。平台核验摘要、原生能力合同、模型、协议和资源限制，真实装载全部成员，执行连通检查并删除实例；成功后自动选择交付环境及模型。
6. 执行开发集、独立留出集验收，下载已验收交付包。Builder 生命周期检查不代替业务测试。

平台当前以文件交换对接外部构建，没有自动提交、轮询 Builder 构建 API 的客户端。已有合适 Runtime 时可以直接选用，不必经过 Builder。

### Finance Solution Builder 本地接入

Builder 侧需包含 `runtime_skills.py`、`migration_task_profile.py` 和 `engineering/build_migration_task.py`，并支持 v2 整组 Package Launcher。仅有旧版 v1 Launcher 的安装不能接收统一任务需求。

在 Builder 的 `finance-solution-builder` 目录执行：

```powershell
python engineering/build_migration_task.py --requirements runtime-build-requirements.yaml --skills builder-skills.json --state-root PRIVATE_NEW_BUILD_DIRECTORY --python PINNED_NATIVE_PYTHON --model-config PRIVATE_MODEL_CONFIG --port 18324
```

构建进程保留到平台验收、下载结束。它编译并打包 Builder 自有 Runtime，启动带认证的 Launcher，使用真实模型读取完整 Skill 组和随机工作区内容，通过并清理探测实例后输出 `result.json`。这是受支持能力的实际装配构建；需要新增原生能力合同或重建假设时，使用 Builder 的 Construction Adapter，不能由该配方宣称实现。

原生 Python 环境固定 `openjiuwen==0.1.17.post1`、`fastmcp==2.14.7`。模型配置只在服务端提供。将私有 `connection-info.json` 中的 token 注入平台准入配置对应的环境变量，只向 UI 导入 Result。向构建状态目录写入 `stop` 文件可回收该 Launcher。该执行方式用于受信本机工程，不代表已部署银行生产 Runtime。

### 真实 UI 联调

在本仓库构建前端和服务后，设置以下环境变量并执行 `node scripts/verify-bundle-migration-live-ui.mjs`：

- `BUNDLE_LIVE_ENV_FILE`：受保护的真实迁移 Agent / Judge 配置；
- `FINANCE_RUNTIME_CONFIG`、`FINANCE_EVAL_MIGRATION_PYTHON`：真实执行模型配置与原生 Python；
- `MIGRATION_LIVE_BUILDER_ROOT`：上述 Builder 项目目录；
- `MIGRATION_LIVE_BUILDER_PYTHON`：安装 Builder 依赖的宿主 Python；
- `MIGRATION_LIVE_MEMBERS=1` 或 `3`：分别覆盖 1 个成员和多个成员；`MIGRATION_LIVE_TEXT_ONLY=1` 另验证一个纯指令 Skill、零依赖。

驱动通过真实浏览器导出需求与源码，调用外部 Builder，再通过 UI 回填、验收及下载。没有注入 Agent、Judge 或 Launcher 替身。开发失败会由真实 Agent 修复，并重新生成需求及部署；留出结果不反馈给修复。`MIGRATION_LIVE_RESUME_REPORT` 可指定尚未执行留出验收的失败记录，从实际生成的候选继续，保留原记录。输出位于忽略提交的 `reports/bundle-live-*`，其中包含模型诊断和私有连接信息，请按私有运行数据管理。

日志关联检查使用 `node scripts/verify-migration-log-correlation.mjs REPORT_DIRECTORY API_LOG [EARLIER_API_LOG ...]`。断点续跑时提供此前各段 API 日志；外部 Builder 的 Runtime 关联依据真实实例证据与清理回执，不要求存在内置 worker 的 `runtime.log`。

### 连接已部署的 Windows / WSL 服务

在上述配置之外设置 `BUNDLE_LIVE_SERVICE_URL` 指向已安装的 Eval，
`BUNDLE_LIVE_BUILDER_URL` 指向本机专用 Builder Launcher 地址（例如 `http://127.0.0.1:56363/oj/`）。
服务必须预先配置相同地址的 `real-builder` 信任引用及其凭据环境变量。
`MIGRATION_LIVE_BUILDER_CREDENTIAL_FILE` 指向只允许宿主与 API 服务身份读取的凭据文件，
其内容须与 API 使用的凭据一致。Builder CLI 对应 `--credential-file`；未提供时仍生成随机凭据。
凭据不进入 Result、命令参数值或浏览器。

Builder 在 WSL 时设置 `MIGRATION_LIVE_BUILDER_WSL=Ubuntu`，使用已有的 `finance-eval` 服务账户运行。
驱动通过 WSL root 入口调用 `runuser` 降权，保留服务账户的 nologin shell。
`MIGRATION_LIVE_BUILDER_ROOT`、`MIGRATION_LIVE_BUILDER_PYTHON`、`FINANCE_EVAL_MIGRATION_PYTHON`
填写 Linux 原生安装路径；`MIGRATION_LIVE_BUILDER_MODEL_CONFIG` 覆盖 Builder 使用的模型配置路径。
`MIGRATION_LIVE_BUILDER_ENV_FILE` 可指定受保护的宿主环境文件（CLI `--env-file`，需要 python-dotenv），
用于显式加载代理设置。测试机的 `FINANCE_RUNTIME_CONFIG` 仍是本机可读取的模型身份校验文件。
两平台端口应不同，Launcher 仅绑定 loopback。每轮构建记录宿主系统与入口摘要，结束后回收本轮 Launcher，
不会停止已安装的 API / Runtime。
WSL 构建状态默认放在 `/var/lib/finance-builder/builds`（由服务账户独占），
可用 `MIGRATION_LIVE_BUILDER_STATE_ROOT` 指定其他 Linux 原生目录。
避免将要求 0600 权限的私有构建状态放在 Windows 挂载盘；驱动在构建就绪和停止后复制证据到测试机。

旧任务验收使用 `node scripts/verify-deployed-legacy-live.mjs BEFORE_JSON OUTPUT_DIRECTORY`。
`BEFORE_JSON` 包含升级前经鉴权读取的 `{tasks:[{id,task}]}`；沿用服务 URL、Runtime URL、配置与令牌变量。
脚本比较旧任务内容、检查旧别名和导出，实际发送 v1 单 Skill 请求并调用真实 Judge，
不重复消费历史任务的留出集。证据写入指定私有输出目录。
需要验证真实存量候选能继续执行时，使用相同参数运行
`node scripts/verify-deployed-historical-task-live.mjs BEFORE_JSON OUTPUT_DIRECTORY`。
它选择升级前已验收的冻结候选，只追加一次真实开发集运行，并核对原候选和既有历史未改写、
旧留出集没有重放，再下载候选包。追加开发验收后，按现有规则，旧留出结果不能替代本轮的独立留出；
脚本检查“已验收”导出被阻止，不为通过测试重放旧留出。该命令会新增业务运行记录。
可在末尾传入本轮已经完成的开发 `runId`，只核对其实际证据和导出保护，不重复执行案例。

## 服务端准入配置

在 API 的受保护环境配置中设置允许的 Launcher 地址前缀，再重启 API：

```dotenv
FINANCE_EVAL_LAUNCHER_TRUST_JSON=[{"reference":"builder-prod","label":"生产 Builder 交付","baseUrlPrefix":"https://runtime.example.com/launchers/","credentialEnv":"BUILDER_LAUNCHER_TOKEN"}]
```

`BUILDER_LAUNCHER_TOKEN` 的实际值由 API 服务进程环境提供。无需认证时将 `credentialEnv` 设为 `null`。浏览器只选择 `reference`，Result 不携带凭据。这个配置控制 Launcher 交付准入，不是 Builder 构建 API 地址。

## Builder 协议

新迁移任务统一使用 `finance.runtime-build-requirements.v2` / `finance.runtime-build-result.v2`。`target.protocols.instance` 明确为 `finance.skill-eval.runtime-instance.v2`，不再声明 v1 然后附加多 Skill 要求。v1 仅保留旧任务及旧客户端兼容；不能用于接收新的 v2 需求。

实例 v2 直接传递 `skills[]`，允许 1～10 个成员。每个成员包含身份、入口、版本、摘要和 `instructions`，自身资源放可选 `files`（工程相对路径 → base64）；共享脚本或资源放可选 `assets`。`contentDigest` 固定全部所选内容，`entryInstructionsFile` 可选。没有依赖时只传 Skill 说明，不需要项目目录或 ZIP。平台内部为 Agent 建立统一工作区，这只是所选输入的运行视图，不要求用户提交完整代码仓库。

需求扩展 `finance.migration-task-build-profile.v2` 包含：

- 任务 ID、原始源码摘要、候选 ID 和整组摘要；
- `skills[]` 中 1～10 个成员的入口、版本和内容摘要，以及完整文件路径清单；
- 业务目标、目标环境要求、已有工程分析；
- `instanceSchemaVersion=finance.skill-eval.runtime-instance.v2`、`multiSkill=true`；
- `settings` 中的模型、入口指令、超时、Harness 工具，以及 `services` 中的共享 MCP 启动声明。

需求不包含测试集、冻结留出题或连接密钥。原生能力合同不会从自然语言分析自动推断成已验证合同；已知原生依赖需要填写完整的输入、输出、错误及约束定义。

Result 继续提供匹配的 `requestId`、`requirementsDigest`、Launcher 描述和构建验证记录，并必须在 `extensions.migrationTask` 提供：

```json
{
  "schemaVersion": "finance.migration-task-build-receipt.v2",
  "taskId": "从需求复制",
  "candidateId": "从需求复制",
  "candidateDigest": "从需求复制的64位十六进制摘要",
  "instanceSchemaVersion": "finance.skill-eval.runtime-instance.v2"
}
```

将完整扩展计入 RFC 8785 canonical JSON 的 `resultDigest`。Schema 与完整示例见 [Builder 合同](../contracts/runtime-builder/README.md)。Launcher 必须声明 `features.multiSkill=true`，返回整组及所有成员的真实装载证据；存在必需原生能力时，在线声明必须与所请求合同和约束匹配。生命周期检查执行真实模型调用，返回 `CONFORMANCE_OK`，并验证实例清理。

默认导出的 Skill JSON 不含源码 ZIP。可选 ZIP 导入只提供便利，不是 Runtime 的传输要求。`candidateDigest` 使用平台文件树算法：按 UTF-8 路径字节排序，逐项散列 `路径 + NUL + 文件原始字节 + NUL`，使用 SHA-256；它不是 ZIP 字节摘要。Builder 应保留候选文件内容和成员入口；Runtime 构建产物有独立的 `artifactSha256`。

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
| GET | `/runtime-build-requests/:requestId/skills.json` | 下载冻结 skills[] 与可选 assets，无需 ZIP |
| GET | `/runtime-build-requests/:requestId/source.zip` | 可选 ZIP 导出，兼容旧工具 |
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
