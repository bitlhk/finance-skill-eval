# A2 检查诊断（agent）

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
| `src/service/tool-inspector.ts` | **只剩 Skill 规范检查 + 覆盖率装配**。工具发现与 Schema 读取整条删掉；它返回 `tools: []` 而不是猜 |
| `src/service/migration-agent.ts` | A2 的进程边界与出处校验（`locate()`）；把 agent 的产出映射成平台的 `ProjectInspection` |
| `src/service/migration-diagnostics.ts` | 确定性扫描 + 原子发现的证据裁决（文件 + 行号 + 逐字片段） |
| `src/service/skill-validator.ts` | 规则检查 |
| `integrations/openjiuwen/harness_tools.py` | `AbsoluteLineReadFileTool`：harness 的读文件工具给行号，但对带 offset 的读取按窗口编号；这里改成按文件的真实行号 |

**没有分析时的行为**：`inspect()` 直接 409，不再退到规则路径；弃权与失败各带 agent 自己给的理由（见 A2-6）。
A2 的 runner 是**可注入的 seam**（`MigrationAnalyzer`），测试用它喂一份分析结果——**payload 仍然要走同一套出处校验**。

## 不动的

- **证据裁决机制**——它是 agent 化后依然成立的**关键不变量**："模型的自由度在搜索上，不在什么算证据上"
- **合规判定归规则**——模型报 findings，状态由 `validateSkill` 算。实跑两次，同一份包给过 COMPLIANT 也给过
  NON_COMPLIANT，所以状态不能由它给；它的发现并入 findings 供人看
- TS 侧的校验与摘要绑定

## 语言判据落在哪

判据写在 [L0 §2](../L0-overall-architecture.md) 的决策表里，实现在 `src/service/migration-model.ts` 的 `recommendLanguage()`：

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

### ③ 技能包规则被写成了文件路径

`glob **/analysis-rules.md`、`**/*analysis*`、`**/*rules*`、`**/*`——**4 次**，全在工作区里找规则。

规则是**通过 `skills=[…]` 参数加载**的技能包（在仓库 `skills/` 下），harness 用 `skill_tool` **按名字**暴露（第 20 轮就是这么拿到的）。**探针证实它没有被复制进工作区**。提示词却写成"见技能包 `references/analysis-rules.md`"，读起来像工作区里的一个文件。

**改为**：按**名字**引用（`skill_tool` 取 `analysis-rules`），并说明规则不在工作区里。

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

### 实测（同一份夹具，逐条对照）

| | 改前 | 改后 |
| --- | --- | --- |
| 工具回合 | 30 | **15** |
| 路径写法 | 3 种 | **1 种** ✅ ① |
| `bash` | 2 次 | **0** ✅ ④ |
| 读框架家具 | 7 次 | **0** ✅ ② |
| 列框架目录（`agents`/`todo`/`messages`/`skills`） | 4 次 | **0** ✅ ② |
| 找技能包规则 | glob 4 次 | `skill_tool` 1 次 ✅ ③ |
| 读包内文件 | 同一文件多写法重读 | 5 次，全是包内内容 |

**还没达标（15 > 10）**，剩下的是**包内的重复清点**：4 次 `list_files` + 3 次 `grep` + 1 次 `glob` 去翻一个 3 文件工程，而第 2 轮 `run_scanner` 的**覆盖率里已经有完整文件清单**。这与 ③ 同类：提示词得说明"覆盖率就是清单"，否则模型会自己再数一遍。**这一条没做，不当作已完成。**
