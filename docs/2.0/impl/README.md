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
| A2 检查诊断 | [A2-inspection.md](./A2-inspection.md) | F-02 / F-03 | 5 | 3 | — | 7/8 |
| A3 授权 | [A3-authorization.md](./A3-authorization.md) | F-04 | — | 2 | — | 2/2 |
| A4 改造 + 验证 | [A4-migration.md](./A4-migration.md) | F-05 / F-06 | 9 | 3 | 1 | 12/13 |
| 跨 stage | 见下 | — | 1 | 2 | — | 2/3 |
| **合计** | | | **15** | **13** | **1** | **26/29** |

**状态标记**：✅ 完成（已实测） · 🟡 部分（已实现，但按最新决策需改方向） · ❌ 未做

**已跑通并实测**：A1 全部；A2 的 agent 入口、扫描器工具、规范技能包、证据校验、语言判据（四档 + 跨语言提示 + 不支持的源语言，单测覆盖）；A3 的形式/语言分离（实测：平台建议 MCP，人工选 SCRIPT，计划按语言给出 `language=python`）；A4 的 agent 入口与三个领域工具、**交付物带启动命令**（实测：Python / Node MCP 服务按 agent 给的 `start` 起起来，真实 MCP 客户端跑通 `initialize` → `tools/list` → `tools/call`）；X-2 的 TS↔Python 契约。`A1 → A2 → A3 → A4` 的完整链路已端到端验证。

**A4 的生成权现在已经全在 agent 手里**：平台不生成服务、不播种模板，只按 agent 报告的真实路径落文件、护住路径边界、算 diff。三套脚手架留在技能包 `references/service-templates.md` 当**指导**。

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

1. **测试集还没接到分析上。** 分析已经产出基线（工具、输入输出、样例），平台也有出题能力（`ANALYZER` / `preparations` / `ai_generated`）；两者还没接起来。注意验收措辞：**迁移前的 runtime 跑不起来**，所以不能写"效果一致"，只能写"接口未见显著变化 + 测试集通过"。
2. **A4-4 没拆开。** `generatePortable` 一个方法里仍然混着：放置 + 上传 + **对整个候选重跑一次诊断（含一次模型调用，最长阻塞 180s）** + 合规自检 + 重写 `candidateInspection.tools`。
3. **回退生成器只产 Script/Python。** `MigrationCodeGenerator` 是 agent 不可用时的兜底，遇到 MCP 直接拒绝并说明；扩到 python/node MCP 是笔独立的账（但按最新决策，平台不该生成服务，所以这笔账要不要做存疑）。
4. **A2-6 弃权还是 🟡。** 终态靠 `status=ABSTAINED` 表达，不用工具表达终态。
