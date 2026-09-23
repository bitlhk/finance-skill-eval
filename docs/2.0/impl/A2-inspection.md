# A2 检查诊断（agent）

依赖识别与后续处理的修订设计见 [迁移中的依赖识别与处理](migration-dependency-handling.md)。Tool 的职责与交付契约以 [Skill 规范](../skill-specification.md)为准；迁移流程不属于该标准。

**对应特性**：[F-02 Skill 规范检查](../features.md)、[F-03 逐 Tool 可移植性检查](../features.md)
**定位**：从"单次模型调用"变成 **agent 循环**，并新增**建议形式与建议语言**。

| ID | 状态 | 特性 | 类型 | 说明 |
| --- | --- | --- | --- | --- |
|A2-1 | ✅ | A2 agent 入口 | 新建 | `integrations/openjiuwen/analyze_agent.py`。`create_explore_agent` + **自装配**只读工具集（`ReadFileTool` / `GrepTool` / `GlobTool` / `ListDirTool`），**不含 write / edit / bash** |
|A2-2 | ✅ | `run_scanner` 工具 | 改造 | 把现有 `scripts/scan-migration.py` 从"必经前置"改为 agent 可调工具。产出确定性 findings + **覆盖率**——它是唯一能回答"我漏了什么"的东西 |
|A2-3 | ✅ | 企业规范技能包 | 新建 | `skills/enterprise-migration/`，四份参照：`skill-spec`（合规）/ `portability-rules`（六个状态的判据）/ `target-rules`（形式与语言建议）/ `evidence-rules` |
|A2-4 | ✅ | 建议形式与建议语言 | 新建 | `ToolInspection` 新增 `recommendedForm` / `recommendedLanguage` / `recommendationReason`。判据收敛成 `recommendLanguage()` 一处；agent 只给**形式**建议，语言由平台算 |
|A2-5 | ✅ | 发现的证据校验 | 保留 | **按原文片段定位**（`locate()`）：有 `snippet` 就按它在文件里找行，没有才信 `line`；找不到即作废。**留在 TS 侧**，作用于 agent 返回的 findings 与基线。机械判据不进技能包——提示词是软约束 |
|A2-6 | ✅ | 弃权 | 新建 | 最终输出 `status = ABSTAINED` + `reason` / `missing`。不用工具表达终态。**弃权一路走到调用方**：`MigrationAnalysis` 是三态，store 报出 agent 自己说的"缺什么"，不再折成通用的"分析不可用" |
|A2-7 | ✅ | 反引号捞 Tool | 改造 | 曾把 `SKILL.md` 里每个反引号标识符都登记为候选 Tool。**不是补症状，是删掉了整条规则路径**——见 A2-8 |
|A2-8 | ✅ | **对 Skill 的分析** | 新建 | 产出：用到了哪些工具、每个的 `input`/`output`/`sample`/`entrypoint`，**每条带 `path`+`snippet`（+提示行号）**。TS 侧按原文定位，落不到的契约**丢成 `null`，不保留猜测**。四条错法全部撤掉，`tool-inspector.ts` 只剩 Skill 规范检查 + 覆盖率 |

## A2-8 分析的产出：对 Skill 的分析

A2 回答三个问题：

1. 这个 Skill 用到了哪些工具；
2. 每个工具的输入输出是什么；
3. 样例是什么。

它同时是**基线**（迁移保留什么、校验比什么）和**出题的种子**。

**不采用的做法**（都定性为错，不应重新引入）：

| 错法 | 为什么错 |
| --- | --- |
| 扫散文里的反引号当 Tool 名 | 拿散文当结构化数据。`SKILL.md` 里的 `` `JSON` `` 不是 Tool |
| 正则从源码刨 `inputSchema :=` 字面量 | 只认字面声明。从变量、装饰器、类型标注、运行时拼出来的都读不到 |
| 让模型凭空填一个 Schema | **源里未必存在那个东西**。runtime 绑定的工具本来就没有"声明的 Schema"，形状只活在代码和文档里 |
| 从源码编一个样例输入（`sampleFromSchema`） | 拿猜测造测试数据。样例应当**读出来** |

