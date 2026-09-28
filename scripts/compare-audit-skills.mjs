import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { CodexCliModelAdapter } from '../dist/codex-cli-model.js';
import { ModelPairwiseJudge } from '../dist/judge.js';

const out = path.resolve(process.env.AUDIT_COMPARISON_OUT ?? 'reports/audit-skill-comparison-2026-09-05');
await mkdir(out, { recursive: true, mode: 0o700 });
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
const roots = {
  current: '/root/skill-store/marketplace/artifacts/smart-audit-assistant/1.1.0/854fbebd55606a0276c6269414cc4c8cc1e0399423b79f8c4af5c5479c6afe10',
  qualification: '/root/skill-store/agents/lgj-9ur9ahbn/uploaded/credit-audit-borrower-qualification',
  income: '/root/skill-store/agents/lgj-9ur9ahbn/uploaded/credit-audit-income-verification',
  rules: '/root/skill-store/agents/lgj-9ur9ahbn/uploaded/credit-audit-rule-generation',
};
let snapshots;
try { snapshots = JSON.parse(await readFile(path.join(out, 'skill-snapshots.json'), 'utf8')); }
catch (error) {
  if (error.code !== 'ENOENT') throw error;
  const program = `const fs=require('node:fs'),path=require('node:path'),roots=${JSON.stringify(roots)},result={};
    for(const [key,root] of Object.entries(roots)){const files={};function walk(dir){for(const f of fs.readdirSync(dir,{withFileTypes:true})){const p=path.join(dir,f.name);if(f.isDirectory())walk(p);else if(f.isFile()&&/\\.(md|txt|json|ya?ml)$/i.test(f.name))files[path.relative(root,p)]=fs.readFileSync(p,'utf8');}}walk(root);result[key]=Object.fromEntries(Object.entries(files).sort(([a],[b])=>a.localeCompare(b)));}console.log(JSON.stringify(result));`;
  snapshots = JSON.parse(execFileSync('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8',
    '-i', '/home/ubuntu/.ssh/KeyPair-ECS.pem', '-i', '/home/ubuntu/.ssh/KeyPair-ECS-03.pem',
    'root@123.60.154.110', `node -e ${quote(program)}`], { encoding: 'utf8', timeout: 30000, maxBuffer: 2 * 1024 * 1024 }));
  await writeFile(path.join(out, 'skill-snapshots.json'), JSON.stringify(snapshots, null, 2), { mode: 0o600 });
}
const skills = Object.fromEntries(Object.entries(snapshots).map(([key, files]) => {
  const source = files['SKILL.md'];
  const metadata = parseYaml(source.match(/^---\s*\n([\s\S]*?)\n---/)[1]);
  return [key, { skillId: metadata.name, version: metadata.version ?? 'unversioned',
    artifactSha256: digest(files), instructions: source, files }];
}));
const shared = '本题为固定虚构材料，只比较基于已解析文本的审核分析或规则草案。不接案件系统，不调用外部业务服务，不作最终授信审批。题面提供的模拟制度是本轮完整依据，包内默认规则仅为参考，不覆盖题面制度。\n\n';
const cases = [
  { caseId: 'AUDIT-COMPARE-001', key: 'income', name: '收入交叉验证与口径解释',
    prompt: shared + '请核验借款人甲的收入是否得到这些材料支持，说明金额、期间、口径、证据及必要补件，不要扩展成全套贷款审核。\n模拟制度 INC-v1 第1条：以近6个月可核验稳定税前工资衡量收入，月均至少1.8万元。第2条：工资实发额与税前额、社保缴费基数不直接等同；本人账户调拨不计收入；有勾稽证据时不因表面差额要求重复补件。\n已解析材料均为2026年1至6月、主体甲：A收入证明第1段，每月税前工资2万元；B工资明细表，每月税前2万元、税费及个人缴费合计0.2万元、实发1.8万元；C流水工资摘要，每月到账1.8万元，另每月0.5万元来自甲本人另一账户，摘要为本人调拨；D个税收入明细，6个月工资薪金收入合计12万元，此数不是应纳税所得额也不是已缴税额；E社保明细，缴费基数每月1.2万元。材料文本真实性未另做外部核验。',
    evaluationGoal: '2万元税前稳定月收入与1.8万元实发可勾稽；自转0.5万元不算收入；社保基数1.2万元不推翻已支持收入。支持模拟收入条件，不夸大成贷款批准或凭证验真；没有本轮证据缺口就不制造补件。' },
  { caseId: 'AUDIT-COMPARE-002', key: 'qualification', name: '主体资格与条件性材料要求',
    prompt: shared + '仅审核主体资格，输出逐条判断、证据和最小补件。\n模拟制度 QUAL-v1：第1条，申请当日年龄18至65岁；第2条，身份证、户籍资料与申请表姓名及证件引用一致；第3条，只有申请人已婚时才要求结婚证明，未婚不适用。不得据本轮主体资格核验作其他授信决定。\n申请日期2026-09-05。甲出生于1991-08-20。身份证解析文本A、户籍本人页B、申请表C均写姓名甲、证件引用DEMO-ID-001；B、C均记载未婚。未提供结婚证。仅有解析文本，未提供原始图片。',
    evaluationGoal: '年龄35岁；三份材料主体一致；未婚结婚证不适用不算缺件；不声称图片验真、仅凭年龄证明全部民事行为能力或完成贷款审批。逐条可采用而非扩大补件。' },
  { caseId: 'AUDIT-COMPARE-003', key: 'rules', name: '制度转换为可消费的规则草案',
    prompt: shared + '把以下模拟制度转换为下游可用的审核规则JSON草案，不要做客户审核。每项使用审核要点、审核规则、所需凭证、引用法规四个字段，引用法规字段请原样引用本题模拟制度名称与条号，不引入外部法律。\n《演示个人贷款审核细则v1》第一条：申请日年龄18至65岁，以身份证出生日期和申请表日期计算。第二条：收入证明、流水应覆盖相同近6个月；税前税后口径不同先查工资明细，不直接按差额认定异常。第三条：只对已婚申请人核对婚姻证明，未婚不适用。第四条：制度未设置收入差额风险阈值，不得自行添加。\n提供凭证类型：身份证、贷款申请表、收入证明、银行流水、工资明细、婚姻证明。无需新增其他凭证。请输出可解析JSON，明确第三条的适用条件，结果为规则草案并保留制度版本。',
    evaluationGoal: 'JSON可解析且四字段完整；18-65、同6个月、先调口径、已婚条件逐条绑定给定制度；不额外增加默认材料、50%阈值或外部法律；草案而非已发布规则。' },
].map(value => ({ ...value, prompt: value.prompt, requiredTools: [], rubric: [] }));
const runtime = JSON.parse(await readFile('.runtime.local.json', 'utf8'));
const catalog = {defaultModelId:runtime.defaultModelId,models:Object.entries(runtime.models??{}).map(([modelId,value])=>({providerId:value.providerId??'runtime-launcher',modelId,upstreamModelId:value.upstreamModelId??modelId,parameters:{}}))};
const chosen = catalog.models.find(model => model.modelId === (process.env.AUDIT_COMPARISON_MODEL ?? 'glm-5.3-flash'));
if (!chosen) throw new Error('Default comparison model not configured');
const model = { providerId: chosen.providerId, modelId: chosen.modelId, parameters: {} };
const profile = parseYaml(await readFile('packs/finance/smart-audit-assistant-online/profiles/judge.yaml', 'utf8'));
profile.domainInstructions += '\n本批题面为完整模拟制度和已解析材料，不要求外部工具；评价文字任务的专业表现，不奖励无谓拒答、额外材料索取或模板长度，不把局部审核结论等同授信审批。';
profile.domainInstructions += '\n匿名化会省略包内 read_file 工具记录。不能根据匿名工具列表为空推断未读取 Skill 或模板，也不能据此指控虚构读取。正文中的读取旁白仍可按冗余评价；Runtime 可能串接中间文本，JSON整体解析失败属于交付问题，不单独据此推断 Skill 原因。';
const judge = new ModelPairwiseJudge(new CodexCliModelAdapter({ cwd: out, timeoutMs: 240000 }),
  { providerId: 'codex-host', modelId: 'gpt-6-astra', parameters: {} });
