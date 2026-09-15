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
|A4-3 | ✅ | `run_contract_test` | 新建 | 门禁三条（起得来/工具有/调得通）；接口差异相对**基线**报告，不参与通过与否。MCP 起真实服务（agent 给的 `start`、平台挑空闲端口、导出 `PORT`），不是把业务模块当 stdin 程序跑 |
|A4-4 | 🟡 | 拆开生成与候选自检 | 改造 | `generatePortable` 一个方法里混了：代码生成 + 打包上传 + **对整个候选重新跑诊断**（含一次模型调用，最长阻塞 180s）+ 合规自检 + 重写 `candidateInspection.tools` |
|A4-5 | ✅ | A4 循环 | 新建 | 生成 → 编译 → 契约测试 → 回灌。三出口：全过 `PRODUCED` / 判定无法忠实迁移 `ABSTAINED` / 预算耗尽 `FAILED` |
|A4-6 | ✅ | 逐 Tool 弃权 | 新建 | 弃权是**逐 Tool** 的——一个 Tool 弃权退回 A3，不拖累其他 Tool |
|A4-7 | ✅ | trace 记录 | 新建 | `StageTrace.rounds`：每轮产物摘要 / 编译结果 / 契约测试结果 / 失败原因。**循环相对单次生成唯一多出来的证据** |
|A4-8 | ✅ | 生成器按语言 | 改造 | 代码（含服务外壳）由 **agent** 生成，平台不生成也不播种。三套模板已搬进技能包当指导（见 A4-13）。回退生成器只剩 Script/Python 一条路，遇到 MCP 明确拒绝并说明原因 |
|A4-9 | ✅ | 生成文件保护 | 改造 | 守卫的前缀 `migration-generated/v2/` 与实际输出（`mcp-<lang>/` / `skill/` / `scripts/`）**不匹配，永不触发**。用户改过的生成文件会被重新生成吞掉 |
|A4-10 | ✅ | 去掉模型自写冒烟输入 | 删除 | 出题人、答题人、判卷人不能是同一个 |
|A4-11 | ✅ | 交付启动命令 | 新建 | `start`（argv 数组）与可选 `prepare`（装依赖/构建）。平台按它起服务；`portable-candidate.ts` 只负责放置与路径安全，不再拼启动方式 |
|A4-12 | ✅ | 接口差异报告 | 新建 | `changes`（每一处改动 + 理由）+ `drift`（契约测试实测到的差异）随交付物上行，落进 `PortableGeneration` 并在生成步骤展示。**只是报告，不判通过与否** |
|A4-13 | ✅ | 模板进技能包 | 改造 | 三套脚手架搬进 `skills/enterprise-migration/references/service-templates.md` 当指导；分析规则在 `analysis-rules.md`。`portable-candidate.ts` 里已无模板。Java 骨架由 `scripts/verify-java-mcp-template.mjs` **从文档里读出来**编译并跑（真实 MCP 客户端），否则"指导"没人执行，会烂掉 |

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
