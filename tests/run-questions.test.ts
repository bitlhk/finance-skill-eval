import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadEvalPack } from "../src/eval-pack.js";
import { generateRunQuestions } from "../src/service/run-questions.js";
import { EvaluationJobStore } from "../src/service/job-store.js";
import { EvaluationRunManager } from "../src/service/run-manager.js";
import { runConfigurationSchema } from "../src/service/contracts.js";

const mocks = vi.hoisted(() => ({ complete: vi.fn(), run: vi.fn() }));
vi.mock("../src/service/config.js", () => ({ configuredModelRole: () => ({ configured: true, model: { providerId: "test", modelId: "analyzer", parameters: {} }, adapter: { adapterId: "fake", complete: mocks.complete } }) }));
vi.mock("../src/runner.js", () => ({ EvaluationCancelledError: class extends Error {}, runEvaluation: mocks.run }));
const model = { providerId: "test", modelId: "analyzer", parameters: {} };
const skill = { instructions: "点评真实对话，不虚构事实", artifactSha256: "a".repeat(64), files: { "references/sop.md": "发现真实断点", "evals/hidden.md": "禁止泄漏答案", "references/sealed-key.md": "禁止泄漏映射" } };
const example = (name: string, tools: string[] = []) => ({ summary: "专业点评", cases: [{ caseId: name, name, prompt: `虚构对话：客户说贵。请给出${name}点评。`, taskMode: "single_turn", evaluationGoal: "基于原句提出有效追问", requiredTools: tools, rubric: [{ criterionId: "quality", label: "问题质量", description: "问题能改变下一步判断", dimension: "actionability", weight: 1, required: true }] }] });
const packPromise = loadEvalPack(path.resolve("packs/finance/wealth-online/eval.yaml"));
const directories: string[] = [];
afterEach(async () => { vi.clearAllMocks(); await Promise.all(directories.splice(0).map(p => rm(p, { recursive: true, force: true }))); });

