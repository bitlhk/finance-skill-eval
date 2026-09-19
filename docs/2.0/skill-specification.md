# 企业级 Runtime 无关 Skill 规范

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
- 应与 Skill 目录名一致。

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

1. 可以脱离 Agent Runtime 单独运行和测试；
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

它不应该要求调用者传入某个 Runtime 创建的 Session 对象。认证信息可以由运行环境安全提供，不应由 Skill 明文保存。

## 7. 建议采用的两种 Tool 形式

为了让 Tool 更容易被不同 Runtime 使用，本规范建议优先采用 MCP Tool 或 Script Tool。

这是企业实现 Tool 时的建议，不是限制。无论采用哪种形式，关键都是 Tool 能够独立运行、独立测试，并提供清楚稳定的输入和输出。

### 7.1 MCP Tool

MCP 是一种让 Agent Runtime 发现和调用 Tool 的通用协议。Tool 通过统一方式对外提供能力，Runtime 不需要了解 Tool 内部是怎样实现的。

MCP Tool 适合以下情况：

- 多个 Skill 或多个 Runtime 需要共同使用；
- Tool 需要访问数据库、内部平台或远程服务；
- 需要统一管理认证、权限、审计和服务版本；
- Tool 是长期运行的企业服务。

MCP 只规定 Tool 怎样对外提供能力，不限制实现语言。企业可以根据现有技术栈使用 Java、Python、JavaScript、Go 或其他语言实现 MCP Tool。

### 7.2 Script Tool

Script Tool 是可以从命令行独立执行的程序。调用者传入参数，脚本完成任务并返回结果。

Script Tool 适合以下情况：

- 本地文件处理；
- 一次性或短时间运行的任务；
- 规则明确、结果确定的数据处理；
- 尚不需要建设长期运行服务的小型能力。

脚本语言不作强制要求。本规范推荐优先考虑 Python，因为它适合脚本任务，依赖环境容易单独准备，也便于在命令行中直接测试。需要共享或服务化时，Python 实现也可以继续封装为 MCP Tool。

如果使用 Python，建议 Tool 自己保存环境定义：

```text
balance-tool/
├── pyproject.toml      # Python 版本和直接依赖
├── uv.lock             # 锁定实际依赖版本
├── src/                # Tool 实现
└── tests/              # 独立测试
```

环境准备属于 Tool 的运行管理，不是 Skill 的业务步骤。`SKILL.md` 不需要指导 Agent 安装 Python 或逐条安装依赖。

### 7.3 怎样选择

| 场景 | 建议 |
| --- | --- |
| 多个 Runtime 或多个团队共同使用 | MCP Tool |
| 访问企业系统、数据库或远程服务 | MCP Tool |
| 本地、一次性、确定性的处理任务 | Script Tool |
| 需要集中管理认证、权限和审计 | MCP Tool |
| 先快速实现和验证一个小能力 | Script Tool |

如果一个 Script Tool 后来被大量 Skill 共同使用，可以把它升级为 MCP Tool，而不必改变 Skill 描述的业务流程。

## 8. 完整示例

下面是一个简化的 `SKILL.md`：

```markdown
---
name: account-balance
description: 查询客户账户余额，并在查询前检查必要信息。用户询问账户余额或可用资金时使用。
---

# 查询账户余额

## 执行前检查

- 必须取得账户编号。
- 账户编号缺失时，请用户补充，不要猜测。
- 不要要求用户提供密码、Token 或密钥。

## 操作步骤

1. 调用 `get_account_balance`，传入账户编号。
2. 查询成功后，说明币种、账面余额和可用余额。
3. 如果账户不存在，请用户检查账户编号。
4. 如果 Tool 暂时不可用，说明当前无法完成查询，不要编造结果。
```

这个 Skill 不关心 `get_account_balance` 是 Java 编写的 MCP Tool，还是 Python 编写的 Script Tool。只要 Runtime 能够提供同名、同用途、输入输出一致的 Tool，Skill 的业务说明就不需要改变。

## 9. 编写完成后的检查清单

### Skill

- [ ] 目录中包含 `SKILL.md`
- [ ] `name` 合法并与目录名一致
- [ ] `description` 说清楚“做什么”和“什么时候使用”
- [ ] 步骤明确，读者不需要猜测
- [ ] 写清楚什么时候调用什么 Tool
- [ ] 写清楚成功、失败和信息不足时怎样处理
- [ ] 没有密码、Token、密钥和机器专用路径
- [ ] 没有某个 Runtime 专用的代码或对象

### Tool

- [ ] 可以脱离 Agent Runtime 单独运行和测试
- [ ] 名称和用途清楚
- [ ] 输入和输出明确
- [ ] 错误可以被调用者理解和处理
- [ ] 没有把某个 Runtime 的对象设计成业务参数
- [ ] 已根据使用场景选择 MCP Tool、Script Tool 或其他同样可移植的实现方式

## 10. 一句话总结

Skill 只负责把事情讲清楚，Tool 负责把事情做出来，Runtime 负责把两者连接起来。只要 Skill 不依赖 Runtime 的细节，Tool 又能独立运行和测试，同一份 Skill 就可以在不同的企业 Agent Runtime 中复用。
