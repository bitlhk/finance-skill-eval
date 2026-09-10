import { readFile, writeFile, readdir, mkdir, cp } from "node:fs/promises";
import path from "node:path";
import { zipSync, strToU8 } from "fflate";
import { execFileSync } from "node:child_process";
import { parse, stringify } from "yaml";
import { SkillStore } from "../dist/service/skill-store.js";
import { EnvironmentStore } from "../dist/service/environment-store.js";

const [modelEnvFile, skillDirectory] = process.argv.slice(2);
if (!modelEnvFile || !skillDirectory) throw new Error("Usage: node scripts/bootstrap-local.mjs MODEL_ENV_FILE SKILL_DIRECTORY");
const env = Object.fromEntries((await readFile(modelEnvFile, "utf8")).split(/\r?\n/).filter(x => /^[A-Z_]+=/.test(x)).map(line => {
  const index = line.indexOf("="); return [line.slice(0, index), line.slice(index + 1).replace(/^['"]|['"]$/g, "")];
}));
if (!env.API_BASE || !env.API_KEY || !env.MODEL_NAME) throw new Error("Model environment must supply API_BASE, API_KEY, MODEL_NAME");
const mcpEndpoint = "http://127.0.0.1:56363/mcp";
const model = { providerId: "service-execution", modelId: env.MODEL_NAME, parameters: {} };
const tools = ["get_customer_profile", "get_customer_portfolio", "get_wealth_policy_basis", "prepare_wealth_allocation_context", "wealth_assistant_product_info"];
const existingConfig = await readFile(".runtime.local.json", "utf8").then(JSON.parse).catch(e => { if (e.code === "ENOENT") return {}; throw e; });
await writeFile(".runtime.local.json", JSON.stringify({ ...existingConfig, models: { ...existingConfig.models, [env.MODEL_NAME]: { baseUrl: env.API_BASE, apiKey: env.API_KEY } },
  mcp: { ...existingConfig.mcp, [mcpEndpoint]: { headers: {}, toolNames: tools, dataMode: "synthetic-snapshot" } } }, null, 2), { mode: 0o600 });
const localEnv = { FINANCE_EVAL_HOST: "127.0.0.1", FINANCE_EVAL_EXECUTION_BASE_URL: env.API_BASE, FINANCE_EVAL_EXECUTION_API_KEY: env.API_KEY,
  FINANCE_EVAL_EXECUTION_MODEL: env.MODEL_NAME, FINANCE_EVAL_ANALYZER_BASE_URL: env.API_BASE, FINANCE_EVAL_ANALYZER_API_KEY: env.API_KEY,
  FINANCE_EVAL_ANALYZER_MODEL: env.MODEL_NAME, FINANCE_EVAL_JUDGE_PROVIDER: "codex_cli", FINANCE_EVAL_JUDGE_MODEL: "gpt-6-astra",
  FINANCE_EVAL_OPTIMIZER_PROVIDER: "codex_cli", FINANCE_EVAL_OPTIMIZER_MODEL: "gpt-6-astra", FINANCE_EVAL_CODEX_BIN: process.env.FINANCE_EVAL_CODEX_BIN || execFileSync("which", ["codex"], { encoding: "utf8" }).trim() };
await writeFile(".env.local", Object.entries(localEnv).map(([k,v]) => `${k}=${JSON.stringify(v)}`).join("\n") + "\n", { mode: 0o600 });
const skills = new SkillStore(path.resolve("data")); await skills.initialize();
const archive = {};
for (const file of await readdir(skillDirectory, { recursive: true })) {
  if (file.endsWith(".md")) archive[file] = strToU8(await readFile(path.join(skillDirectory, file), "utf8"));
}
const skill = await skills.uploadZip(Buffer.from(zipSync(archive)));
const environments = new EnvironmentStore(path.resolve("data")); await environments.initialize();
const saved = await environments.list();
const mcp = saved.find(x => x.endpoint === mcpEndpoint) ?? await environments.create({ name: "财富业务快照 MCP · 模拟数据 v1", type: "mcp_streamable_http", endpoint: mcpEndpoint });
const runtime = saved.find(x => x.endpoint === "http://127.0.0.1:56362/execute") ?? await environments.create({ name: "本地 OpenJiuwen · 在线执行 / 模拟业务快照", type: "runtime_http", runtimeType: "openjiuwen", endpoint: "http://127.0.0.1:56362/execute", mcpEnvironmentIds: [mcp.environmentId] });
const source = "packs/finance/wealth-management";
const target = "packs/finance/wealth-online";
await mkdir(`${target}/cases`, { recursive: true });
await mkdir(`${target}/profiles`, { recursive: true });
await cp(`${source}/profiles/wealth-manager-judge.yaml`, `${target}/profiles/wealth-manager-judge.yaml`);
const pack = parse(await readFile(`${source}/eval.yaml`, "utf8"));
Object.assign(pack, { packId: "wealth-manager-online-v1", version: "1.0.0", targetSkillVersion: skill.version,
  description: "本地 OpenJiuwen 现场执行；只读模拟财富快照 MCP，非生产客户数据，非历史答案回放。", models: { analyzer: model, execution: { left: model, right: model }, judge: { providerId: "codex-host", modelId: "gpt-6-astra", parameters: {} } },
  variants: { left: { mode: "without_target_skill", skillId: skill.skillId }, right: { mode: "skill_version", skillId: skill.skillId, version: skill.version, artifactSha256: skill.artifactSha256 } },
  metadata: { dataMode: "synthetic-snapshot", snapshotVersion: "wealth-demo-v1", sourceSkill: skillDirectory, evidenceSemantics: "live-model-live-tools-synthetic-business-data" } });
for (const file of pack.caseFiles) {
  const c = parse(await readFile(`${source}/${file}`, "utf8")); delete c.replay;
  if (c.caseId === "WM-SKILL-EVAL-001") {
    c.prompt = "模拟客户王建国（C006）有300万元理财5天后到期，企业未来几个月可能支付设备款，想找收益更高的承接产品。请核验客户信息，准备访前简报和首轮关键问题。";
    c.requiredTools = tools.slice(0, 3);
  } else {
    c.prompt = "模拟客户陈明（C005）本次75万元待配置，投资期限3年以上，要求至少20%高流动性。请核验统一配置上下文；若就绪，形成金额闭合的稳健和适度增强两套产品方案，说明费用、风险、排除项及选择条件。";
    c.requiredTools = ["prepare_wealth_allocation_context", "wealth_assistant_product_info"];
    c.rubric.forEach(r => { r.allOf = []; r.anyOf = []; });
  }
  await writeFile(`${target}/${file}`, stringify(c));
}
await writeFile(`${target}/eval.yaml`, stringify(pack));
const holdout = parse(await readFile(`${target}/cases/ready-state-recommendation.yaml`, "utf8"));
holdout.caseId = "HOLDOUT-WM-001";
holdout.name = "留出验证：把方案取舍转化为客户决策";
holdout.prompt = "陈明（C005）本次75万元、至少20%高流动性，三年以上期限。客户说：既要收益高一点，又不想看到明显波动。请核验本次配置条件，给出两套不同风险取舍的可比较方案，并用客户听得懂的话解释封闭期和流动性，以及哪一个回答会影响选择。";
await writeFile(`${target}/cases/holdout-recommendation.yaml`, stringify(holdout));
pack.holdoutCaseFiles = ["cases/holdout-recommendation.yaml"];
await writeFile(`${target}/eval.yaml`, stringify(pack));
console.log(JSON.stringify({ skill: { assetId: skill.assetId, version: skill.version }, runtimeId: runtime.environmentId, model: model.modelId, dataMode: "synthetic-snapshot" }));
