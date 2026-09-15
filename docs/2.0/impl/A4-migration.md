# A4 改造 + 验证（循环）

**对应特性**：[F-05 改造与验证循环](../features.md)、[F-06 本机一次性技术验证](../features.md)
**定位**：阶段 A 最重的一块——把"单次生成"变成**有判据的循环**。

```
   生成 ──→ 合规自检 ──→ 编译 ──→ 契约测试 ──→ 加载检查
    ↑                                            │
    └────────── 失败原因回灌 ─────────────────────┘
```

| ID | 状态 | 特性 | 类型 | 说明 |
| --- | --- | --- | --- | --- |
|A4-1 | ✅ | A4 agent 入口 | 新建 | `integrations/openjiuwen/migrate_agent.py`。`create_code_agent` + **自装配**工具集，**不含 bash / powershell / code** |
|A4-2 | ✅ | `compile_tool` | 新建 | 按授权语言选工具链（`javac --release 17` / `py_compile` / `tsc` …）。`CodeTool` 是**执行任意代码**，不是编译，不用 |
|A4-3 | ✅ | `run_contract_test` | 新建 | 按**源契约**的输入/输出形状验证。判据来自源资产（A2 提取的 Schema），冻结、非模型产出 |
|A4-4 | 🟡 | 拆开生成与候选自检 | 改造 | `generatePortable` 一个方法里混了：代码生成 + 打包上传 + **对整个候选重新跑诊断**（含一次模型调用，最长阻塞 180s）+ 合规自检 + 重写 `candidateInspection.tools` |
|A4-5 | ✅ | A4 循环 | 新建 | 生成 → 编译 → 契约测试 → 回灌。三出口：全过 `PRODUCED` / 判定无法忠实迁移 `ABSTAINED` / 预算耗尽 `FAILED` |
|A4-6 | ✅ | 逐 Tool 弃权 | 新建 | 弃权是**逐 Tool** 的——一个 Tool 弃权退回 A3，不拖累其他 Tool |
|A4-7 | ✅ | trace 记录 | 新建 | `StageTrace.rounds`：每轮产物摘要 / 编译结果 / 契约测试结果 / 失败原因。**循环相对单次生成唯一多出来的证据** |
|A4-8 | ✅ | 生成器按语言 | 改造 | `portable-candidate.ts` 写死 Java MCP 工程 → 按决策语言分组，每种语言一个服务工程（`mcp-java/` / `mcp-python/` / `mcp-node/`）；Script 增加 Node。三套脚手架均已用真实 MCP 客户端起服务实测 |
|A4-9 | ✅ | 生成文件保护 | 改造 | 守卫的前缀 `migration-generated/v2/` 与实际输出（`mcp-<lang>/` / `skill/` / `scripts/`）**不匹配，永不触发**。用户改过的生成文件会被重新生成吞掉 |
|A4-10 | ✅ | 去掉模型自写冒烟输入 | 删除 | 判据改由 A4-3 承担。出题人、答题人、判卷人不能是同一个 |

## 现状

| 文件 | 现状 |
| --- | --- | --- |
| `src/service/migration-code-generator.ts` | **单次模型调用 ×3 轮**；判据是**模型自写的 `smokeInput`**；编译写死 Java / Python；源码超 70 万字符**静默截断** |
| `src/service/portable-candidate.ts` | 模板式生成，MCP 写死 Java 17 + MCP Java SDK |
| `src/service/migration-store.ts` | `generatePortable` 把生成 + 自检混在一起；**生成与验证是分离的手动步骤，没有循环** |
| `src/service/technical-validation.ts` | 本机技术验证已实现（MCP preflight / Script LocalWorker） |

## 要动的

- 换 agent（A4-1）、新建两个工具（A4-2 / A4-3）
- 拆开方法（A4-4）、合成循环（A4-5）、加弃权与 trace（A4-6 / A4-7）
- 生成器按语言（A4-8）、修守卫（A4-9）、删自写冒烟（A4-10）

## 关键路径

**A4-3 契约测试是整条链的支点。** 循环、trace、弃权都挂在它上面——它不成立，A4 只能退回"单次生成 + 模型自证"，也就是现在的样子。

判据的宪法在这里：**迁移不改入参出参，所以源工具的输入/输出契约就是判据**。它只判接口与结构不变，**不判业务值是否正确**——后者是阶段 B。

## 交付接口契约

**MCP 和 Script 的调用模型不一样，契约测试按 form 分派。**

| form | 接口是什么 | 怎么测 |
| --- | --- | --- |
| `SCRIPT` | 从 stdin 读一个 JSON object、只向 stdout 写一个 JSON value | 把 entrypoint 当程序跑 |
| `MCP` | **服务在协议上公布与返回的东西** | **启动服务** → `initialize` → `tools/list` 断言公布的 Schema 与源 Schema 逐字一致 → `tools/call` 断言输出形状 |

MCP 工具的接口不是某个函数的 stdin，所以测法是起服务。平台已经生成服务，起它即可。（Java 的 MCP 服务要 `mvn package` 才能起，首期不代跑，只有编译把关。）

**服务与适配器由平台生成，agent 只写业务实现：**

| language | 业务实现必须是 |
| --- | --- |
| java | `com.finance.migration.business` 下的类，`public static Object execute(Map<String,Object>)` |
| python | 模块里 `def execute(arguments: dict) -> object` |
| node | ESM 模块里 `export async function execute(arguments)` |

**放在哪由平台指定，不由 agent 自选**——适配器在业务代码存在之前就生成了，它按固定路径导入。平台把生成好的服务放进 A4 工作区，agent 只填 `business/`，契约测试起的就是**要交付的那个服务**。这样 `tools/list` 公布的 Schema 必然是 A2 读出来的源 Schema，而不是从函数签名反推的。

## 运行环境：Skill 包自己的，不是 agent 的

契约测试在 **Skill 包自己声明的环境**里跑，不是 agent 的运行环境。两个 `uv` 写法不能混：

| 写法 | 读 PEP 723？ |
| --- | --- |
| `uv run --no-project python -I f.py` | **不读**，建的是空环境 |
| `uv run --no-project f.py` | 读 |

还有一点：`-I` 隐含 `-P`，脚本目录不进 `sys.path`。Script 是独立程序，这样正好；**服务是工程**，它的入口要 import 同级模块，所以服务不带 `-I` 启动。

## 验收

见 [F-05](../features.md) / [F-06](../features.md)。要点：四层全过才算达标；编译失败与契约测试失败**可区分**；弃权不交付骨架实现；每轮轨迹入 trace；通用 shell 不可用。