分析结果落在**证据**上：每条都要带原文片段，平台按原文定位到真实的文件与行，跟 findings 走同一套校验。落不到源码/文档上的主张不成立。

**为什么按原文而不是按行号**：数行号是算术，agent 隔着读文件的工具数不准——实跑时它对一份 19 行的 `SKILL.md` 报了第 25、29、31 行，
整份基线因此被丢成空。抄原文是模型做得好的事，定位是平台做得好的事。

**行号错在哪，查过两次，是两件事**：

1. **harness 有个真 bug，已在我们这侧修掉**（`integrations/openjiuwen/harness_tools.py`）：`ReadFileTool` 会给行号，
   但它是**按窗口**编号的——`fs` 读的是 `line_range=(offset+1, ...)`，渲染却把这段窗口从 1 编起。实测 offset=5、limit=3：
   文件第 6/7/8 行被标成 1/2/3。两个 agent 现在都用 `AbsoluteLineReadFileTool`，行号对得上文件。
2. **但上面那次的 25/29/31 不是这个 bug。** 修完之后再测一次，模型对同一份文件仍然报 25/29/35，而它引的原文分别在
   第 13/15/18 行——**整文件读取也被报错**，所以那是模型自己编的，不是工具给的。
3. **也不是「工具里没说明白」。** harness 的 `read_file` 描述只说「结果带行号」，没说**是谁的**行号，所以描述也换了：
   明说「每行左侧的数字是该行在文件中的行号，引用时照抄，不要自己数」。再测两轮，**8 条主张 8 条对不上**——
   一轮报 27/35/41/49 而原文在 14/18/21/17，另一轮报 25/29/29/49 而原文在 13/15/15/17，**每轮数字还都不一样**。
   说清楚了也照不对：模型不是数错，是在生成一个像行号的东西。

**结论**：行号不可信是**模型属性**，不是工具缺陷。所以只有一条路——**片段是判据，行号只是提示**。

**已经收紧**：`locate()` 现在**只看片段**——没有片段就没有位置，不再退回用模型的行号；片段短于 8 个字符也不作数
（一个字符能「定位」到半个文件）。代价是个别主张整条作废、基线变窄；换来的是**报出来的行一定包含它引的那句话**。

**能保证与不能保证**：报出的行确实含那段原文（我们读的是上传快照的字节）；**不能**保证同一段文字出现多次时是哪一处
（取第一处），也不能保证那句话就是作者想指的东西——只保证「这段字在这里」。

## 现在是什么样

| 文件 | 现状 |
| --- | --- |
| `src/migration/application/migration-inspection-service.ts` | A2 检查用例编排；没有 Agent 基线时不猜测 Tool 与 Schema |
| `src/migration/infrastructure/migration-agent-result-mapper.ts` | 出处校验（`locate()`），把 Agent 产出映射成 `ProjectInspection` |
| `src/migration/infrastructure/migration-diagnostics.ts` | 确定性扫描 + 原子发现的证据裁决（文件 + 行号 + 逐字片段） |
| `src/migration/domain/migration-skill-validator.ts` | Skill 规则检查 |
| `integrations/openjiuwen/harness_tools.py` | `AbsoluteLineReadFileTool`：harness 的读文件工具给行号，但对带 offset 的读取按窗口编号；这里改成按文件的真实行号 |

**没有分析时的行为**：`inspect()` 直接 409，不再退到规则路径；弃权与失败各带 agent 自己给的理由（见 A2-6）。
A2 的 runner 是**可注入的 seam**（`MigrationAnalyzer`），测试用它喂一份分析结果——**payload 仍然要走同一套出处校验**。

## 不动的

- **证据裁决机制**——它是 agent 化后依然成立的**关键不变量**："模型的自由度在搜索上，不在什么算证据上"
- **合规判定归规则**——模型报 findings，状态由 `validateSkill` 算。实跑两次，同一份包给过 COMPLIANT 也给过
  NON_COMPLIANT，所以状态不能由它给；它的发现并入 findings 供人看
