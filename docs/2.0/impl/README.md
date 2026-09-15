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
| A2 检查诊断 | [A2-inspection.md](./A2-inspection.md) | F-02 / F-03 | 4 | 3 | — | 7/7 |
| A3 授权 | [A3-authorization.md](./A3-authorization.md) | F-04 | — | 2 | — | 2/2 |
| A4 改造 + 验证 | [A4-migration.md](./A4-migration.md) | F-05 / F-06 | 6 | 3 | 1 | 8/10 |
| 跨 stage | 见下 | — | 1 | 2 | — | 2/3 |
| **合计** | | | **11** | **13** | **1** | **21/25** |

**状态标记**：✅ 完成（已实测） · 🟡 部分 · ⚠ 被 [L0 §2.2](../L0-overall-architecture.md) 的待定项挡住 · ❌ 未做

**已跑通并实测**：A1 全部；A2 的 agent 入口、扫描器工具、规范技能包、证据校验、语言判据（四档 + 跨语言提示 + 不支持的源语言，单测覆盖）；A3 的形式/语言分离（实测：平台建议 MCP，人工选 SCRIPT，计划按语言给出 `language=python`）；A4 的 agent 入口与三个领域工具；**A4-8 的三套 MCP 脚手架**（实测：Java / Python / Node 各生成一个服务工程，起服务后用真实 MCP 客户端跑通 `initialize` → `tools/list` → `tools/call`，`tools/list` 公布的正是 A2 提取的源 Schema）；X-2 的 TS↔Python 契约。`A1 → A2 → A3 → A4` 的完整链路已端到端验证。

---

## 跨 stage

| ID | 状态 | 特性 | 类型 | 说明 |
| --- | --- | --- | --- | --- |
|X-1 | ❌ | 统一契约信封 | 改造 | 现有 5 种绑定字段名（`assetDigest` / `artifactSha256` / `candidateDigest` / `baseAssetId` / `digest`）收敛为一种。见 L1 §3.5 |
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
        → A2-5 / A2-6 / A2-7    （证据校验、弃权、修工具发现）
          → A3 授权
            → X-2 TS ↔ Python 契约
              → A4-1 / A4-2 / A4-4 / A4-8
                → A4-3 契约测试        ← A4 的关键路径
                  → A4-5 / A4-6 / A4-7 （循环、弃权、trace）
                    → A4-9 / A4-10
```

## 卡点

1. **A4-3 的契约测试不覆盖 Java。** `run_contract_test` 只支持 python / node，而 Java MCP 是首期主力路径——它只有 `javac` 一层把关。要么给 Java 加"编译 + 跑一个 Main"的契约测试，要么在文档里明确 Java 的验证强度低于其他语言。
2. **回退生成器只支持 MCP/Java 与 Script/Python。** `MigrationCodeGenerator` 是 agent 不可用时的兜底；它现在会明确拒绝其他组合，而不是产出一个错的。扩到 python/node MCP 是笔独立的账。
