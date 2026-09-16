# 阶段 A 实施拆解

本文只讲**要动什么、按什么顺序动**。

- 产品特性与**验收标准**见 [features.md](../features.md)（F-01 ～ F-10）
- 架构与**实现方案**见 [L0](../L0-overall-architecture.md)（决策）、[L1](../L1-module-architecture.md)（模块）
- 未定项见 [L0 §2.2](../L0-overall-architecture.md)

每个 stage 一份拆解，验收不在这里重复，只引用 F-xx。

---

## 总览

| Stage | 拆解 | 对应特性 | 新建 | 改造 | 删除 | 完成 |
| --- | --- | --- | --- | --- | --- | --- |
| A1 导入 | [A1-import.md](./A1-import.md) | F-01 | — | 3 | — | 3/3 |
| A2 检查诊断 | [A2-inspection.md](./A2-inspection.md) | F-02 / F-03 | 5 | 3 | — | 8/8 |
| A3 授权 | [A3-authorization.md](./A3-authorization.md) | F-04 | — | 2 | — | 2/2 |
| A4 改造 + 验证 | [A4-migration.md](./A4-migration.md) | F-05 / F-06 | 9 | 3 | 1 | 13/13 |
| 跨 stage | 见下 | — | 1 | 2 | — | 3/3 |
| **合计** | | | **15** | **13** | **1** | **29/29** |

**状态标记**：✅ 完成（已实测） · 🟡 部分（已实现，但按最新决策需改方向） · ❌ 未做

**已跑通并实测**：A1 全部；A2 的 agent 入口、扫描器工具、规范技能包、证据校验、语言判据（四档 + 跨语言提示 + 不支持的源语言，单测覆盖）；A3 的形式/语言分离（实测：平台建议 MCP，人工选 SCRIPT，计划按语言给出 `language=python`）；A4 的 agent 入口与三个领域工具、**交付物带启动命令**（实测：Python / Node MCP 服务按 agent 给的 `start` 起起来，真实 MCP 客户端跑通 `initialize` → `tools/list` → `tools/call`）；X-2 的 TS↔Python 契约。`A1 → A2 → A3 → A4` 的完整链路已端到端验证——**包括用真模型跑通**（`scripts/verify-real-agent-migration.mjs`：分析读出两个工具与各自契约、授权、A4 交出候选（含 agent 自己排的 `migrated/mcp/<tool>/` 服务工程）、从分析生成测试集）。

**A4 的生成权现在已经全在 agent 手里**：平台不生成服务、不播种模板，只按 agent 报告的真实路径落文件、护住路径边界、算 diff。三套脚手架留在技能包 `references/service-templates.md` 当**指导**；**平台按交付物声明的 `start` 把服务起起来做技术验证**（`service-launch.ts`），不是让操作者手填一个地址。

---

## 跨 stage

| ID | 状态 | 特性 | 类型 | 说明 |
| --- | --- | --- | --- | --- |
|X-1 | ✅ | 统一契约信封 | 改造 | stage 边界上就是一个名字：`StageEnvelope.binding.assetDigest`（见 L1 §3.5 的三条规则），A2 的产物按信封落盘并在 `/inspection` 上校验绑定。**剩下三个不收敛，各有实测理由**：`artifactSha256` 被目标 Host 的 Java 自己读（`NativeMigrationHost.java:46`）、`baseAssetId` 是 **id 不是摘要**（`d.baseAssetId===baseAssetId` 比的是资产 id）、`candidateDigest` 带限定（同一个工程里有源与候选两份资产，去掉限定反而丢信息）。改名要么破坏一个已编译的外部集成，要么把名字改错 |
|X-2 | ✅ | TS ↔ Python agent 调用契约 | 新建 | 新增请求 schema 或端点。现有 `finance.skill-eval.runtime-request.v1` 强制评估形状（`case` / `side` / `variant`），迁移 agent 用不了 |
|X-3 | ✅ | 版本号动态读取 | 改造 | `session.py` 写死字面量 → `importlib.metadata.version("openjiuwen")`。否则升级后证据会撒谎 |
|X-4 | ✅ | 单次补全的时限只有一个作者 | 新建 | `modelTimeoutMs(role)` 是唯一出处，`FINANCE_EVAL_{ROLE}_TIMEOUT_MS` 可覆盖。见下 |

### X-4 时限为什么得按角色给，而且只能给一处

**出题那一步的预算是错的。** 真链路里测试集生成报 500「operation aborted due to timeout」，
单跑复现同样是 180.0 秒整——**正好是预算本身**。把上限抬掉再连跑三次，同一个请求：

