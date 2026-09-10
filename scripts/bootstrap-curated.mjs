import { readFile, writeFile, readdir, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { zipSync, strToU8 } from 'fflate';
import { parse, stringify } from 'yaml';
import { SkillStore } from '../dist/service/skill-store.js';
const root = process.argv[2] || '/home/ubuntu';
const store = new SkillStore(path.resolve('data')); await store.initialize();
const specs = JSON.parse(await readFile('packs/finance/curated-online.json', 'utf8')).filter(s => !process.argv[3] || s.skillId === process.argv[3]);
if (!specs.length) throw new Error('Unknown curated Skill');
const base = parse(await readFile('packs/finance/wealth-online/eval.yaml','utf8'));
const profile = parse(await readFile('packs/finance/wealth-online/profiles/wealth-manager-judge.yaml','utf8'));
const dimensions = profile.dimensions;
for (const spec of specs) {
  const directory = path.join(root, spec.source), archive = {};
  for (const file of await readdir(directory, {recursive:true})) if (file.endsWith('.md')) archive[file] = strToU8(await readFile(path.join(directory,file),'utf8'));
  const asset = await store.uploadZip(Buffer.from(zipSync(archive)));
  if (asset.skillId !== spec.skillId || (spec.version && asset.version !== spec.version)) throw new Error(`Skill identity/version mismatch: ${spec.skillId}`);
  const target = `packs/finance/${spec.skillId}-online`;
  const previousPack = await readFile(`${target}/eval.yaml`, 'utf8').then(parse).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  await mkdir(`${target}/cases`,{recursive:true}); await mkdir(`${target}/profiles`,{recursive:true});
  await writeFile(`${target}/profiles/judge.yaml`, stringify({...profile,profileId:`${spec.domain}-quality-v1`,reviewerLabel:'AI 金融岗位专业评阅',domainInstructions:spec.instructions,
    dimensions:dimensions.map(d => ({...d,description:({professional_fit:'专业判断是否由实际证据推导，而非标签复述。', business_completeness:'是否覆盖关键事实、业务约束、缺口及取舍。',clarity:'核心判断、依据和不确定性是否清晰自然。',actionability:'是否能支持真实工作决策，且有明确下一步。'})[d.id]}))}));
  const files=[];
  for (const [index,c] of spec.cases.entries()) {
    const file=`cases/${index+1}.yaml`; files.push(file);
    await writeFile(`${target}/${file}`,stringify({caseId:`${spec.domain.toUpperCase()}-${String(index+1).padStart(3,'0')}`,name:c.name,taskMode:'single_turn',prompt:c.prompt,evaluationGoal:c.goal,requiredTools:c.tools,
      rubric:dimensions.map(d=>({criterionId:`${spec.domain}-${d.id}`,label:d.label,description:`${c.goal}；${({professional_fit:'重点看证据推理',business_completeness:'重点看决策条件完整性',clarity:'重点看业务语言与清晰度',actionability:'重点看可执行下一步'})[d.id]}`,dimension:d.id,weight:1,required:true}))}));
  }
  const holdout = spec.holdout === false ? [] : files.slice(-1);
  await writeFile(`${target}/eval.yaml`,stringify({...base,packId:`${spec.skillId}-online-v1`,domain:spec.domain,targetSkillId:asset.skillId,targetSkillVersion:asset.version,description:spec.description ?? `真实模型与只读工具执行；${spec.domain} 模拟业务数据，非生产验收。`,
    variants:{left:{mode:'without_target_skill',skillId:asset.skillId},right:{mode:'skill_version',skillId:asset.skillId,version:asset.version,artifactSha256:asset.artifactSha256}},judgeProfileFile:'profiles/judge.yaml',caseFiles:holdout.length ? files.slice(0,-1) : files,holdoutCaseFiles:holdout,metadata:{...(previousPack?.metadata?.generationContext ? {generationContext:previousPack.metadata.generationContext} : {}),dataMode:'synthetic-snapshot',snapshotVersion:'roles-demo-v1',sourceSkill:spec.source,sourceAuthor:spec.author ?? '',evidenceSemantics:'live-model-synthetic-business-data'}}));
  console.log(`${asset.skillId}@${asset.version}: ${files.length-holdout.length} development + ${holdout.length} holdout`);
}
if (!specs.some(s => s.cases.some(c => c.tools.length))) process.exit(0);
const config=JSON.parse(await readFile('.runtime.local.json','utf8'));
const fixture=JSON.parse(await readFile('integrations/openjiuwen/role-fixtures.json','utf8'));
const endpoint='http://127.0.0.1:56363/mcp';
config.mcp[endpoint].toolNames=[...new Set([...config.mcp[endpoint].toolNames,...Object.keys(fixture.tools)])];
await writeFile('.runtime.local.json',JSON.stringify(config,null,2),{mode:0o600});
for (const file of await readdir('data/environments')) {
  const location=`data/environments/${file}`, record=JSON.parse(await readFile(location,'utf8'));
  if(record.endpoint===endpoint) { record.name='金融岗位业务快照 MCP · 模拟数据 v1'; await writeFile(location,JSON.stringify(record,null,2)); }
}
console.log(`MCP allowlist: ${config.mcp[endpoint].toolNames.length} tools; selected per case.`);