describe("per-run AI questions", () => {
  it("reads professional references but not hidden answers; each run has a fresh request identity", async () => {
    const input = { pack: await packPromise, skill, adapter: { adapterId: "fake", complete: mocks.complete }, model, count: 1, signal: new AbortController().signal };
    mocks.complete.mockImplementation(async r => ({ modelId: "analyzer", content: JSON.stringify(example(r.requestId)) }));
    const a = await generateRunQuestions({ ...input, generationId: "run-a" });
    const b = await generateRunQuestions({ ...input, generationId: "run-b" });
    expect(a.fingerprint).not.toBe(b.fingerprint);
    expect(a.sourceFiles).toEqual(["SKILL.md", "references/sop.md"]);
    const request = JSON.parse(mocks.complete.mock.calls[0]![0].messages[1].content);
    expect(request.skillSource).toContain("发现真实断点");
    expect(request.skillSource).not.toContain("禁止泄漏");
    expect(request.caseDesignContext.seedTasks[0]).not.toHaveProperty("evaluationGoal");
    expect(request.caseDesignContext.seedTasks[0].prompt).toBe("");
    expect(request).not.toHaveProperty("existingPrompts");
    expect(mocks.complete.mock.calls[0]![0].signal).toBe(input.signal);
  });

  it.each(["unknown-tool", "duplicate-id", "too-many", "multi-turn", "copied-seed", "missing-subject", "fixture-hypothesis"])("rejects %s without falling back to fixed questions", async kind => {
    const output = example("case", kind === "unknown-tool" ? ["transfer.execute"] : []);
    if (kind === "duplicate-id") output.cases.push(output.cases[0]!);
    if (kind === "too-many") output.cases.push({ ...output.cases[0]!, caseId: "another" });
    if (kind === "multi-turn") output.cases[0]!.taskMode = "multi_turn";
    if (kind === "copied-seed") output.cases[0]!.prompt = (await packPromise).cases[0]!.prompt.replace(/。/gu, "。\n");
    if (kind === "missing-subject") output.cases[0]!.requiredTools = ["get_customer_profile"];
    if (kind === "fixture-hypothesis") { output.cases[0]!.prompt = "假设场景：客户C005的风险评估已过期，请处理。"; output.cases[0]!.requiredTools = ["get_customer_profile"]; }
    mocks.complete.mockResolvedValue({ modelId: "analyzer", content: JSON.stringify(output) });
    await expect(generateRunQuestions({ pack: await packPromise, skill, adapter: { adapterId: "fake", complete: mocks.complete }, model, count: 1, generationId: "bad", signal: new AbortController().signal })).rejects.toThrow();
    expect(mocks.complete).toHaveBeenCalledTimes(2);
  });

  it("does not make a repair request after cancellation", async () => {
    const controller = new AbortController();
    mocks.complete.mockImplementation(async () => { controller.abort(); return { modelId: "analyzer", content: "bad" }; });
    await expect(generateRunQuestions({ pack: await packPromise, skill, adapter: { adapterId: "fake", complete: mocks.complete }, model, count: 1, generationId: "cancelled", signal: controller.signal })).rejects.toThrow();
    expect(mocks.complete).toHaveBeenCalledTimes(1);
  });

  it("rejects dynamic replay, holdout and preselected questions at the API contract", () => {
    for (const extra of [{ runtime: { type: "replay" } }, { includeHoldout: true }, { selectedCaseIds: ["fixed"] }, { judgeMode: "deterministic" }]) {
      expect(runConfigurationSchema.safeParse({ packId: "test", runtime: { type: "runtime_launcher", environmentId: "env" }, judgeMode: "model", caseSource: "ai_generated", ...extra }).success).toBe(false);
    }
  });

  it("freezes one batch for both sides and retains that batch on retry", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "eval-questions-")); directories.push(root);
    const jobs = new EvaluationJobStore(root); await jobs.initialize();
    const pack = structuredClone(await packPromise);
    pack.holdoutCases?.forEach(item => Object.assign(item as object, { requiredTools: [] }));
    const asset = { assetId: "asset", skillId: pack.targetSkillId, version: pack.targetSkillVersion, artifactSha256: pack.variants.right.mode === "skill_version" ? pack.variants.right.artifactSha256 : skill.artifactSha256 };
    const environment = { environmentId: "env", name:'Launcher', type: "runtime_launcher", runtimeType:'openjiuwen', baseUrl: "http://127.0.0.1:9000/", credentialEnv:null, archived:false, createdAt:new Date().toISOString(),updatedAt:new Date().toISOString() };
    const requireAvailable = vi.fn(async (id:string) => { expect(id).toBe(environment.environmentId); return environment; });
    const resolveLauncher = vi.fn(async (record:unknown) => { expect(record).toEqual(environment); return {launcher:environment,mcpEnvironmentIds:[],defaultModelId:null}; });
    const manager = new EvaluationRunManager({ jobs, maxConcurrentRuns: 1,
      catalog: { get: () => structuredClone(pack) } as never, preparations: {} as never,
      skills: { list: async () => [asset], readSource: async () => skill.instructions, readFiles: async () => skill.files,
        readArchive:async()=>Object.fromEntries([['SKILL.md',skill.instructions],...Object.entries(skill.files)].map(([name,value])=>[name,Buffer.from(value)])) } as never,
      environments: {
        get: async (id:string) => { expect(id).toBe(environment.environmentId); return environment; },
        requireAvailable,
        resolveLauncher,
        headers: () => ({}),
        inspect:async()=>({status:'ready',elapsedMs:1,error:null,toolCount:0,tools:[],mcpServers:[],capabilities:{models:[{modelId:model.modelId}],defaultModelId:model.modelId}}),
      } as never,
    });
    mocks.complete.mockResolvedValue({ modelId: "analyzer", content: JSON.stringify(example("dynamic-one")) });
    mocks.run.mockRejectedValueOnce(new Error("runtime unavailable")).mockImplementation(async ({ pack: resolved }) => ({ reportFingerprint: "old", cases: resolved.cases }));
    const config = { packId: pack.packId, runtime: { type: "runtime_launcher", environmentId: "env" }, caseSource: "ai_generated", judgeMode: "model", executionModel: model };
    const first = await manager.create(config);
    await vi.waitFor(() => expect(jobs.get(first.jobId)?.status).toBe("failed"));
    const frozen = jobs.get(first.jobId)!.questionSet!;
    expect(frozen.cases[0]?.caseId).toBe("dynamic-one");
    const retry = await manager.retry(first.jobId);
    await vi.waitFor(() => {const current=jobs.get(retry.jobId);if(current?.status==='failed')throw new Error(JSON.stringify(current.error));expect(current?.status).toBe("completed");});
    expect(mocks.complete).toHaveBeenCalledTimes(1);
    expect(jobs.get(retry.jobId)?.questionSet).toEqual(frozen);
    expect(mocks.run.mock.calls[0]![0].pack.cases).toEqual(mocks.run.mock.calls[1]![0].pack.cases);
    expect(jobs.get(retry.jobId)?.report?.questionSet).toEqual(frozen);
    mocks.complete.mockResolvedValue({ modelId: "analyzer", content: JSON.stringify(example("dynamic-two")) });
    const fresh = await manager.create(config);
    await vi.waitFor(() => expect(jobs.get(fresh.jobId)?.status).toBe("completed"));
    expect(jobs.get(fresh.jobId)?.questionSet?.fingerprint).not.toBe(frozen.fingerprint);
    expect(mocks.complete).toHaveBeenCalledTimes(2);
    const regression = await manager.create({ ...config, caseSource: "fixed", includeHoldout: true }, frozen);
    await vi.waitFor(() => expect(jobs.get(regression.jobId)?.status).toBe("completed"));
    expect(mocks.complete).toHaveBeenCalledTimes(2);
    expect(mocks.run.mock.calls.at(-1)![0].pack.cases).toHaveLength(frozen.cases.length + (pack.holdoutCases?.length ?? 0));
    expect(mocks.run.mock.calls.at(-1)![0].pack.cases[0]).toEqual(frozen.cases[0]);
    expect(requireAvailable).toHaveBeenCalledTimes(8);
    expect(resolveLauncher).toHaveBeenCalledTimes(4);
  });
});