- TS 侧的校验与摘要绑定

## 语言判据落在哪

判据写在 [L0 §2](../L0-overall-architecture.md) 的决策表里，实现在 `src/migration/domain/migration-model.ts` 的 `recommendLanguage()`：

```
同语言优先  →  源语言可用就用源语言
            →  否则按生态最接近的选
            →  仍无倾向 → MCP 用 java，SCRIPT 用 python
源语言不在支持范围内 → UNSUPPORTED，不自动迁移
```

**目标语言集合是平台能力，不写进技能包**——模板增减时文档不该过时。同理，**agent 不给语言建议**：它看不到平台有哪些生成模板。

## 回合花在哪：四个摩擦面（2026-09-16 实测）

一次 A2 跑掉 30 个工具回合、171s，而包只有 3 个文件。把调用**连参数**记下来（`ToolTraceRail` 现在记 `args`）才看清：**这不是"模型重复查"，是四个摩擦面在烧回合**，而且每个都能改。

### ① 路径：我们自己的提示词和工具描述在打架

| 出处 | 说什么 |
| --- | --- |
| `analyze_agent.py` 的 SYSTEM_PROMPT | "一律使用**相对**路径……**不要用绝对路径**" |
| `AbsoluteLineReadFileTool._DESCRIPTION` | "`file_path` **必须是绝对路径**" |

模型被两边拉，同一份 `SKILL.md` 读了三种写法（`C:\…`、`/tmp/…`、`C:/…`），还跑 `bash cygpath -w` 去换算——**6 次**。

**改为**：定死**唯一工作区根**（`build_workspace` 的结果，绝对路径），并把它**写进提示词**；删掉"用相对路径"那句。`/tmp` 那种写法是 bash 带进来的（见 ④），④ 做掉它就不再出现。

### ② 工作区里混着 agent 自己的家具

`IDENTITY.md`、`SOUL.md`、`AGENT.md`、`USER.md`、`HEARTBEAT.md`、`coding_memory/MEMORY.md`、`memory/MEMORY.md`、`context/session_memory.md` 被逐一读——**7 次**；`agents`、`todo`、`messages`、`skills` 这些目录还被列了 **4 次**。

**不是模型乱翻。** 两层原因，两层都要治：

1. **提示层**：harness 在系统提示里列了张表（`prompts/workspace_content/workspace_header.py` 的 `CONTEXT_FILES` 硬编码五个文件名），`context.py` 还会把这些文件的内容**每次模型调用都折进系统提示**。
   → `prompt_mode="minimal"`：其保留段是 `{IDENTITY, SAFETY, SKILLS, TOOLS, RUNTIME, PROMPT_ATTACHMENTS, MEMORY}`，**没有 WORKSPACE 段**。

2. **文件层**：那些目录**真的被建出来了**。建它的是 `DeepAgent.init_workspace()`，用 `DEFAULT_WORKSPACE_SCHEMA` 落盘——而那是**一个"人"的家**：`AGENT.md` 里有"你叫什么、能否打断"，`SOUL.md` 里有"人格与价值观"，还有日记本 `memory/daily_memory/`、待办 `todo/`、消息 `messages/`。它和待检查的包躺在**同一层**。

   **注意这不是 code agent 的锅**：`init_workspace` 在 `create_deep_agent` 里，A2（explore）和 A4（code）一样中招。

   **schema 减不掉**：`Workspace.__post_init__` 会把缺失的默认节点**补回来**（`get_directory` 还会回退到默认 schema），所以"自定义布局"只能加不能减——实测传 `directories=[skill, tool]`，`get_node_path('AGENT.md')` 照样返回路径。

   **但可以干脆不建**：`_needs_workspace_init()` 的第三个条件是 `config.auto_create_workspace`（`schema/config.py` 默认 `True`），两个 agent 都透传 `**config_kwargs`。传 `auto_create_workspace=False` 之后实测：

   ```
   True  → workspace: AGENT.md HEARTBEAT.md IDENTITY.md SOUL.md USER.md agents coding_memory context memory messages skill skills todo
   False → workspace: skill
   ```

   工具集两边完全一样（5 个 + `skill_tool`），关掉不损失能力。

