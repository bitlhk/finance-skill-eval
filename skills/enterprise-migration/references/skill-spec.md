# 企业 Skill 规范（合规检查）

只判断**文档是否符合规范**，不判断 Tool 能不能运行。

## 必须满足

| 检查项 | 判据 | 严重度 |
| --- | --- | --- |
| 唯一入口 | 有且仅有一个 `SKILL.md`，大小写准确 | ERROR |
| 入口位置 | 位于 Skill 包根目录，不是嵌套在子目录里 | WARNING |
| `name` | 存在、非空、与所在目录名一致（目录名允许 `skill` 这一通用名） | ERROR / WARNING |
| `description` | 存在、非空、说明**何时使用**（不是复述标题） | ERROR |
| 引用存在 | frontmatter 与正文中以 `` `references/...` ``、`` `scripts/...` ``、`](./...)` 形式引用的文件都必须真实存在 | ERROR |
| 目录卫生 | 除了 `SKILL.md`，顶层只允许 `scripts/`、`references/`、`assets/`。可执行脚本放在 `references/` 或根目录属于待迁移问题，**不阻塞生成** | WARNING |
| 凭据 | 正文或 frontmatter 中不得出现硬编码的密钥、口令、令牌 | ERROR |
| 绝对路径 | 不得出现机器专用绝对路径（如 `C:\Users\...`、`/home/...`） | WARNING |
| 失败处理 | 必须说明信息不足、失败、被拒绝时怎么办 | WARNING |
| Runtime 专用步骤 | 不得把源 Runtime 的安装或注册步骤写进 Skill | WARNING |

## 明确不做的判断

- **不**因为 Tool 是 Java / Python / 其他语言而判 Skill 不合规。
- **不**因为文件多、文档长而判不合规。
- **不**把"缺 Tool 清单"当作错误——平台自己从源码提取，不要求 Skill 提供清单。

## 输出

每条 finding 必须带 `code`、`severity`、`path`、`line`、`message`、`suggestion`。
`line` 必须是能对上原文的行号，否则不要报。
