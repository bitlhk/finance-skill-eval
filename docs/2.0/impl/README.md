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