const manifest = { schemaVersion: 'finance.skill-eval.audit-comparison.v1', createdAt: new Date().toISOString(),
  executionMode: 'live-openjiuwen', dataMode: 'synthetic-inline-text', requiredMcpCount: 0,
  evidenceBoundary: 'Three matched text tasks, one run each; not OCR, whole-workflow, no-Skill uplift, or production validation.',
  sourceBoundary: 'Right variants are three private uploads in Liu Sida EA instance; no published versions or original authorship claim.',
  model, judgeModel: 'gpt-6-astra', judgeRevision: 'v2-reference-evidence-clarification', judgeProfile: profile, roots,
  assets: Object.fromEntries(Object.entries(skills).map(([key, s]) => [key, { skillId: s.skillId, version: s.version,
    textSnapshotSha256: s.artifactSha256, fileCount: Object.keys(s.files).length }])), cases };
await writeFile(path.join(out, 'comparison-manifest.json'), JSON.stringify(manifest, null, 2));
const results = [];
for (const [index, task] of cases.entries()) {
  const pair = { caseId: task.caseId, name: task.name, executionOrder: index % 2 ? ['right', 'left'] : ['left', 'right'] };
  for (const side of pair.executionOrder) {
    const file = path.join(out, `${task.caseId}-${side}.json`);
    try { pair[side] = JSON.parse(await readFile(file, 'utf8')); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const skill = side === 'left' ? skills.current : skills[task.key];
      const body = { schemaVersion: 'finance.skill-eval.runtime-request.v1', runId: 'audit-comparison-2026-09-05',
        side, model, case: { caseId: task.caseId, prompt: task.prompt, requiredTools: [] },
        variant: { mode: 'skill_version', skillId: skill.skillId, version: skill.version, artifactSha256: skill.artifactSha256 },
        skill, environment: { mcpServers: [] } };
      console.log(JSON.stringify({ caseId: task.caseId, side, status: 'started' }));
      const response = await fetch('http://127.0.0.1:56362/execute', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body), signal: AbortSignal.timeout(320000) });
      const raw = await response.text();
      if (!response.ok) throw new Error(`Runtime HTTP ${response.status}`);
      for (const line of raw.split('\n')) if (line.startsWith('data: ')) {
        const item = JSON.parse(line.slice(6));
        if (item.evidence) pair[side] = item.evidence;
      }
      if (!pair[side]) throw new Error('Missing terminal evidence');
      await writeFile(file, JSON.stringify(pair[side], null, 2), { mode: 0o600 });
    }
    console.log(JSON.stringify({ caseId: task.caseId, side, status: pair[side].status, elapsedMs: pair[side].elapsedMs,
      chars: pair[side].output.length, referenceFiles: Object.keys(pair[side].metadata.referenceFilesRead ?? {}) }));
  }
  const verdictFile = path.join(out, `${task.caseId}-judge-v2.json`);
  if (pair.left.status === 'completed' && pair.right.status === 'completed') {
    try { pair.judge = JSON.parse(await readFile(verdictFile, 'utf8')); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      pair.judge = await judge.compare({ evalCase: task, left: pair.left, right: pair.right, profile });
      await writeFile(verdictFile, JSON.stringify(pair.judge, null, 2));
    }
    console.log(JSON.stringify({ caseId: task.caseId, judge: pair.judge }));
  } else { pair.judge = null; console.log(JSON.stringify({ caseId: task.caseId, status: 'execution-failed-not-scored' })); }
  results.push(pair);
  await writeFile(path.join(out, 'results.json'), JSON.stringify({ manifest: 'comparison-manifest.json', results }, null, 2), { mode: 0o600 });
}
console.log(JSON.stringify({ reportDirectory: out, compared: results.length }));
