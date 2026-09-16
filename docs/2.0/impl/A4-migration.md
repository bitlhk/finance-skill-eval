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
|A4-3 | ✅ | `run_contract_test` | 新建 | 门禁三条（起得来/工具有/调得通）；接口差异相对**基线**报告，不参与通过与否。MCP 起真实服务（**`start` 由 agent 作为入参给出**、平台挑空闲端口、导出 `PORT`），不是把业务模块当 stdin 程序跑。`start` 不在契约里——契约只有分析读出来的东西，见下文「真模型跑出来的三件事」 |
|A4-4 | ✅ | 拆开生成与候选自检 | 改造 | 拆成三段：`generateImplementations`（要代码）、`publishCandidate`（落成资产）、`inspectCandidate`（诊断 + 合规自检 + 描述生成结果）。`generatePortable` 只做编排——**生成与自检是两笔不同的开销**（各含一次模型调用），混在一个方法里等于让慢而脆的自检决定要不要生成 |
|A4-5 | ✅ | A4 循环 | 新建 | 生成 → 编译 → 契约测试 → 回灌。三出口：全过 `PRODUCED` / 判定无法忠实迁移 `ABSTAINED` / 预算耗尽 `FAILED`。**预算耗尽要说成预算耗尽**：Harness 那时回的不是模型回答，按"回答不是 JSON"报会指错方向 |
|A4-6 | ✅ | 逐 Tool 弃权 | 新建 | 弃权是**逐 Tool** 的——一个 Tool 弃权退回 A3，不拖累其他 Tool |
|A4-7 | ✅ | trace 记录 | 新建 | `StageTrace.rounds`：每轮产物摘要 / 编译结果 / 契约测试结果 / 失败原因。**循环相对单次生成唯一多出来的证据**。由**平台自己记**（`compile_source`/`run_contract_test` 回填 + `ToolTraceRail` 记其余工具），原来让模型写进结果 JSON 的 `rounds` 字段已不再读——自述不是证据，且失败时恰好没有 |
|A4-8 | ✅ | 生成器按语言 | 改造 | 代码（含服务外壳）由 **agent** 生成，平台不生成也不播种。三套模板已搬进技能包当指导（见 A4-13）。回退生成器只剩 Script/Python 一条路，**不扩到 MCP——这是定论不是欠账**：MCP 的后端是一个**服务工程**，平台生成它就会回到"公布的 Schema 是平台猜的那个"。agent 不可用时 MCP 直接 409 说明原因，不产出假的"服务" |
|A4-9 | ✅ | 生成文件保护 | 改造 | 守卫的前缀 `migration-generated/v2/` 与实际输出（`mcp-<lang>/` / `skill/` / `scripts/`）**不匹配，永不触发**。用户改过的生成文件会被重新生成吞掉 |
|A4-10 | ✅ | 去掉模型自写冒烟输入 | 删除 | 出题人、答题人、判卷人不能是同一个 |
|A4-11 | ✅ | 交付启动命令 | 新建 | `start`（argv 数组）与可选 `prepare`（装依赖/构建）。**平台真的用它起服务**（`service-launch.ts`：挑空闲端口 → 导出 `PORT` → 等监听 → 验证 → 连进程树一起停），不是只记下来。`portable-candidate.ts` 只负责放置与路径安全，不拼启动方式 |
|A4-12 | ✅ | 接口差异报告 | 新建 | `changes`（每一处改动 + 理由）+ `drift`（契约测试实测到的差异）随交付物上行，落进 `PortableGeneration` 并在生成步骤展示。**只是报告，不判通过与否** |
|A4-13 | ✅ | 模板进技能包 | 改造 | 三套脚手架搬进 `skills/enterprise-migration/references/service-templates.md` 当指导；分析规则在 `analysis-rules.md`。`portable-candidate.ts` 里已无模板。**三套骨架都由 `scripts/verify-mcp-templates.mjs` 从文档里读出来**编译/装依赖并跑（真实 MCP 客户端），否则"指导"没人执行，会烂掉 |

## 现状

| 文件 | 现状 |
| --- | --- |
| `integrations/openjiuwen/migrate_agent.py` | A4 agent：自装配工具集（读/写/搜 + 编译 + 契约测试），无通用 shell；交付代码、`start`/`prepare`、`changes`/`drift`、README |
| `src/service/migration-agent.ts` | A2/A4 的进程边界：编码文件、跑 agent、把交付物映射成平台形状 |
| `src/service/portable-candidate.ts` | **只放置**：按 agent 报告的真实路径落文件、保护路径不出包、冲突不静默覆盖、算 diff。**没有模板** |
| `src/service/migration-code-generator.ts` | 回退路径，只剩 Script/Python 一条；遇到 MCP 直接 409 说清楚，不产出假的"服务" |
| `src/service/migration-store.ts` | 分析/实现两个 agent seam；没有分析就 409，不会退回规则猜 |
| `src/service/technical-validation.ts` | 本机技术验证（MCP preflight / Script LocalWorker）；命令按 **Skill 包自己的环境**拼 |

## 已经落下来的

- 换 agent（A4-1）、两个工具（A4-2 / A4-3）、循环与弃权（A4-5 / A4-6）、trace（A4-7）
- 修守卫（A4-9）、删自写冒烟（A4-10）
- **生成权在 agent 手里**：启动命令（A4-11）、接口差异报告（A4-12）、模板进技能包（A4-13）

## 关键路径

**A4-3 契约测试是整条链的支点。** 循环、trace、弃权都挂在它上面——它不成立，A4 只能退回"单次生成 + 模型自证"。

