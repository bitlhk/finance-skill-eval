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
   第 13/15/18 行——**整文件读取也被报错**，所以那是模型自己编的，不是工具给的。这正是第 1 条不能省的理由：
   **片段是判据，行号只是提示**，不是保险起见，是必需。

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

## 验收

见 [F-02](../features.md) / [F-03](../features.md)。要点：只读 rail 生效；覆盖率进入产出；证据不足时弃权；工具调用与摘要进入 trace。