### ③ 技能包从来没挂上过（这才是真相）

提示词里**按路径**写规则，模型就去 `glob` 工作区——这是表症。真因在接线：

`create_*_agent(skills=[路径])` **只把 `bool(skills)` 当开关**（`(SkillUseRail, bool(skills) or …, _make_skill_rail)`），
**不把路径交给 rail**。工厂建的 rail 从**工作区的 `skills/` 节点**取目录（`workspace_obj.get_node_path("skills")`），
而那里只有 harness 自己的 `.workspace`。真正挂技能的是 `extension_binder._bind()`，它做的是：

```python
target = rails[0]                      # SkillUseRail
target.skills_dir = [*roots, *previous_dirs]
await target.reload_skills()
```

**所以 `skill_tool` 对每个名字都回 `Skill not found`——包括对的那个。** 实跑里模型试了 13 个写法
（`enterprise-migration`、`enterprise_migration`、`Enterprise-Migration`、`analysis-rules`…）**全部失败**。
它不是乱猜，它是在试一个查不到的工具。

**改为**：自己建 `SkillUseRail(skills_dir=[<repo>/skills], skill_mode="all", include_tools=False)` 传进 `rails`。
实测 `rail.skills_meta` 立刻从 `[]` 变成 `['enterprise-migration']`，两种 `auto_create_workspace` 下都一样
（说明这与 ② 无关，是独立的接线错误）。

**顺带更正我自己**：我先说"第 1 轮一次就对"、又说"7–8 轮在猜名字"，**两次都是错的**——
因为那时的 trace **只记调用、不记结果**。现在 `ToolTraceRail` 记 `ok` / `failed:<reason>`，
一眼就能看出"13 次全失败"。**没有结果记录的轨迹会把"工具坏了"读成"模型不听话"。**

### ④ bash：设计说没有，实际有

`analyze_agent.py` 写着"不含 bash，bash 能写所以它不是只读边界"——**实测模型真的调了两次 bash**。

来源查清了，我先前两次判断都错（一次说"只读 rail 挡住"，一次说"注入的 gp 子 agent 带进来的"）：

- `SysOperationRail` **没有 fs-only 选项**：`shared = [glob, list_dir, grep, bash]` 恒含 bash，Windows 上再加 powershell；
- `add_general_purpose_agent` 默认 `False`，那条路不走；
- **真正来源是 `SkillUseRail`**：`include_tools` 为真时它注册 `read_file + BashTool`，而 `include_tools = not 已有 SysOperationRail`。我们只传了自己的 rail，条件成立。

而且 bash 是**运行期**（技能刷新时）注册的——构造后 `list_tool_info()` 只有我们的 5 个工具，所以"构造完再摘"没用。

**原生三件都不够**：`read_only=True` 里 bash 仍在；`bash_deny_patterns` 只管 bash（rail 构造 `PowerShellTool` 时没传，Windows 上漏着）；`set_tool_exposure_policy` 只是把工具变成 `DEFERRED`，模型能用 `tool_search` 找回来。

**改为**：传一个 `SysOperationRail` 的**子类**，只作为"已有 fs rail"的标记（不注册工具，免得覆盖我们修正过行号的 `read_file`）。`SkillUseRail` 的 `include_tools` 因此为假，shell 两条路都不再出现。可再叠 `set_tool_exposure_policy` 把可见工具收成白名单。

## 验收

见 [F-02](../features.md) / [F-03](../features.md)。要点：**A2 的工具集就是那 5 个，没有 shell**（下面这条原先写的是"只读 rail 生效"，而事实上只读 rail 里带 shell，已按 ④ 收敛）；覆盖率进入产出；证据不足时弃权；工具调用与摘要进入 trace。