| | 耗时 | reasoning tokens |
| --- | --- | --- |
| 1 | 185.0 s | 21,206 |
| 2 | 36.2 s | 851（命中 prompt 缓存） |
| 3 | 146.5 s | 19,598 |

`deepseek-v4-flash` 是推理模型，**同一请求的耗时取决于它自己决定想多久**，36 秒到 185 秒之间摆动，
而 180 秒的线**正落在分布中间**。于是这一步按一个没人看得见的节奏失败，而且报出来是"超时"——
听起来像卡死，其实只是预算比模型的一个自由变量还小。**推理长度是模型的选择，不是我们的，所以线要压在尾巴外面，不能压在中间。**

**为什么只能给一处。** 适配器和调用方各设过一道：`AbortSignal.any([caller, adapter])` 谁先到谁生效，
所以调用方那道只要更短就会**静默赢**——代码生成器写的是 300 秒，而 MIGRATION 角色的适配器是 180 秒，
那 300 秒从来没生效过。现在调用方一律不设，时限归角色，角色归 `modelTimeoutMs`。

**为什么要有环境变量。** 这个故障是间歇的，而"换个模型"是运维的日常动作；
发现的那一方应该能当场改，不必等一个版本。

### X-4 续：agent 内部的两道预算也是同一回事

同一个推理模型，同一天，A2 连续失败。抓下来是**两个**不同的失败，但都是同一类——**预算比模型的一个自由变量还小**：

| 现象 | 根因 | 出处 |
| --- | --- | --- |
| `NO_JSON_IN_OUTPUT`，输出为空、harness 不报错 | `max_tokens=6000`，推理把预算用完，`content` 空返回 | `analyze_agent.py` 的字面默认值 |
| `FrameworkError: model call failed ... Request timed out.` | `init_model(timeout=60.0)`，**框架默认每次调用 60 秒** | openjiuwen `model.py:571` |

对照实验（A2 真模型，同一 fixture）：

| 配置 | 结果 |
| --- | --- |
| `max_tokens=6000`（原值） | 3/3 空回答 |
| `max_tokens=32000` | 2/3（余下一次是框架 60 秒超时）|
| `max_tokens=32000` + `timeout=600s` | **4/4 通过** |

两处都是**我们从来没设过**的：`maxTokens` 这个字段 agent 一直在读，平台从来没发；`timeout` 更是
连读都没读，直接吃了框架的默认值。所以修法一致——**平台把两道预算都发下去，按角色给**：

| 预算 | 环境变量 | 默认 |
| --- | --- | --- |
| 一次调用的输出上限 | `FINANCE_EVAL_{ROLE}_MAX_TOKENS`（回退 `FINANCE_EVAL_AGENT_MAX_TOKENS`） | 32000 |
| 一次调用的时间上限 | `FINANCE_EVAL_{ROLE}_TIMEOUT_MS`（同 `modelTimeoutMs`） | ANALYZER 600 s / MIGRATION 300 s |

**按角色而不是按 stage 命名**：`FINANCE_EVAL_ANALYZER_*` / `FINANCE_EVAL_MIGRATION_*` 早就在选模型、
选端点、选时限了，预算是同一句话里的东西。映射只有一处（`migration-agent.ts` 的 `STAGE_ROLE`）。

**注意别把两个 timeout 混在一起**：`MigrationAgentOptions.timeoutMs` 是**整个子进程**的上限（15 分钟），
发到 agent 的是 `modelTimeoutMs`（**单次调用**）。这两个数差一个数量级，混了就会把正常的长跑判死。

---

## 依赖顺序

按依赖排，不按 ID：

```
X-1 统一契约信封
  → X-3 版本号动态读取
    → A1 导入
      → A2-1 / A2-2 / A2-3      （agent 入口、扫描器工具、规范技能包）
        → A2-5 / A2-6          （证据校验、弃权）
          → A2-8 「对 Skill 的分析」   ← 整条链的上游
            → A3 授权（拿分析结果做决定）
              → X-2 TS ↔ Python 契约
                → A4-1 / A4-2 / A4-4 / A4-13（模板进技能包）
                  → A4-3 契约测试 + A4-11 启动命令 + A4-12 差异报告
                    → A4-5 / A4-6 / A4-7 （循环、弃权、trace）
                      → A4-8 / A4-9 / A4-10
```

**A2-8 是新的关键路径上游**：A4 的基线、校验的比对对象、测试集的种子，三样都从它来。它不定，A4-3 和 A4-12 都没有可比的东西。

## 卡点

1. **真模型那条只有开发机能跑。** `scripts/verify-real-agent-migration.mjs` 要模型密钥，按设计不进 CI。
   骨架校验（`test:skeleton:mcp`）与浏览器回归（`test:ui:migration-v2`）都已经在 CI 里。
