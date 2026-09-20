# 企业级 Runtime 无关 Skill 规范
本次修订：2026-09-17。明确 Tool 的实现边界、执行身份的责任归属，以及业务入参与运行时依赖的区别。本规范描述交付要求，不代表迁移服务和测试 Runtime 已经实现全部要求。

## 1. 这份规范解决什么问题

Skill 用来告诉 Agent **一件事应该怎么做**。

例如，“查询客户账户余额”这个 Skill 可以告诉 Agent：

1. 什么时候可以查询；
2. 查询前要确认哪些信息；
3. 应该调用哪个 Tool；
4. 查询成功后怎样回答；
5. 查询失败后怎样处理。

但是，仅仅把工作步骤写清楚还不够。如果 Skill 使用的 Tool 只能在某一个 Agent Runtime 中运行，那么更换 Runtime 时，Tool 也要跟着重写。

本规范希望做到两件事：

- Skill 描述稳定的业务做法，不依赖某个 Runtime 的实现细节；
- Tool 可以被不同 Runtime 调用，不需要为每个 Runtime 重新开发一份。

本规范以 [Agent Skills 规范](https://agentskills.io/specification)为基础。MCP Tool 和 Script Tool 是本规范面向企业使用场景给出的建议，不是 Agent Skills 官方规范的强制要求。

## 2. 先理解 Skill、Tool 和 Runtime

### 2.1 Skill 是工作说明

Skill 类似一份给 Agent 阅读的标准作业说明。它描述目标、步骤、判断条件、注意事项和结果要求。

Skill 重点回答：**这件事应该怎么做？**

### 2.2 Tool 是实际能力

Tool 是 Agent 完成工作时可以调用的能力，例如：

- 查询账户余额；
- 读取一份文件；
- 生成财务报表；
- 调用企业内部系统；
- 执行一个数据处理脚本。

Tool 重点回答：**具体由什么能力来执行？**

### 2.3 Runtime 是运行 Agent 的系统

Runtime 负责运行 Agent、加载 Skill，并把可用的 Tool 提供给 Agent。

Runtime 还负责建立本次调用的执行身份，并按 Tool 的依赖声明提供运行所需的数据。执行身份指这次调用代表谁、属于哪个租户、使用哪套授权上下文；它不一定与对话中的用户相同，必须由运行环境明确确定。

Runtime 重点回答：**谁来读取 Skill，并实际调用 Tool？**

三者的关系可以简单理解为：

```text
Runtime 运行 Agent
        │
        ├── 读取 Skill，知道应该怎么做
        │
        └── 调用 Tool，把事情真正做完
```

因此，Skill 不应该变成某个 Runtime 的使用手册，Tool 也不应该只能依附某个 Runtime 才能工作。

## 3. 一个标准 Skill 长什么样

一个 Skill 是一个目录，`SKILL.md` 是唯一必需的文件。

```text
account-balance/
├── SKILL.md            # 必需：Skill 的入口和主要说明
├── scripts/            # 可选：Skill 自带的辅助脚本
├── references/         # 可选：详细规则、字段说明、业务资料
└── assets/             # 可选：模板、示例文件等资源
```

各目录的用途如下：

| 内容 | 用途 |
| --- | --- |
| `SKILL.md` | 告诉 Agent 这个 Skill 是什么、什么时候使用、怎样完成任务 |
| `scripts/` | 放置需要直接执行的辅助脚本 |
| `references/` | 放置按需阅读的详细资料，避免 `SKILL.md` 过长 |
| `assets/` | 放置模板、样例和任务需要使用的其他文件 |

不要为了描述 Tool 再增加一套 Skill 专用清单。Skill 只需要在说明中写清楚要使用的 Tool，以及什么时候使用。

## 4. 怎样写 SKILL.md

### 4.1 文件开头

`SKILL.md` 必须以 YAML frontmatter 开头，至少包含 `name` 和 `description`。

```markdown
---
name: account-balance
description: 查询客户账户余额，并在查询前检查必要信息。用户询问账户余额或可用资金时使用。
---
```

`name` 应满足以下要求：

- 长度为 1 到 64 个字符；
- 只使用小写英文字母、数字和连字符；
- 不能以连字符开头或结尾；
- 不能出现连续的两个连字符；

`description` 应满足以下要求：

- 长度为 1 到 1024 个字符；
- 说明这个 Skill 能做什么；
- 说明什么情况下应该使用它。

如果 Agent 仅从 `description` 就无法判断是否应该使用这个 Skill，说明描述还不够清楚。

### 4.2 正文内容

正文没有固定模板，但至少应让读者找到以下答案：

1. 这个 Skill 要完成什么任务；
2. 执行前需要哪些信息；
3. 按什么步骤完成；
4. 在什么情况下调用什么 Tool；
5. 成功时应返回什么；
6. 失败、信息不足或有风险时怎样处理。

推荐使用直接、明确的动作描述，例如：

```markdown
## 操作步骤

1. 确认用户已经提供账户编号。
2. 如果账户编号缺失，请用户补充，不要猜测。
3. 调用 `get_account_balance` 查询余额。
4. 向用户说明币种、账面余额和可用余额。
5. 查询失败时，说明失败原因，不要编造余额。
```

不要只写“根据实际情况处理”或“调用相关接口”。这样的表述无法告诉 Agent 应该作出什么判断。

## 5. Skill 应该怎样使用 Tool

Skill 中只描述完成任务所需的稳定信息：

- Tool 的名称；
- 什么时候调用；
- 要提供哪些业务参数；
- 怎样使用返回结果；
- 调用失败时怎样处理。

例如：

```markdown
调用 `get_account_balance`，传入已经确认的账户编号。

如果调用成功，向用户返回币种、账面余额和可用余额。
如果 Tool 返回“账户不存在”，请用户检查账户编号。
如果 Tool 暂时不可用，说明当前无法完成查询，不要编造结果。
```

Skill 中不应写入以下内容：

- 密码、Token、密钥等敏感信息；
- 某台机器上的绝对安装路径；
- 某个 Runtime 专用的对象、回调或注册代码；
- Tool 的构建、安装和部署过程；
- 与业务步骤无关的底层通信细节。

这些内容发生变化时，不应该迫使企业重新编写业务 Skill。

## 6. Tool 怎样做到与 Runtime 无关

Runtime 无关不是指 Tool 不需要运行环境，而是指 Tool **不依赖某一个 Agent Runtime 才能使用**。

一个符合本规范的 Tool 应具备以下特点：

1. 在提供已声明的依赖后，可以脱离特定 Agent Runtime 单独运行和测试；
2. 不把某个 Runtime 的 Agent、Session、Context 等对象当作业务输入；
3. Tool 名称和用途清楚；
4. 输入和输出可以被准确理解；
5. 失败时返回明确、可处理的错误；
6. 不依赖调用者去猜测隐藏的本地状态。

例如，一个余额查询 Tool 的业务输入可以是：

```json
{
  "account_id": "A10001"
}
```

输出可以是：

```json
{
  "currency": "CNY",
  "ledger_balance": "1000.00",
  "available_balance": "800.00"
}
```

它不应该要求调用者传入某个 Runtime 创建的 Session 对象。认证信息由运行环境按声明提供，不应由 Skill 明文保存，也不应作为模型需要填写的业务参数。

### 6.1 Tool 的实现边界

**Tool 在 Runtime 已建立的执行身份下完成具体业务操作，可以解析、校验和使用鉴权信息，但不负责建立、选择或切换执行身份。**

| 职责 | Tool | Runtime |
| --- | --- | --- |
| 校验业务参数、执行计算与转换、整理业务结果 | 负责 | 提供调用环境 |
| 调用业务接口、处理业务错误 | 负责 | 提供声明的运行依赖 |
| 解析注入的凭证、读取其中的声明、校验有效性 | 可以实现 | 提供鉴权信息及所需校验材料 |
| 根据业务操作检查权限、处理接口拒绝 | 可以实现 | 提供已确定的授权上下文 |
| 将注入的凭证用于请求签名或鉴权头构造 | 可以实现 | 提供所需凭证 |
| 确定调用代表的用户、服务账号、租户及授权上下文 | 不负责 | 负责 |
| 登录、获取和刷新执行凭证、管理凭证生命周期 | 不负责 | 负责 |
| 因权限不足选择另一个账号、提升权限或切换身份重试 | 不允许自行实施 | 由运行环境按企业策略处理 |

鉴权解析和权限检查不等于建立执行身份。Tool 可以检查“当前调用是否被允许”，但不能自行决定“换成谁来调用”。Tool 解析出的身份信息只能用于当前调用的校验或业务处理，不能用来覆盖 Runtime 已确定的执行身份。

对声明的依赖缺失、凭证无效或权限不足，Tool 应返回明确错误；不得回退到隐藏的默认账号、本机登录态、全局当前用户或其他凭证。

### 6.2 业务入参与运行时依赖

Tool 必须区分两种输入，不能仅因它们都能表示成 JSON，就放入同一组模型可填写参数。

| 输入类别 | 提供方 | 要求 |
| --- | --- | --- |
| 业务入参 | 模型或调用方 | 描述本次要执行的业务操作，例如账户编号、查询区间 |
| 运行时依赖 | Runtime | 提供执行所需的凭证、上下文或环境数据；不由模型选择或填写 |

例如，余额 Tool 接收业务参数 `account_id`，并使用 Runtime 注入的凭证调用余额接口。Tool 可以解析该凭证、检查权限并构造鉴权请求；不在工具内部登录或通过原 Runtime 的当前用户获取凭证。

```text
Runtime：确定执行身份 → 准备凭证 → 按声明注入
Tool：校验账户参数 → 解析或校验凭证（如需要）→ 请求余额接口 → 整理结果
```

业务入参不得覆盖运行时依赖。若业务参数中的租户、用户等字段与执行身份有关，Tool 应按声明的业务规则校验，不能据此自行切换执行身份。

#### 凭证与调用上下文的独立注入

Tool 实际使用的调用上下文，例如租户标识、执行用户标识、语言或请求追踪信息，应与凭证一样，由 Runtime 通过独立的注入通道显式提供，不加入模型可填写的输入 Schema。

注入通道必须与业务参数分离，来源可信，按调用隔离，并明确 Tool 的读取方式。具体传输映射由各类 Tool 的调用契约确定，例如 HTTP 请求 header；不要求所有实现形式都使用 header，也不在本规范中规定脚本或 MCP 的注入封装格式。

Tool 的依赖声明应描述所需数据的名称、含义、表示方式、是否必需以及敏感性。名称和数据结构依据实际契约确定，不统一 Credential 或用户上下文的类型；跨进程传递对象数据时还应明确序列化方式，不能直接把 Runtime 的 Context 对象传入。只传递工具需要的内容，不透传整个隐式上下文。

Runtime 按每次调用的执行身份提供依赖。调用入口必须区分可信 Runtime 注入与外部输入，不允许模型或未经校验的请求覆盖身份、租户和凭证。并发和多租户调用不能共用可变的全局上下文，也不能仅将一次调用的身份绑定在共享连接上供后续调用沿用。

Tool 可以读取、解析和校验这些依赖，但不能借此建立或切换执行身份。向下游业务接口发起请求时，按接口契约构造所需 header 或字段，不将收到的全部调用上下文无差别转发。

例如，余额 Tool 的 `account_id` 是业务参数；业务接口所需的凭证，以及独立使用的租户上下文，由 Runtime 通过声明的独立通道提供。如果用户信息只用于 Runtime 获取凭证，Tool 就无需声明或接收它。

### 6.3 运行时依赖声明

Tool 应声明自己实际消费的运行时依赖。声明属于 Tool 的契约，与模型可见的业务输入分开；不要求在 Skill 中再增加一套专用清单。

每项声明至少应说明：

- 名称，以及 Tool 如何接收和使用它；
- 凭证与调用上下文的注入通道、表示方式及读取位置；
- 数据类型或结构，与 Tool 实际消费的数据一致；
- 用途，例如用于哪个业务服务或调用；
- 是否必需，以及缺失、无效时的处理；
- 是否包含敏感内容，以及相应的传递和日志限制。

本规范不统一定义 `Credential`、token 或用户对象的具体类型，也不要求统一名称。Tool 消费字符串，就声明字符串；消费对象，就声明所需的对象结构。声明必须足以让运行环境提供依赖，并与实现保持一致。

Runtime 负责将企业实际数据绑定到这些声明，并在调用时提供。Tool 不直接读取特定 Runtime 的 Agent、Session 或隐式 Context。凭证和调用上下文通过独立通道注入；MCP、脚本等实现形式的传输映射可以不同，但必须明确、可测试，并与声明一致。代码库和文件资源等依赖仍按各自的安装或资源绑定契约提供。

敏感依赖不得进入模型上下文、普通调用日志、业务返回结果或交付包。运行环境应控制其注入，Tool 在解析、报错和记录日志时也必须避免泄露。

### 6.4 Runtime 无关的成立条件

Runtime 无关是“不绑定特定 Runtime 的实现”，不是“不需要 Runtime 提供依赖”。目标运行环境必须能够满足 Tool 的声明，测试环境也应使用同一份契约。

本规范统一职责边界与声明要求，不统一企业鉴权实现，也不要求迁移平台实现所有企业身份体系。交付物应包含适用的 Tool 实现、代码依赖与运行时依赖说明；不得将平台内部特有的上下文或凭证获取机制变成未声明的前提。

## 7. 建议采用的两种 Tool 形式

为了让 Tool 更容易被不同 Runtime 使用，本规范建议优先采用 MCP Tool 或 Script Tool。

这是企业实现 Tool 时的建议，不是限制。无论采用哪种形式，关键都是 Tool 在提供声明的依赖后能够独立运行、独立测试，并提供清楚稳定的输入和输出。协议封装不改变第 6 节的执行身份边界。

### 7.1 MCP Tool

MCP 是一种让 Agent Runtime 发现和调用 Tool 的通用协议。Tool 通过统一方式对外提供能力，Runtime 不需要了解 Tool 内部是怎样实现的。

MCP Tool 适合以下情况：

- 多个 Skill 或多个 Runtime 需要共同使用；
- Tool 需要访问数据库、内部平台或远程服务；
- 需要集中管理工具服务、权限检查、审计和服务版本；
- 依赖企业鉴权、动态凭证或敏感的运行时上下文；
- Tool 是长期运行的企业服务。

MCP 只规定 Tool 怎样对外提供能力，不限制实现语言。企业可以根据现有技术栈使用 Java、Python、JavaScript、Go 或其他语言实现 MCP Tool。

模型可见的业务参数与 Runtime 注入的依赖应分开。MCP 的连接认证与业务接口使用的凭证是不同契约；不能因为工具封装成 MCP，就自动增加一层业务鉴权要求。服务连接认证按部署要求配置，不能替代 Tool 的运行时依赖声明。

### 7.2 Script Tool

Script Tool 是可以从命令行独立执行的程序。调用者传入参数，脚本完成任务并返回结果。

Script Tool 适合以下情况：

- 本地文件处理；
- 一次性或短时间运行的任务；
- 规则明确、结果确定的数据处理；
- 尚不需要建设长期运行服务的小型能力。

脚本语言不作强制要求。本规范推荐优先考虑 Python，因为它适合脚本任务，依赖环境容易单独准备，也便于在命令行中直接测试。需要共享或服务化时，Python 实现也可以继续封装为 MCP Tool。

如果 Python Script Tool 直接包含在 Skill 中，建议按照 Agent Skills 的脚本指南，使用 PEP 723 在脚本文件内声明 Python 版本和依赖。需要锁定依赖时，使用 `uv lock --script` 生成与脚本相邻的锁文件：

```text
account-balance/
├── SKILL.md
└── scripts/
    ├── get_account_balance.py       # Tool 实现及 PEP 723 依赖声明
    └── get_account_balance.py.lock  # 可选：uv 生成的脚本锁文件
```

`pyproject.toml` 和项目级 `uv.lock` 只在 Script Tool 本身作为独立 Python 项目管理时使用；这属于 Python 工程结构，不是 Agent Skills 对 Skill 包的要求。环境准备属于 Tool 的运行管理，`SKILL.md` 不需要指导 Agent 逐条安装依赖。

### 7.3 怎样选择

需要企业鉴权、动态凭证或敏感运行时上下文的 Tool，优先采用 MCP 服务，便于集中接入运行环境的凭证注入、访问控制和审计。这是选型建议，不是禁止 Script 的合规门槛；封装成 MCP 也不会自动解决鉴权或依赖注入问题。

这类 Tool 选择 Script 时，应明确凭证和上下文的安全注入、调用隔离及执行结束后的清理机制，避免通过命令行参数传递凭证，不将敏感值写入日志或留存在临时文件中。无论采用哪种形式，都必须满足第 6 节的执行身份边界和运行时依赖契约。

| 场景 | 建议 |
| --- | --- |
| 多个 Runtime 或多个团队共同使用 | MCP Tool |
| 访问企业系统、数据库或远程服务 | MCP Tool |
| 依赖企业鉴权、动态凭证或敏感运行时上下文 | 优先 MCP Tool；Script 需明确安全注入与清理机制 |
| 本地、一次性、确定性的处理任务 | Script Tool |
| 需要集中管理工具服务、权限检查和审计 | MCP Tool |
| 先快速实现和验证一个小能力 | Script Tool |

一次性或本机任务仍需结合其鉴权与上下文需求选型，不能仅因执行时间短就默认选择 Script。已经具备安全注入机制的独立 Script，可以继续复用，不要求为此改写为 MCP。

如果一个 Script Tool 后来被大量 Skill 共同使用，可以把它升级为 MCP Tool，而不必改变 Skill 描述的业务流程。

## 8. 完整示例

完整样例以真实文件保存在仓库的 `examples/skill-tool-packages/` 目录中。本规范只说明交付结构并链接到源码，避免大段代码遮盖规范正文，也避免文档代码与可构建代码不一致。

### 8.1 独立 Skill 包 + Java MCP Tool 包

```text
examples/skill-tool-packages/account-balance/
├── skill/
│   └── SKILL.md
└── mcp/
    ├── pom.xml
    ├── Dockerfile
    ├── README.md
    └── src/main/java/com/example/balance/
        ├── BalanceMcpServer.java
        └── GetAccountBalanceTool.java
```

- Skill 入口：[account-balance/skill/SKILL.md](../../examples/skill-tool-packages/account-balance/skill/SKILL.md)
- Maven 依赖和可执行 JAR 配置：[account-balance/mcp/pom.xml](../../examples/skill-tool-packages/account-balance/mcp/pom.xml)
- MCP Server 启动入口：[BalanceMcpServer.java](../../examples/skill-tool-packages/account-balance/mcp/src/main/java/com/example/balance/BalanceMcpServer.java)
- Tool Schema、注册和业务结果：[GetAccountBalanceTool.java](../../examples/skill-tool-packages/account-balance/mcp/src/main/java/com/example/balance/GetAccountBalanceTool.java)
- 容器部署：[account-balance/mcp/Dockerfile](../../examples/skill-tool-packages/account-balance/mcp/Dockerfile)
- 构建和接入说明：[account-balance/mcp/README.md](../../examples/skill-tool-packages/account-balance/mcp/README.md)

这个交付形态中，Skill 与 MCP 服务可以分别发布。Runtime 或平台配置负责登记 MCP 服务地址，并把 Skill 中的 Tool 名称绑定到 MCP Server 暴露的同名 Tool。服务地址、认证信息和部署参数不写入 `SKILL.md`。

### 8.2 Skill 包内包含 Python Script Tool

```text
examples/skill-tool-packages/transaction-summary/
├── SKILL.md
└── scripts/
    ├── summarize_transactions.py
    └── summarize_transactions.py.lock
```

- Skill 入口：[transaction-summary/SKILL.md](../../examples/skill-tool-packages/transaction-summary/SKILL.md)
- Script Tool 源码及 PEP 723 依赖声明：[summarize_transactions.py](../../examples/skill-tool-packages/transaction-summary/scripts/summarize_transactions.py)
- uv 脚本锁文件：[summarize_transactions.py.lock](../../examples/skill-tool-packages/transaction-summary/scripts/summarize_transactions.py.lock)

这个交付形态中，脚本使用 PEP 723 在文件内声明 Python 版本和依赖，使用 `uv lock --script` 生成相邻锁文件。Script Tool 从标准输入读取 JSON，向标准输出写入唯一的 JSON 结果；错误写入标准错误并使用非零退出码。它应能够脱离 Agent Runtime 独立执行和测试。

以上文件是规范的一部分。调整示例时，应直接修改链接指向的源码并完成构建或执行验证，不要在本规范中再复制一份代码。

## 9. 编写完成后的检查清单

### Skill

- [ ] 目录中包含 `SKILL.md`
- [ ] `name` 合法
- [ ] `description` 说清楚“做什么”和“什么时候使用”
- [ ] 步骤明确，读者不需要猜测
- [ ] 写清楚什么时候调用什么 Tool
- [ ] 写清楚成功、失败和信息不足时怎样处理
- [ ] 没有密码、Token、密钥和机器专用路径
- [ ] 没有某个 Runtime 专用的代码或对象

### Tool

- [ ] 提供声明的依赖后，可以脱离特定 Agent Runtime 单独运行和测试
- [ ] 名称和用途清楚
- [ ] 输入和输出明确
- [ ] 错误可以被调用者理解和处理
- [ ] 没有把某个 Runtime 的对象设计成业务参数
- [ ] 业务入参与 Runtime 注入的依赖分别声明，模型不能填写或覆盖后者
- [ ] 凭证与调用上下文通过声明的独立通道传入，与业务参数分离
- [ ] 注入按调用隔离，来源可信，不透传整个上下文
- [ ] 仅声明实际消费的运行时依赖，没有把凭证获取链路整体搬入 Tool
- [ ] 不建立、选择或切换执行身份，不依赖隐式登录态或默认账号
- [ ] 如包含鉴权解析、校验或签名逻辑，其依赖和错误处理明确
- [ ] 敏感依赖不进入模型上下文、普通日志、业务返回结果或交付包
- [ ] 已根据使用场景选择 MCP Tool、Script Tool 或其他同样可移植的实现方式