**回合数的验收标准**：同一份验收夹具，工具调用 **≤10**，序列里**不再出现 `bash`**、不出现同一文件的多种路径写法。达标与否用 `reports/probe-a2.mjs` 对照，不靠"这次模型表现好"。

### ⑦ grep 自己实现，不走 shell（已做）

`GrepTool` 是四个文件工具里**唯一走 shell 的**（其余三个走 `fs()`）：它拼一条命令行交给
`SysOperation.shell().execute_cmd()`。实测三个分支：

| 分支 | 完整命令的第一个 token | 默认允许清单 |
| --- | --- | --- |
| `rg`（装了 rg） | `rg` | ✅ |
| `grep`（POSIX） | `grep` | ✅ |
| **PowerShell（Windows 没装 rg）** | **`$ErrorActionPreference='SilentlyContinue';`** | ❌ **永远匹配不上** |

Windows 那支**不是"跑 powershell 命令"，是把一段管道脚本交给 execute_cmd**，靠
`_resolve_execution_plan` 在更晚的地方包成 `[powershell.exe, -NoProfile, -NonInteractive, -Command, <脚本>]`。
而允许清单的检查在**包之前**，看到的就是那段脚本的开头——**任何程序名条目都匹配不上它**。

**所以在本平台的默认配置下，`GrepTool` 是结构性不可用**：两个 agent 的每次 `grep` 都被
`command not allowed by allowlist` 拒掉（实跑 1 次、复现 3 种 pattern 全部失败）。模型据此白扔回合，
而且**丢掉了搜索能力**。

**为什么不是"放行 powershell"**：清单匹配的是 `command.split()[0]`，**只能表达程序名**，不能表达
"只允许 Select-String"；写上 `powershell` 等于放行任意 PowerShell。更关键的是——**对这条路它根本不生效**，
因为该分支的第一个 token 不是 `powershell`。能生效的唯一配置写法是把那段 prologue 字面量抄进清单，
那等于把 harness 的内部字符串搬进我们的配置，改一处就静默失效。

**为什么不是"装 rg"**：能work（`rg` 在清单里），但平台就**默默依赖**每台机器都装了它，
失败方式仍是"工具在、报错却指不到真因"。

**改为**：自己实现 `build_grep_tool()`，**直接读文件、不做任何 shell 调用**。它同时消掉三件事：

1. **不再有 shell**——"A2 只读、不含 shell"从**工具表**层面成立，落到**实现层**也成立（此前每次搜索都在偷偷执行命令）；
2. **不受 `os.name` 分叉影响**——不再有"Linux 走 grep / Windows 走 PowerShell"的两种方言；
3. **搜索范围锁在工作区内**——模型没法让它去翻宿主上别的目录（原来的实现只看允许清单，不看范围）。

**接口与输出照抄 `GrepTool`**（`pattern` / `path` / `output_mode` / `-i` / `-n` / `-A` / `-B` / `-C` /
`head_limit` / `offset` / `glob`；行形如 `相对路径:行号:原文`），这样**工具名不变、提示词不用改、
模型对输出的预期不变**。`multiline` 与 `type` 沿用原实现的处理（前者要 rg，明确拒绝）。

**限制写明白**：二进制/非 UTF-8 文件跳过（原实现也是这个语义）；单文件超 512KB 跳过——与扫描器同一档阈值。


| | 起点 | 现在 |
| --- | --- | --- |
| 工具回合 | 30 | **7** |
| 耗时 | 171s | **88.5s** |
| 取技能材料 | 7 次（13 次失败尝试） | **2 次**（全成功） |
| 路径写法 | 3 种 | **1 种** ✅ ① |
| `bash` | 2 次 | **0** ✅ ④ |
| 读/列框架家具 | 7 + 4 次 | **0** ✅ ② |
| `list_files` | 8 次 | **0** ✅ ⑤ |
| 读 A4 的材料 | 1 次（`service-templates`） | **0** ✅ ⑥ |

