# Runtime Builder 接入

Builder 负责构建和部署目标 Runtime，评测平台连接它交付的 Runtime Launcher，再执行 Skill 验收。当前没有配置一个 Builder URL 后自动提交、轮询构建的客户端。

## 当前支持范围

| 入口 | 支持情况 |
| --- | --- |
| 新统一迁移任务（1～10 个 Skill） | 选择已登记的 Runtime，执行整组验收；尚无 Builder 需求导出、结果回填和任务绑定入口 |
| 旧版任务记录 | 导出能力需求，外部 Builder 构建后导入 Result，验证 Launcher 并绑定旧任务 |
| 环境管理 | 手工登记已部署的 Launcher，检查连接与能力，供新任务选择 |

手工登记仅建立 Runtime 连接，不会生成 Builder 来源证明，也不等同于 Builder Result 验收。旧任务的 Builder 验收使用 v1 合同；其 Launcher 要用于统一迁移，还需实现下面的 v2 整组能力。

## 给新统一任务接入 Runtime

1. 在外部 Builder 完成构建和部署，取得平台服务端可达的 Launcher Base URL。
2. Launcher 实现 [Runtime 协议](runtime-launcher-protocol.md)：能力发现、创建实例、查询状态、执行和删除实例。统一任务要求声明 `features.multiSkill: true`，接收 `finance.skill-eval.runtime-instance.v2`，支持 1～10 个成员，并返回可核对整组及全部成员摘要的执行证据。
3. 在「环境管理」的 Runtime 启动服务中登记名称、Runtime 类型、Launcher Base URL 和可选的凭据环境变量名。密钥值放在 API 服务进程环境中。远端地址使用 HTTPS；本机回环允许 HTTP。
4. 检查环境连接与可用模型。需要共享外部 MCP 时，登记 MCP 并创建执行环境绑定；Runtime 必须声明支持相应能力。
5. 回到迁移任务「运行配置」，选择已登记环境和模型，保存后完成开发集、留出集验收与导出。

只有 v1 单 Skill 能力的 Runtime 不能用于新的统一任务，即使任务只有一个成员。已有 Builder 交付登记的环境也遵循这一要求。

## 旧版任务的 Builder 交付接口

适用于已有旧任务，不需要为了新统一任务另外创建旧任务。

### 1. 配置交付准入

在 API 服务环境中设置允许访问的 Launcher 地址前缀及凭据引用，然后重启 API：

```dotenv
FINANCE_EVAL_LAUNCHER_TRUST_JSON=[{"reference":"builder-prod","label":"生产 Builder 交付","baseUrlPrefix":"https://runtime.example.com/launchers/","credentialEnv":"BUILDER_LAUNCHER_TOKEN"}]
```

通过受保护的服务环境提供 `BUILDER_LAUNCHER_TOKEN` 的实际值。无需认证的 Launcher 将 `credentialEnv` 设为 `null`。这是 **Launcher 交付准入配置**，不是 Builder 构建 API 的连接配置；浏览器只选择 `reference`。

### 2. 导出需求并在外部构建

在「旧版任务记录」打开任务，进入 Runtime 适配阶段下载需求。对应接口：

```http
GET /api/migrations/:id/runtime-requirements.yaml?runtimeType=openjiuwen
```

完整需求使用 `finance.runtime-build-requirements.v1`。若返回需求不完整或无需构建的状态，应先补全诊断或复用已有 Runtime。将完整需求交给外部 Builder，由它完成构建、验证、部署，返回 `finance.runtime-build-result.v1`。

字段和成功 / 失败示例见 [Builder 合同](../contracts/runtime-builder/README.md)。Result 需匹配原需求的 `requestId`、`requirementsDigest`，并包含部署描述、能力落实及验证结果；不携带实际凭据。

### 3. 接收交付

在旧任务的 Runtime 适配阶段导入 Result 并选择信任引用，或调用：

```http
POST /api/migrations/:id/runtime-deliveries
Content-Type: application/json

{
  "result": { "...": "完整的 finance.runtime-build-result.v1 对象" },
  "trustReference": "builder-prod",
  "name": "业务 Runtime"
}
```

上面 `result` 为结构示意，实际请求使用 Builder 返回的完整对象；API 身份认证沿用部署配置。

平台校验需求及交付摘要、地址准入、在线 capabilities，并实际执行创建、运行、证据校验与删除实例。通过后登记环境并绑定旧任务。Builder 自报成功不直接代表 Skill 的业务验收通过，仍需运行任务测试集。

## 新统一任务尚待补齐的部分

将 Builder 闭环接到统一任务，需要以整组源码和候选版本生成需求、保存需求及交付绑定，并在候选或环境改变后失效旧绑定；接收交付时还要使用 v2 整组实例验证。这些入口目前未实现，不能使用 `/api/migrations/:id/...` 接口处理新的 `bundle-*` 任务。
