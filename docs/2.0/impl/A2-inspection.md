# A2 检查诊断（agent）

**对应特性**：[F-02 Skill 规范检查](../features.md)、[F-03 逐 Tool 可移植性检查](../features.md)
**定位**：从"单次模型调用"变成 **agent 循环**，并新增**建议形式与建议语言**。

| ID | 特性 | 类型 | 说明 |
| --- | --- | --- | --- |
| A2-1 | A2 agent 入口 | 新建 | `integrations/openjiuwen/analyze_agent.py`。`create_explore_agent` + **自装配**只读工具集（`ReadFileTool` / `GrepTool` / `GlobTool` / `ListDirTool`），**不含 write / edit / bash** |
| A2-2 | `run_scanner` 工具 | 改造 | 把现有 `scripts/scan-migration.py` 从"必经前置"改为 agent 可调工具。产出确定性 findings + **覆盖率**——它是唯一能回答"我漏了什么"的东西 |
| A2-3 | 企业规范技能包 | 新建 | `skills/enterprise-migration/`，四份参照：`skill-spec`（合规）/ `portability-rules`（六个状态的判据）/ `target-rules`（形式与语言建议）/ `evidence-rules` |
| A2-4 | 建议形式与建议语言 | 新建 | `ToolInspection` 新增 `recommendedForm` / `recommendedLanguage` / `recommendationReason`。**⚠ 被待定项挡住**，见下 |
| A2-5 | 发现的证据校验 | 保留 | 行号 + 逐字片段校验**留在 TS 侧**，作用于 agent 返回的 findings。机械判据不进技能包——提示词是软约束 |
| A2-6 | 弃权 | 新建 | 最终输出 `status = ABSTAINED` + `reason` / `missing`。不用工具表达终态 |
| A2-7 | 修掉反引号捞 Tool | 改造 | `tool-inspector.ts` 把 `SKILL.md` 里**每个反引号标识符**都登记为候选 Tool，散文里的 `` `JSON` `` 也会变成 Tool 并产出假 ERROR |

## 现状

| 文件 | 现状 |
| --- | --- |
| `src/service/migration-diagnostics.ts` | 确定性扫描 + **单次模型调用**；证据裁决机制（文件 + 行号 + 逐字片段）**已实现** |
| `src/service/tool-inspector.ts` | 纯规则的可移植性级联；含反引号捞 Tool 的粗暴路径 |
| `src/service/skill-validator.ts` | 规则检查 |

## 要动的

- 单次模型调用 → `analyze_agent.py`（A2-1）
- 扫描器从前置改为工具（A2-2）
- 新增技能包（A2-3）与新字段（A2-4）
- 修工具发现（A2-7）

## 不动的

- **证据裁决机制**（`migration-diagnostics.ts` 里对模型发现的校验）——它是 agent 化后依然成立的**关键不变量**："模型的自由度在搜索上，不在什么算证据上"
- TS 侧的校验与摘要绑定

## ⚠ 卡点

**A2-4 被 [L0 §2.2](../L0-overall-architecture.md) 的待定项挡住**：「便于转换的语言」的判据未定。判据不定，`recommendedLanguage` 就没有可验收行为。

**它需要先补设计再实现**——这是阶段 A 唯一属于这种情况的项。其余实现项不受影响，可以先做。

## 验收

见 [F-02](../features.md) / [F-03](../features.md)。要点：只读 rail 生效；覆盖率进入产出；证据不足时弃权；工具调用与摘要进入 trace。