现在的序列：取技能 → 扫描器 → 读那 3 个包内文件 → 读规则（一份）→ 开工。

**验收线改过两次，都记下来**：先是"工具回合 ≤10"（**定错了**，回合数不是目标，废回合才是），
现在的口径是 **失败调用 0、`list_files` 0、`bash` 0、不读别的阶段的材料**；回合数不设上限。

### ⑥ 技能包：一个 workflow 一个包，一个阶段只拿自己的（已做）

- **拆**：`service-templates.md` 移进新包 `enterprise-migration-delivery`。原先它躺在判断包里，
  而判断包的 `description` 逐字是 A2 的活（"检查与判断依据……"），**一个字没提写服务**——
  于是 A2 每次都把这份用不上、且不该由它掌握的材料读进去。
- **并**：A2 的 5 篇并成**一份**，且直接放进 `SKILL.md`（192 行，远低于官方 500 行上限）。references 的意义是"按需只加载需要的"，
  可 A2 的活就是"读这个包、给出判断"，**5 篇它每次都要**——按需收益为零，只剩 5 次往返。
  **而判断规则本身就是指令，不是"细节"**，所以它该在 `SKILL.md` 里；取材料因此从 2 次降到 **1 次**。
- **合并顺带消掉一处矛盾**：`evidence-rules` 说"`line` 必须是真实行号"、`analysis-rules` 说"不要给行号"，
  分在两处读起来互相打架。真相是**两条路各管各的**（finding 带行号且平台核对；分析主张只给片段、行号平台算），
  并进一篇才讲得清。

**挂载的坑（第二处接线错误）**：rail 的 `skills_dir` 是**技能库根目录**，加载器遍历它的**子目录**找 `SKILL.md`。
传技能目录本身**静默加载不到任何东西**。选哪个包要用 `enabled_skills`（按名字的允许清单）。
实测：A2 → `['enterprise-migration']`，A4 → `['enterprise-migration-delivery']`。

### 这一版验收时撞到的另一件事：JSON 里嵌原文的转义坑

修完上面这些，真模型跑两次都 409，报的是**"结果不是约定的 JSON"**。我先怀疑是平台解析器——
查下来不是：`json.loads` 自己也失败在**第 41 行少一个逗号**，裸括号 29 开 27 闭。

真因是模型要把一行**本身含引号和大括号**的原文当 `snippet` 塞进 JSON，转义写到一半**没闭合字符串**。
这是在 JSON 里嵌源码的经典坑。

**但它暴露的是平台的报错不准**：`parse_structured` 对"围栏里的 JSON 坏了"和"整篇是散文"给的是
同一句话（`NO_JSON_IN_OUTPUT`），而这两件事的修法完全不同。现在分开：

- `JSON_UNBALANCED: 围栏里的 JSON 括号不配对（多半是某个字符串没闭合）`
- `JSON_INVALID: <解析器原话>`
- `NO_JSON_IN_OUTPUT` 只留给"确实没有 JSON"

提示词里也点明这个陷阱。**但这一版发现原来的那句叮嘱本身写错了**：它写的是"引号**或大括号**都要按
JSON 规则转义"——大括号在 JSON 里根本不用转义。真模型照着做，在验收里交出了
`return ToolResponse(content={{"status": "ok", ...}})`：`{{` 是照着那句话写的，`...` 是自己省的。
两个都不是原文，平台一查就落空。现在这句话改成：括号原样写、只有引号和反斜杠要转义，
并且**片段必须是一段连续原文，不许用 `...` 省略**。

### 这一版验收时撞到的第三件事：模型报的路径是它自己工作区里的绝对路径

真 agent 全链验收在 A2 就停下，报 `A2 located no input contract for get_acceptance_order`。
查 dump：模型给出的 `path` 是 `C:\...\Temp\finance-migration-ws-z2s82zu5\skill\SKILL.md`，
而平台的 `files` 表键是 `skill/SKILL.md`——**一次都没命中**，于是输入契约、输出契约、样例、
逐条证据**全部被丢掉**，基线成了空的。A4 就没有可比对的东西，链条从此走不下去。

