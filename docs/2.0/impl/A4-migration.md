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
|A4-8 | 🟡 | 生成器按语言 | 改造 | `portable-candidate.ts` 写死 Java MCP 工程 → 按源 Tool 判断语言；Script 增加 Node |
|A4-9 | ✅ | 生成文件保护 | 改造 | 守卫的前缀 `migration-generated/v2/` 与实际输出（`mcp/` / `skill/` / `scripts/`）**不匹配，永不触发**。用户改过的生成文件会被重新生成吞掉 |
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

## 验收

见 [F-05](../features.md) / [F-06](../features.md)。要点：四层全过才算达标；编译失败与契约测试失败**可区分**；弃权不交付骨架实现；每轮轨迹入 trace；通用 shell 不可用。
