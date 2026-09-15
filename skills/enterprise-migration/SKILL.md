---
name: enterprise-migration
description: 企业 Skill 迁移平台的检查与判断依据。用于判断一个源工程的 Skill 是否合规、每个 Tool 的可移植性如何、以及该建议迁移成什么形式和语言。
version: 1.0.0
---

# 企业 Skill 迁移：判断依据

这是迁移平台自己的判断依据，不是要求被检查的工程遵守的新文件。

**先判断需要哪一份，再读它。不要凭印象作答。**

| 你要判断的事 | 读哪一份 |
| --- | --- |
| Skill 文档是否符合企业规范 | `references/skill-spec.md` |
| **这个 Skill 用到了哪些工具、每个的输入输出和样例是什么** | `references/analysis-rules.md` |
| **迁移出来的服务和脚本要长成什么样**（骨架与硬要求） | `references/service-templates.md` |
| 某个 Tool 属于哪个可移植性状态 | `references/portability-rules.md` |
| 该建议它用 MCP 还是 Script、用什么语言 | `references/target-rules.md` |
| 一条发现算不算证据、覆盖率怎么看 | `references/evidence-rules.md` |

## 四条不可违反的规则

1. **可以少报，不可以编造。** 证据不足时弃权，不要猜。
2. **每条发现必须可定位。** 文件、行号、原文片段三者缺一不可；落不到就不要写。
3. **分析读出来的东西同样要可定位。** 工具的输入输出和样例，也要指到文件与行——落不到就不成立。
4. **授权的边界不在这里。** 这个工程**允不允许**被迁移，是人的决定；本技能包只负责技术判断。
