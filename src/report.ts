import { fingerprint, type EvalPack, type JudgeResult, type RuntimeExecutionEvidence } from "./contracts.js";

export type EvaluationCaseReport = {
  caseId: string;
  name: string;
  prompt: string;
  evaluationGoal: string;
  left: RuntimeExecutionEvidence;
  right: RuntimeExecutionEvidence;
  judge: JudgeResult | null;
  judgeError: string | null;
};

export type SkillOptimizationSuggestion = {
  caseId: string;
  criterionId: string;
  title: string;
  recommendation: string;
  type: "target_gap" | "demonstrated_value";
};

export type EvaluationReport = {
  schemaVersion: "finance.skill-eval.report.v1";
  reportId: string;
  generatedAt: string;
  pack: {
    packId: string;
    version: string;
    fingerprint: string;
    domain: string;
    targetSkillId: string;
    targetSkillVersion: string;
  };
  models: EvalPack["models"];
  variants: EvalPack["variants"];
  runtimeAdapterId: string;
  judgeId: string;
  promptfoo: {
    version: "0.122.2";
    completed: boolean;
  };
  cases: EvaluationCaseReport[];
  summary: {
    leftWins: number;
    rightWins: number;
    ties: number;
    headline: string;
    meanElapsedMs: { left: number; right: number };
    totalTokens: { left: number; right: number };
  };
  suggestions: SkillOptimizationSuggestion[];
  reportFingerprint: string;
};

function criterionPassed(output: string, criterion: EvalPack["cases"][number]["rubric"][number]): boolean {
  const match = (pattern: string) => new RegExp(pattern, "iu").test(output);
  return criterion.allOf.every(match)
    && (criterion.anyOf.length === 0 || criterion.anyOf.some(match))
    && criterion.noneOf.every(pattern => !match(pattern));
}

export function buildSuggestions(
  pack: EvalPack,
  cases: EvaluationCaseReport[],
): SkillOptimizationSuggestion[] {
  const suggestions: SkillOptimizationSuggestion[] = [];
  for (const result of cases) {
    const evalCase = pack.cases.find(item => item.caseId === result.caseId);
    if (!evalCase) continue;
    for (const criterion of evalCase.rubric) {
      const leftPass = criterionPassed(result.left.output, criterion);
      const rightPass = criterionPassed(result.right.output, criterion);
      if (!rightPass) {
        suggestions.push({
          caseId: result.caseId,
          criterionId: criterion.criterionId,
          title: `补强：${criterion.label}`,
          recommendation: criterion.improvementHint ?? criterion.description,
          type: "target_gap",
        });
      } else if (!leftPass) {
        suggestions.push({
          caseId: result.caseId,
          criterionId: criterion.criterionId,
          title: `已证明增益：${criterion.label}`,
          recommendation: criterion.description,
          type: "demonstrated_value",
        });
      }
    }
  }
  return suggestions;
}

export function buildReport(input: {
  pack: EvalPack;
  runtimeAdapterId: string;
  judgeId: string;
  cases: EvaluationCaseReport[];
  reportId: string;
}): EvaluationReport {
  const leftWins = input.cases.filter(item => item.judge?.winner === "left").length;
  const rightWins = input.cases.filter(item => item.judge?.winner === "right").length;
  const ties = input.cases.filter(item => item.judge?.winner === "tie").length;
  const unavailable = input.cases.length - leftWins - rightWins - ties;
  const average = (side: "left" | "right") => input.cases.length === 0
    ? 0
    : Math.round(input.cases.reduce((sum, item) => sum + item[side].elapsedMs, 0) / input.cases.length);
  const tokens = (side: "left" | "right") => input.cases.reduce(
    (sum, item) => sum + (item[side].usage?.totalTokens ?? 0),
    0,
  );
  const base = {
    schemaVersion: "finance.skill-eval.report.v1" as const,
    reportId: input.reportId,
    generatedAt: new Date().toISOString(),
    pack: {
      packId: input.pack.packId,
      version: input.pack.version,
      fingerprint: input.pack.packFingerprint,
      domain: input.pack.domain,
      targetSkillId: input.pack.targetSkillId,
      targetSkillVersion: input.pack.targetSkillVersion,
    },
    models: input.pack.models,
    variants: input.pack.variants,
    runtimeAdapterId: input.runtimeAdapterId,
    judgeId: input.judgeId,
    promptfoo: { version: "0.122.2" as const, completed: true },
    cases: input.cases,
    summary: {
      leftWins,
      rightWins,
      ties,
      headline: unavailable === input.cases.length
        ? "左右输出已完成，专业 Judge 暂未形成可用结论"
        : leftWins === rightWins
          ? `本轮对比持平：左右各胜 ${leftWins} 题${ties ? `，${ties} 题持平` : ""}`
          : rightWins > leftWins
            ? `右侧在 ${rightWins}/${input.cases.length} 个任务中表现更优`
            : `左侧在 ${leftWins}/${input.cases.length} 个任务中表现更优`,
      meanElapsedMs: { left: average("left"), right: average("right") },
      totalTokens: { left: tokens("left"), right: tokens("right") },
    },
    suggestions: buildSuggestions(input.pack, input.cases),
  };
  return {
    ...base,
    reportFingerprint: fingerprint(base),
  };
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function variantLabel(variant: EvalPack["variants"]["left"]): string {
  return variant.mode === "without_target_skill" ? "不装配目标 Skill" : `${variant.skillId}@${variant.version}`;
}

function formatOutput(value: string): string {
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value;
  }
}