这是提示词改成"路径要写绝对路径"之后带出来的：那句话是给**文件工具**的（`read_file` 要绝对路径），
模型把它一并套到了 JSON 的 `path` 上。**两个约定指的是两件事，却没有分开说。**

修法不是在提示词里再叮嘱一句（那是软约束，和行号那次同一个坑），而是**把事实放在平台这边**：
工作区镜像的就是这个包，所以绝对路径的**尾巴**就是资产路径。平台按尾巴唯一匹配，
匹配上就用资产键（临时目录从此不进记录），**尾巴撞车就整条不认**——两个文件都叫 `SKILL.md` 时，
这条主张到底指哪个是路径回答不了的问题，猜一个比没有更糟。

**两处都要修**：路径归一放在平台（`assetPath`），片段那句错话改回提示词。只改提示词，
下次模型换个写法还是全丢；只改平台，模型照样交 `...` 省略的"原文"。

### ⑤ 扫描器报告里要有"工程架构"（已做）

第 2 轮就调了 `run_scanner`，它却**没让后面的清点变得多余**——因为 `coverage` 是**一张扁平的 `{path, status}` 列表**：它告诉模型"每个文件读到什么程度"，**没有告诉它工程长什么样**。于是模型自己拼结构，拼不出来就去 `list_files`。

**这不是"再叮嘱一句"能解决的。** "覆盖率就是清单、别再数一遍"是**软约束**——和行号那次同一个坑。正确的形状是**把事实放进工具输出**，扫描器的报告里直接给**文件架构**：

```
directories  ["skill", "skill/references", "tool"]
files        [{path: "skill/SKILL.md", role: "SKILL_DOCUMENT", bytes: 781},
              {path: "skill/references/acceptance-policy.md", role: "REFERENCE", bytes: 214},
              {path: "tool/legacy_runtime_tools.py", role: "SOURCE", bytes: 1364}]
```

`role` **只按路径推**（不猜内容）：`SKILL.md` → `SKILL_DOCUMENT`；任一层有 `references/` → `REFERENCE`；`scripts/` → `SCRIPT`；`assets/` → `ASSET`；代码后缀 → `SOURCE`；其余 `OTHER`。

**限制写明白**：扫描器只收到**文件**，**空目录不会出现在架构里**。

### 做这一条时挖出的两个真 bug

**① 扫描器的输出一直是废的——这是 `list_files` 的真正来源。**

`_scan` 用 `uv run … python -I scan-migration.py` 起子进程，而 **`-I` 隐含 `-E`，`PYTHONUTF8=1` 被忽略**。于是 `json.dumps(..., ensure_ascii=False)` 把中文按**控制台代码页**（GBK）写出去，调用方 `json.loads(out)` 判定编码失败 → `STATIC_SCAN_INVALID_OUTPUT`。

**模型拿到的一直是 `{"status": "unavailable"}`。** 所以它列目录**不是不听劝，是根本没拿到架构**——我先前的判断（"模型在重数")是错的。

修法在协议本身：`json.dumps(...)` 用默认的 ASCII 安全输出。JSON 本来就该是 ASCII 安全的，输出裸非 ASCII 让这个协议依赖了**运行它的那台机器的控制台代码页**。副作用是好的：平台侧（JS）原先按 UTF-8 解 GBK 字节，中文是**乱码**，现在也一并正了。

**② 技能包的名字是 `enterprise-migration`，不是 `analysis-rules`。**

我让模型用 `skill_tool` 取 "`analysis-rules`"——那是**技能包内部的一篇参考**（`references/analysis-rules.md`），**不是技能名**；技能名是它 frontmatter 里的 `name`。模型因此连猜 6 个名字（`analysis_rules`、`Analysis-Rules`、`analysis`…）。

**教训**：提示词里凡是"按名字取"的东西，名字必须是**从被取对象读出来的**，不能是记忆里的。