门禁只有三条：**起得来、工具有、调得通**。接口是否变样是**报告**，不是门禁——迁移必然做适配，逐字一致做不到也不该要求。

### 真模型跑出来的三件事（2026-09-16）

第一次让**真 agent + 真页面**跑完，A4 交付不出来。查下来的根因不在模型，在这里：

1. **MCP 的门永远过不去。** `_mcp_contract` 从**契约**里读 `start`，而契约是平台按分析装配的，只有
   `form/language/toolName/inputSchema/outputSchema/sample`——**没有 `start`**。`start` 是 agent 的交付声明，
   按定义在契约测试**之后**才有。于是 MCP 工具每次都拿到 `NO_START_COMMAND`，agent 无从修起，
   25 轮预算烧完，回一句 `Max iterations reached without completion`。
   现在 `start` / `prepare` 是 `run_contract_test` 的**入参**：服务怎么起 agent 最清楚，这里就是它唯一能说的地方
   （与 A4-11 一致，也与本文档原来的说法一致——是代码没跟上）。
2. **预算耗尽被说成"回答格式不对"。** Harness 在 ReAct 迭代用尽时**不返回模型回答**，只回
   `Max iterations reached without completion`（`react_agent.py`）。平台去解析这句话，得到 `NO_JSON_IN_OUTPUT`，
   于是报"结果不是约定的 JSON"——**说的是症状，藏的是病因**，而两者的修法完全不同（加预算/拆任务 vs 再叮嘱模型）。
   现在按 `result_type` 与那句话本身区分开报。
3. **trace 不能说没有。** `rounds` 原来是让**模型自己写进结果 JSON** 的——和让它数行号是同一个错误：自述不是证据，
   而且**恰好在失败时没有**。现在由平台记：`compile_source` / `run_contract_test` 自己回填，
   其余工具经 `ToolTraceRail`（harness 的 `after_tool_call`）记名。这次就是靠它一眼看到
   "25 轮里只调了 3 次工具，第一次就被 `NO_START_COMMAND` 顶回来"。

顺带修的：启动命令指向不存在的程序时，`_mcp_contract` / `_run_process` 会**抛异常**而不是报错，
工具调用直接炸掉；现在与 `service-launch.ts` 一致，回 `SERVICE_FAILED_TO_START` / `PROGRAM_NOT_RUNNABLE`。

### 回合被什么吃掉：四个摩擦面（A4 同样中招）

A2 那边查出四个摩擦面（详见 [A2-inspection.md](A2-inspection.md#回合花在哪四个摩擦面2026-09-16-实测)），**A4 全中**，因为它和 A2 共用同一套装配方式：

1. **路径**：同样的"提示词要相对路径 / 工具描述要绝对路径"冲突，A4 还要**写文件**，路径来回换的代价只会更大；
2. **工作区的家具**：同样的 `prompt_mode` 默认 FULL，WORKSPACE 段把 `AGENT.md`/`SOUL.md` 那张表塞进提示。A4 尤其危险——它收交付物的那段现在靠**黑名单**把脚手架挑出去（`head in {agents, coding_memory, context, memory, messages, skills, todo}`），一旦 harness 改个目录名，**脚手架会被当成交付物打进候选**。`prompt_mode="minimal"` 之后这条名单仍然保留（它管的是收集，不是提示），但**壳层不再诱导模型去读**；
3. **技能包按名字引用**：A4 提示词里同样写了路径（"骨架见技能包 `references/service-templates.md`"），改成按名字取；
4. **shell**：A4 也写着"不含 bash"，实际同样由 `SkillUseRail` 在运行期注册一把。A4 比 A2 更需要没有 shell——它手里有写工具，一把能执行任意命令的 shell 会让"只编译、只跑契约测试"这个约束形同虚设。

**A4 的验收同样按回合数**：工具调用次数应显著下降，序列里不再出现 `bash`。
## A4 拿到什么

只有三样：

1. **人的决定**——这个 Tool 走什么形式、什么语言；
2. **基线**——分析读出来的（工具、输入输出、样例）；
3. **源码**（它本来就有）。

**不给平台的分类判断**（可移植性状态、`kind`、findings、evidence）。那些是给授权环节的人做决定的；喂给 agent 只会让它照着标签走，而不是自己去读代码。

## 交付物

| 交什么 | 为什么 |
| --- | --- |
| 代码（**含服务外壳与适配器**） | 平台不生成，模板只是技能包里的指导 |
| **启动命令** | 代码是 agent 写的，怎么起它最清楚；平台据此起服务做校验 |
| 接口改动理由 | 基线差异要能解释——哪处是适配必须的 |
| README | 给人看怎么跑 |

## 平台做什么

- **不生成服务、不往工作区播种**；
- 起服务（用交付物声明的启动命令）→ 门禁三条；
- 对基线比差异 → **报告**，附上 agent 给的理由；
- 打包、校验。

## 运行环境：Skill 包自己的，不是 agent 的

契约测试在 **Skill 包自己声明的环境**里跑。两个 `uv` 写法不能混：

| 写法 | 读 PEP 723？ |
| --- | --- |
| `uv run --no-project python -I f.py` | **不读**，建的是空环境 |
| `uv run --no-project f.py` | 读 |

还有：`-I` 隐含 `-P`，脚本目录不进 `sys.path`。Script 是独立程序，这样正好；**服务是工程**，它的入口要 import 同级模块，所以服务不带 `-I` 启动。

## 验收

见 [F-05](../features.md) / [F-06](../features.md)。要点：四层全过才算达标；编译失败与契约测试失败**可区分**；弃权不交付骨架实现；每轮轨迹入 trace；通用 shell 不可用。