export function renderHtmlReport(report: EvaluationReport): string {
  const caseSections = report.cases.map(item => {
    const judge = item.judge;
    return `
    <section class="case">
      <header>
        <div><span class="case-id">${escapeHtml(item.caseId)}</span><h2>${escapeHtml(item.name)}</h2></div>
        <strong class="winner">${judge?.winner === "right" ? "右侧更优" : judge?.winner === "left" ? "左侧更优" : judge ? "表现持平" : "Judge 暂不可用"}</strong>
      </header>
      <p class="goal">${escapeHtml(item.evaluationGoal)}</p>
      <div class="columns">
        <article><h3>左侧</h3><pre>${escapeHtml(formatOutput(item.left.output))}</pre></article>
        <article><h3>右侧</h3><pre>${escapeHtml(formatOutput(item.right.output))}</pre></article>
      </div>
      <div class="judge">
        <h3>金融专业评价</h3>
        <p>${escapeHtml(judge?.summary ?? item.judgeError ?? "未形成评价")}</p>
        <table><thead><tr><th>维度</th><th>左</th><th>右</th><th>判断依据</th></tr></thead><tbody>
          ${(judge?.dimensions ?? []).map(dimension => `<tr><td>${escapeHtml(dimension.label)}</td><td>${dimension.leftScore}</td><td>${dimension.rightScore}</td><td>${escapeHtml(dimension.reason)}</td></tr>`).join("")}
        </tbody></table>
      </div>
    </section>`;
  }).join("");
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(report.pack.targetSkillId)} Skill 评测</title>
<style>
  :root{font-family:Inter,"PingFang SC","Microsoft YaHei",sans-serif;color:#172026;background:#f5f7f8}body{margin:0}main{max-width:1480px;margin:0 auto;padding:32px}h1,h2,h3,p{margin-top:0}.hero{background:#fff;border-top:5px solid #007d6e;padding:28px;border-bottom:1px solid #dce3e5}.eyebrow,.case-id{font-size:12px;font-weight:700;color:#007d6e;text-transform:uppercase}.summary{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:1px;background:#dce3e5;border:1px solid #dce3e5;margin:24px 0}.metric{background:#fff;padding:18px}.metric b{font-size:26px;display:block;margin-top:5px}.case{background:#fff;border:1px solid #dce3e5;margin:20px 0;padding:24px}.case>header{display:flex;justify-content:space-between;gap:20px;align-items:start}.winner{color:#007d6e}.goal{color:#52636b}.columns{display:grid;grid-template-columns:1fr 1fr;gap:16px}.columns article{min-width:0;border-top:3px solid #9aa9af;padding-top:12px}.columns article:last-child{border-color:#007d6e}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:13px/1.65 ui-monospace,SFMono-Regular,Consolas,monospace;background:#f7f9f9;padding:16px;max-height:520px;overflow:auto}.judge{margin-top:18px;border-top:1px solid #dce3e5;padding-top:18px}table{width:100%;border-collapse:collapse;font-size:13px}th,td{text-align:left;border-bottom:1px solid #e4e9eb;padding:10px;vertical-align:top}th{background:#f4f7f7}.meta{color:#61727a;font-size:13px}@media(max-width:900px){main{padding:16px}.summary,.columns{grid-template-columns:1fr}.case{padding:16px}}
</style></head><body><main>
  <section class="hero"><div class="eyebrow">Finance Skill Eval</div><h1>${escapeHtml(report.pack.targetSkillId)} 专业能力对比</h1><p>${escapeHtml(report.summary.headline)}</p><div class="meta">左：${escapeHtml(variantLabel(report.variants.left))} · 右：${escapeHtml(variantLabel(report.variants.right))} · Pack ${escapeHtml(report.pack.packId)}@${escapeHtml(report.pack.version)}</div></section>
  <section class="summary"><div class="metric">右侧胜出<b>${report.summary.rightWins}</b></div><div class="metric">左侧胜出<b>${report.summary.leftWins}</b></div><div class="metric">持平<b>${report.summary.ties}</b></div><div class="metric">案例数<b>${report.cases.length}</b></div></section>
  ${caseSections}
  <p class="meta">Report fingerprint: ${report.reportFingerprint}</p>
</main></body></html>`;
}
