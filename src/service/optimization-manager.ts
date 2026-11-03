import { randomUUID } from "node:crypto";
import {comparisonExecutionIncomplete} from '../evaluation/application/comparison-executions.js';
import path from "node:path";
import { zipSync, strToU8 } from "fflate";
import { parse, stringify } from "yaml";
import { createSkillEditor } from "../agents/tool-free-roles.js";
import {configuredImprovementAgents} from './improvement-agents.js';
import {runOptimizationLoop} from '../improvement/application/optimization-loop.js';
import {effectReviewInput} from '../improvement/application/review-input.js';
import {optimizationGoalSchema,type CandidateRef,type OptimizationEvaluation,type OptimizationLoop} from '../improvement/domain/optimization-loop.js';
import type {ImprovementAgents} from '../improvement/application/improvement-agents.js';
import type {EvaluationJob} from '../shared/contracts/evaluation-job.js';
import type {ImprovementJudgement} from '../improvement/domain/diagnosis.js';
import {KeyedQueue} from '../shared/keyed-queue.js';
import { configuredModelRole } from "./config.js";
import { ensureDirectory, listJsonFiles, readJson, writeJsonAtomic } from "./file-store.js";
import type { EvaluationJobStore } from "./job-store.js";
import type { EvaluationRunManager } from "./run-manager.js";
import type { SkillStore, SkillAssetRecord } from "./skill-store.js";
import type { EvalPackCatalog } from "./catalog.js";
import { fingerprint } from '../contracts.js';
import type { RunConfiguration } from './contracts.js';
import type { PreparationStore } from './preparation-store.js';
import type { Optimization } from '../shared/contracts/optimization.js';
export type { Optimization } from '../shared/contracts/optimization.js';

export function optimizationRerunBindings(configuration:RunConfiguration, original:SkillAssetRecord, candidate:SkillAssetRecord) {
  if (!configuration.runtimeBindings) return {};
  const environmentId=configuration.runtimeBindings.right.environmentId;
  const runtime={type:'runtime_launcher' as const,environmentId};
  return {runtime,runtimeBindings:{
    left:{environmentId,skillAssetId:original.assetId},right:{environmentId,skillAssetId:candidate.assetId}}};
}

export function candidateFiles(files: Record<string, string>, changes: Array<{ path: string; content: string }>, version: string): Record<string, string> {
  const next = { ...files };
  const seen = new Set<string>();
  for (const change of changes) {
    if (!(change.path === "SKILL.md" || /^references\/[a-zA-Z0-9_/-]+\.md$/u.test(change.path)) || change.path.includes("..") || seen.has(change.path)) {
      throw new Error("候选只能修改 SKILL.md 与 references 下的 Markdown");
    }
    seen.add(change.path); next[change.path] = change.content;
  }
  const match = next["SKILL.md"]?.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/u);
  if (!match) throw new Error("候选需要合法的 Skill frontmatter");
  const original = files["SKILL.md"]?.match(/^---\s*\n([\s\S]*?)\n---/u);
  const identity = original ? parse(original[1]!) : null;
  const metadata = parse(match[1]!);
  if (!identity?.name || metadata?.name !== identity.name) throw new Error("优化器不能改变 Skill 身份");
  next["SKILL.md"] = `---\n${stringify({ ...metadata, name: identity.name, version })}---\n\n${match[2]}`;
  if (Object.values(next).reduce((sum, text) => sum + Buffer.byteLength(text), 0) > 240000) throw new Error("候选包超出文本大小上限");
  return next;
}

export class OptimizationManager {
  private readonly directory: string;
  private readonly active = new Map<string, AbortController>();
  private readonly pending=new Map<string,Promise<void>>();
  private readonly reservations=new KeyedQueue();
  private closing=false;
  private launch(id:string,work:()=>Promise<void>){
    const pending=work().finally(()=>{this.active.delete(id);this.pending.delete(id);});
    this.pending.set(id,pending);void pending.catch(()=>{});
  }
  async close(){this.closing=true;for(const controller of this.active.values())controller.abort(new Error('服务正在关闭'));await Promise.allSettled(this.pending.values());}
  constructor(private readonly options: { dataDirectory: string; skills: SkillStore; jobs: EvaluationJobStore; runs: EvaluationRunManager; catalog: EvalPackCatalog; preparations?:PreparationStore; improvementAgents?:()=>ImprovementAgents; runtimeIdentity?:(configuration:RunConfiguration)=>Promise<unknown> }) {
    this.directory = path.join(options.dataDirectory, "optimizations");
  }
  private async suite(configuration:RunConfiguration) {
    if (configuration.packId) return this.options.catalog.get(configuration.packId);
    const preparation=configuration.preparationId ? await this.options.preparations?.get(configuration.preparationId):null;
    if (!preparation) return null;
    return this.options.preparations!.buildPack({preparation,analyzerModel:configuredModelRole('ANALYZER').model,
      executionModel:configuration.executionModel??configuredModelRole('EXECUTION').model,judgeModel:configuredModelRole('JUDGE').model});
  }
  async get(id: string): Promise<Optimization> {
    if (!/^opt-[a-f0-9-]+$/u.test(id)) throw new Error("优化记录 ID 不合法");
    // A live task can finish while readJson is reading an older atomic snapshot.
    const wasActive = this.active.has(id);
    const item = await readJson<Optimization>(path.join(this.directory, `${id}.json`));
    if (!wasActive && ["diagnosing", "validating", "reevaluating", "reviewing", "final_verifying"].includes(item.status) && !this.active.has(id)) {
      if(item.loop?.status==='RUNNING'){item.loop.status='INTERRUPTED';item.loop.reason='服务重启，候选未采纳';}
      item.status = "failed"; item.error = "Service restarted; candidate was not adopted"; await this.save(item);
    }
    return item;
  }
  async forSource(sourceJobId: string): Promise<Optimization | null> {
    const items: Optimization[] = [];
    for (const file of await listJsonFiles(this.directory)) {
      const item = await readJson<Optimization>(file);
      if (item.sourceJobId === sourceJobId) items.push(item);
    }
    const latest = items.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    return latest ? this.get(latest.optimizationId) : null;
  }
  private async save(item: Optimization) {
    item.updatedAt = new Date().toISOString();
    await ensureDirectory(this.directory);
    await writeJsonAtomic(path.join(this.directory, `${item.optimizationId}.json`), item);
  }
  private async stage(item: Optimization, status: Optimization["status"]) {
    item.status = status; item.stages.push({ stage: status, at: new Date().toISOString() }); await this.save(item);
  }
  async propose(sourceJobId:string,constraints?:string):Promise<Optimization>{return this.create(sourceJobId,true,constraints);}
  create(sourceJobId:string,proposalOnly=false,constraints?:string,goalInput:unknown={}):Promise<Optimization>{
    return this.reservations.run('create',()=>this.createInternal(sourceJobId,proposalOnly,constraints,goalInput));
  }
  private async createInternal(sourceJobId: string,proposalOnly=false,constraints?:string,goalInput:unknown={}): Promise<Optimization> {
    if(this.closing)throw new Error('服务正在关闭');
    if (this.active.size) throw new Error("已有一轮 Skill 优化正在进行");
    const source = this.options.jobs.get(sourceJobId);
    const goal=optimizationGoalSchema.parse(goalInput);
    if(source?.configuration.includeHoldout)throw new Error('留出集结果不能作为优化依据');
    if (!source?.report || source.status !== "completed" || source.configuration.runtime.type!=='runtime_launcher') throw new Error("请先使用 Runtime Launcher 完成一轮在线评测");
    if (!source.report.cases.length) throw new Error('评测没有实际执行案例，不启动优化');
    if (source.report.cases.some(c => c.left.status !== "completed" || c.right.status !== "completed" || !c.judge)) throw new Error("运行或阅卷不完整，应修复环境后重测，不能据此修改 Skill");
    if (source.report.cases.some(c => [...c.left.toolCalls, ...c.right.toolCalls].some(t => t.status === "failed")
      && !(proposalOnly && source.configuration.evaluationMode==='candidate_assessment'
        && !c.judgeError && c.judge?.goalAssessment?.verdict==='PASS'))) {
      throw new Error("存在未通过验收的工具失败，应先排查运行证据，不能将运行故障当作 Skill 缺陷");
    }
    const variant = source.report.variants.right;
    if (variant.mode !== "skill_version") throw new Error("右侧必须为已装配 Skill");
    const assets = await this.options.skills.list();
    const binding=source.configuration.runtimeBindings;
    if (binding && binding.left.environmentId!==binding.right.environmentId) throw new Error('跨执行栈差异不能直接归因于 Skill；请先在同一 Runtime 完成候选评测再优化');
    const asset = assets.find(a => (!binding || a.assetId===binding.right.skillAssetId) && a.skillId === variant.skillId && a.version === variant.version && (!variant.artifactSha256 || a.artifactSha256 === variant.artifactSha256));
    if (!asset) throw new Error("原始 Skill 文件不可用");
    await this.options.skills.readArchive(asset.assetId);
    const models = source.report.models.execution;
    const modelFingerprint=(model:typeof models.left)=>fingerprint({providerId:model.providerId,modelId:model.modelId,parameters:model.parameters??{}});
    if (modelFingerprint(models.left)!==modelFingerprint(models.right)) throw new Error("请先用相同执行模型及参数评测，再判断 Skill 增益");
    const pack = await this.suite(source.configuration);
    if (!pack?.holdoutCases?.length) throw new Error("此试卷尚未配置冻结留出题，不启动候选复测");
    const optimizer = configuredModelRole("OPTIMIZER");
    if (!optimizer.adapter) throw new Error("优化模型未配置");
    const agents=proposalOnly?undefined:(this.options.improvementAgents??configuredImprovementAgents)();
    if(!proposalOnly){
      for(const file of await listJsonFiles(this.directory)){
        const previous=await readJson<Optimization>(file);
        if(previous.holdoutJobId&&previous.holdoutFingerprint===fingerprint(pack.holdoutCases))throw new Error('这份留出集已用于最终复核，请准备新的独立留出集');
      }
    }
    const now = new Date().toISOString();
    const item: Optimization = { optimizationId: `opt-${randomUUID()}`, sourceJobId, sourceAssetId: asset.assetId, createdAt: now, updatedAt: now,
      status: "diagnosing", modelId: optimizer.model.modelId, summary: "", findings: [], changes: [], candidate: null, rerunJobId: null, error: null, stages: [{ stage: "diagnosing", at: now }],...(proposalOnly?{proposalOnly:true}:{}) };
    if(constraints)item.constraints=constraints;
    if(!proposalOnly){item.goal=goal;item.evaluationFingerprint=await this.protocolFingerprint(source,pack);item.holdoutFingerprint=fingerprint(pack.holdoutCases);}
    if(this.closing)throw new Error('服务正在关闭');
    const controller = new AbortController(); this.active.set(item.optimizationId, controller);
    try{await this.save(item);}catch(error){this.active.delete(item.optimizationId);throw error;}
    this.launch(item.optimizationId,()=>this.run(item,controller,agents));
    return item;
  }
  reevaluate(id:string):Promise<Optimization>{return this.reservations.run('create',()=>this.reevaluateInternal(id));}
  private async reevaluateInternal(id: string): Promise<Optimization> {
    if(this.closing)throw new Error('服务正在关闭');
    if (this.active.size) throw new Error("已有一轮 Skill 优化正在进行");
    const item = await this.get(id);
    if(this.closing)throw new Error('服务正在关闭');
    if(item.proposalOnly)throw new Error('此候选由持续改进任务管理，请在该任务中查看复测结果');
    if (!["review", "failed"].includes(item.status) || !item.candidate || item.holdoutJobId) throw new Error("最终留出集复核开始后不能继续用同一留出集迭代候选");
    if (item.rerunJobId) item.previousRerunJobIds = [...(item.previousRerunJobIds ?? []), item.rerunJobId];
    item.rerunJobId = null; item.error = null;
    if(item.loop){item.reviewJobId=undefined;item.effectReview=undefined;}
    const controller = new AbortController(); this.active.set(id, controller);
    await this.stage(item, "reevaluating");
    this.launch(id,()=>this.evaluate(item, controller, false, !!item.loop).then(()=>this.refreshReview(item,controller)).catch(async error => {
      if (item.rerunJobId && controller.signal.aborted) await this.options.runs.cancel(item.rerunJobId);
      item.error = error instanceof Error ? error.message : String(error);
      await this.stage(item, controller.signal.aborted ? "cancelled" : "failed");
    }));
    return item;
  }
  finalVerify(id:string):Promise<Optimization>{return this.reservations.run('create',()=>this.finalVerifyInternal(id));}
  private async finalVerifyInternal(id:string):Promise<Optimization> {
    if(this.closing)throw new Error('服务正在关闭');
    if (this.active.size) throw new Error('已有一轮 Skill 优化正在进行');
    const item=await this.get(id);
    if(this.closing)throw new Error('服务正在关闭');
    if(item.proposalOnly)throw new Error('此候选由持续改进任务管理，不能单独解封留出题');
    if(item.status!=='review'||!item.candidate||item.holdoutJobId) throw new Error('请先完成开发集复测；留出集只能对当前候选复核一次');
    if(item.loop&&(item.reviewJobId!==item.rerunJobId||item.effectReview?.status!=='PRODUCED'||item.effectReview.review.recommendation!=='KEEP_CANDIDATE'))throw new Error('当前候选还没有通过独立效果审查');
    const controller=new AbortController();this.active.set(id,controller);
    item.error=null;
    await this.stage(item,'final_verifying');
    this.launch(id,()=>this.evaluate(item,controller,true).catch(async error=>{
      if(item.holdoutJobId&&controller.signal.aborted) await this.options.runs.cancel(item.holdoutJobId);
      item.error=error instanceof Error?error.message:String(error);
      await this.stage(item,controller.signal.aborted?'cancelled':'failed');
    }));
    return item;
  }
  private async run(item: Optimization, controller: AbortController,agents?:ImprovementAgents) {
    try {
      if(item.proposalOnly){await this.edit(item,controller,item.sourceJobId,item.sourceAssetId);await this.stage(item,item.candidate?'review':'retained');}
      else await this.optimize(item,controller,agents!);
    } catch (error) {
      if (item.rerunJobId && controller.signal.aborted) await this.options.runs.cancel(item.rerunJobId);
      item.error = error instanceof Error ? error.message : String(error);
      await this.stage(item, controller.signal.aborted ? "cancelled" : "failed");
    }
  }
  private async edit(item:Optimization,controller:Pick<AbortController,'signal'>,sourceJobId:string,assetId:string,diagnosis?:ImprovementJudgement,
    onComposition?:import('../agents/ports.js').RoleCallOptions['onComposition']){
      const source = this.options.jobs.get(sourceJobId)!;
      const files = await this.options.skills.readFiles(assetId);
      const sourceAsset=(await this.options.skills.get(assetId))!;
      const archive=await this.options.skills.readArchive(assetId);
      const basename=path.posix.basename(sourceAsset.skillFile);
      if (basename!=='SKILL.md') {files['SKILL.md']=files[basename]!;delete files[basename];}
      const optimizer = configuredModelRole("OPTIMIZER");
      const developmentIds = new Set((source.questionSet?.cases ?? (await this.suite(source.configuration))!.cases).map(c => c.caseId));
      const editor = createSkillEditor({ adapter: optimizer.adapter!, model: optimizer.model });
      const edited = await editor({ constraints: [item.constraints,diagnosis?JSON.stringify(diagnosis):''].filter(Boolean).join('\n'), files,
        developmentEvidence: source.report!.cases.filter(c => developmentIds.has(c.caseId)).map(c => ({
          task: c.prompt, answer: c.right.output, review: c.judge?.summary, dimensions: c.judge?.dimensions, goalAssessment: c.judge?.goalAssessment,
        })) }, { requestId: item.optimizationId, signal: controller.signal,
          version: process.env.FINANCE_EVAL_AGENT_ROLE_VERSION?.trim() || 'v1',
          onComposition: async receipt => { item.agentComposition = receipt; await this.save(item);await onComposition?.(receipt); } });
      controller.signal.throwIfAborted();
      if (edited.status === 'ABSTAINED') {
        item.summary = edited.reason; item.abstainedReason = edited.reason;
        item.candidate=null;
        return;
      }
      const proposal = edited.proposal;
      if(proposal.changes.every(c=>files[c.path]===c.content)){item.abstainedReason='候选没有有效变化';item.candidate=null;return;}
      item.summary = proposal.summary; item.findings = proposal.findings;
      await this.stage(item, "validating");
      const version = `${sourceAsset.version}-candidate.${randomUUID().slice(0,8)}`;
      const next = candidateFiles(files, proposal.changes, version);
      item.changes = proposal.changes.map(c => ({ path: c.path, before: files[c.path] ?? "", after: next[c.path]!, reason: c.reason }));
      const root=path.posix.dirname(sourceAsset.skillFile);
      for (const [name,content] of Object.entries(next)) {
        const actual=name==='SKILL.md'?sourceAsset.skillFile:path.posix.join(root,name);
        archive[actual]=strToU8(content);
      }
      item.candidate = await this.options.skills.uploadZip(Buffer.from(zipSync(archive)));
      controller.signal.throwIfAborted();
  }
  private async protocolFingerprint(source:EvaluationJob,pack:unknown){
    return fingerprint({pack,questions:source.questionSet,configuration:source.configuration,judge:configuredModelRole('JUDGE').model,
      runtime:await this.options.runtimeIdentity?.(source.configuration)});
  }
  private evaluationView(job:EvaluationJob,candidate:CandidateRef,ids:string[],protocolDigest:string):OptimizationEvaluation{
    const repetitions=job.configuration.executionRepetitions??1;
    if(repetitions>1){
      const attempts=Array.from({length:repetitions},(_,index)=>{
        const attempt=job.executionAttempts?.find(a=>a.index===index);
        return attempt?.status==='COMPLETED'&&attempt.report&&!comparisonExecutionIncomplete(attempt.report)?this.evaluationView({...job,configuration:{...job.configuration,executionRepetitions:1},report:attempt.report},candidate,ids,protocolDigest):undefined;
      });
      return {id:job.jobId,candidate,protocolDigest,cases:ids.map(id=>{
        const results=attempts.map(a=>a?.cases.find(c=>c.id===id));
        return {id,passed:results.some(c=>c?.passed==null)?null:results.every(c=>c?.passed===true),observation:results.map(c=>c?.observation??null)};
      })};
    }
    const variant=job.report?.variants.right;
    const selected=job.report?.cases.filter(c=>ids.includes(c.caseId))??[];
    const unique=new Set(selected.map(c=>c.caseId)).size===selected.length;
    return {id:job.jobId,candidate,protocolDigest,cases:ids.map(id=>{
      const c=job.report?.cases.find(c=>c.caseId===id),verdict=c?.judge?.goalAssessment?.verdict??c?.judge?.serviceComparison?.verdict;
      const artifactVerified=variant?.mode==='skill_version'&&(variant.artifactSha256===candidate.digest||c?.right.metadata?.skillArtifactSha256===candidate.digest);
      const complete=unique&&artifactVerified&&c?.right.status==='completed'&&c.right.runtimeIdentityVerified&&c.right.streamCompleted&&c.judge&&!c.judgeError;
      let passed=!complete?null:verdict?verdict==='INDETERMINATE'?null:verdict==='PASS':c.judge!.dimensions.length?
        c.judge!.dimensions.every(d=>Number.isFinite(d.rightScore)&&d.rightScore>=3):null;
      const required=job.evaluationSpec?.cases.find(item=>item.caseId===id)?.evaluationPlan?.checks.filter(check=>check.required)??[];
      for(const check of required){
        const result=c?.methodResults?.right.find(method=>method.methodId==='plan:'+check.id);
        if(!result||!['PASS','FAIL'].includes(result.status)||result.checks.some(item=>item.status==='UNVERIFIED')){passed=null;break;}
        if(result.status==='FAIL')passed=false;
      }
      return {id,passed,observation:c};
    })};
  }
  private async optimize(item:Optimization,controller:AbortController,agents:ImprovementAgents){
    const source=this.options.jobs.get(item.sourceJobId)!,pack=(await this.suite(source.configuration))!;
    const allowed=new Set((source.questionSet?.cases??pack.cases).map(c=>c.caseId));
    const ids=source.report!.cases.filter(c=>allowed.has(c.caseId)).map(c=>c.caseId);
    const asset=(await this.options.skills.get(item.sourceAssetId))!,baseline={id:asset.assetId,digest:asset.artifactSha256};
    const goal=item.goal!,now=Date.now();
    const state:OptimizationLoop={id:item.optimizationId,goal,baseline,best:baseline,bestEvaluationId:item.sourceJobId,
      status:'RUNNING',stage:'DIAGNOSIS',rounds:[],createdAt:new Date(now).toISOString(),deadlineAt:new Date(now+goal.maxDurationSeconds*1000).toISOString()};
    const changes=new Map<string,Optimization['changes']>();
    const initial=this.evaluationView(source,baseline,ids,item.evaluationFingerprint!);
    await runOptimizationLoop(state,initial,{
      save:async state=>{item.loop=state;if(state.status==='RUNNING')item.status=({DIAGNOSIS:'diagnosing',ADJUSTMENT:'validating',EVALUATION:'reevaluating',REVIEW:'reviewing',SELECTION:'reviewing'} as const)[state.stage];await this.save(item);},
      diagnose:async(evaluation,history,options)=>{
        const job=this.options.jobs.get(evaluation.id)!,files=await this.options.skills.readFiles(evaluation.candidate.id);
        const result=await agents.diagnose({modelId:item.modelId,sourceJobId:job.jobId,baseSolutionRevisionId:evaluation.candidate.digest,
          tools:[],runtimeConfiguration:[],technicalEvidence:[],
          cases:job.report!.cases.filter(c=>ids.includes(c.caseId)).map(c=>({caseId:c.caseId,task:c.prompt,runtimeStatus:c.right.status,
            runtimeIdentityVerified:c.right.runtimeIdentityVerified,streamCompleted:c.right.streamCompleted,toolTraceStatus:toolTraceStatus(c.right),
            toolCalls:c.right.toolCalls.map(t=>({name:t.name,status:t.status})),review:c.judge?.summary??null,verdict:evaluation.cases.find(r=>r.id===c.caseId)?.passed?'PASS':'FAIL'})),
          codeEvidence:Object.entries(files).map(([path,content])=>({origin:'candidate',path,content})),
          evaluationEvidence:{current:job.report!.cases.filter(c=>ids.includes(c.caseId)),baseline:source.report?.cases.filter(c=>ids.includes(c.caseId))},
          approvedReuseDesign:{goal,constraints:item.constraints},
          previousExperiments:history.map(r=>({layer:r.diagnosis?.status==='PROPOSED'?r.diagnosis.hypothesis.layer:'UNKNOWN',outcome:JSON.stringify({reason:r.reason??r.stage,review:r.review})}))},options);
        if(result.judgement.status==='PROPOSED'&&result.judgement.hypothesis.evidenceCaseIds.some(id=>!ids.includes(id)))throw new Error('诊断引用了开发集之外的案例');
        if(state.rounds.at(-1))state.rounds.at(-1)!.investigation=result.investigation;
        return result.judgement;
      },
      adjust:async(candidate,diagnosis,options)=>{
        if(diagnosis.status!=='PROPOSED'||diagnosis.hypothesis.layer!=='SKILL')return null;
        await this.edit(item,{signal:options.signal!},state.workingEvaluationId??state.bestEvaluationId,candidate.id,diagnosis,options.onComposition);
        if(!item.candidate)return null;
        changes.set(item.candidate.assetId,structuredClone(item.changes));
        return {id:item.candidate.assetId,digest:item.candidate.artifactSha256};
      },
      evaluate:async(candidate,options)=>{
        if(item.rerunJobId)(item.previousRerunJobIds??=[]).push(item.rerunJobId);
        try{await this.evaluate(item,{signal:options.signal!},false,true);}
        catch(error){if(options.signal?.aborted&&item.rerunJobId)await this.options.runs.cancel(item.rerunJobId);throw error;}
        return this.evaluationView(this.options.jobs.get(item.rerunJobId!)!,candidate,ids,item.evaluationFingerprint!);
      },
      review:async(before,after,round,options,incumbent)=>agents.review(effectReviewInput(goal.goal,before,after,
        (changes.get(after.candidate.id)??[]).map(c=>({path:c.path,reason:c.reason,before:c.before,after:c.after})),
        {incumbent,protectedCaseIds:goal.protectedCaseIds,targetPassRate:goal.targetPassRate,remainingRounds:goal.maxRounds-round.number}),options),
    },controller.signal);
    if(state.best.id!==state.baseline.id){
      item.candidate=(await this.options.skills.get(state.best.id))!;item.rerunJobId=state.bestEvaluationId;
      const normalize=async(asset:SkillAssetRecord)=>{
        const files=await this.options.skills.readFiles(asset.assetId),name=path.posix.basename(asset.skillFile);
        if(name!=='SKILL.md'){files['SKILL.md']=files[name]!;delete files[name];}return files;
      };
      const [originalFiles,candidateFiles]=await Promise.all([normalize(asset),normalize(item.candidate)]);
      item.changes=Object.keys(candidateFiles).filter(path=>candidateFiles[path]!==originalFiles[path]).map(path=>({path,before:originalFiles[path]??'',after:candidateFiles[path]!,reason:'已保留轮次的累计调整'}));
      item.effectReview=[...state.rounds].reverse().find(r=>r.candidate?.id===state.best.id&&r.selected)?.review;item.reviewJobId=state.bestEvaluationId;
    }else item.candidate=null;
    item.summary=state.reason??'';
    if(['FAILED','CANCELLED'].includes(state.status)){item.error=state.reason??'优化未完成';await this.stage(item,state.status==='CANCELLED'?'cancelled':'failed');}
    else await this.stage(item,state.status==='REVIEW'?'review':'retained');
  }
  private async refreshReview(item:Optimization,controller:AbortController){
    if(!item.loop||!item.candidate)return;
    item.reviewJobId=undefined;item.effectReview=undefined;
    await this.stage(item,'reviewing');
    const source=this.options.jobs.get(item.sourceJobId)!,current=this.options.jobs.get(item.rerunJobId!)!;
    const pack=(await this.suite(source.configuration))!,allowed=new Set((source.questionSet?.cases??pack.cases).map(c=>c.caseId));
    const ids=source.report!.cases.filter(c=>allowed.has(c.caseId)).map(c=>c.caseId);
    const before=this.evaluationView(source,item.loop.baseline,ids,item.evaluationFingerprint!),after=this.evaluationView(current,{id:item.candidate.assetId,digest:item.candidate.artifactSha256},ids,item.evaluationFingerprint!);
    const {comparableEvaluations,selectOptimizationCandidate}=await import('../improvement/domain/optimization-loop.js');
    if(!comparableEvaluations(before,after))throw new Error('复测未完成或评测条件不可比');
    item.effectReview=await (this.options.improvementAgents??configuredImprovementAgents)().review(effectReviewInput(item.goal!.goal,before,after,item.changes,
      {protectedCaseIds:item.goal!.protectedCaseIds,targetPassRate:item.goal!.targetPassRate,remainingRounds:0}),{requestId:item.optimizationId+'-review',signal:controller.signal});
    const decision=selectOptimizationCandidate(before,after,before,item.effectReview,item.goal!.protectedCaseIds);
    if(item.effectReview.status==='PRODUCED'&&item.effectReview.review.recommendation==='KEEP_CANDIDATE'&&!decision.selected)
      item.effectReview={status:'ABSTAINED',reason:decision.reason};
    item.reviewJobId=item.rerunJobId!;
    await this.stage(item,'review');
  }
  private async evaluate(item: Optimization, controller: Pick<AbortController,'signal'>, final=false,managed=false) {
      const source = this.options.jobs.get(item.sourceJobId)!;
      const pack=await this.suite(source.configuration);
      if(item.evaluationFingerprint&&await this.protocolFingerprint(source,pack)!==item.evaluationFingerprint)throw new Error('试卷、运行配置或 Judge 已变化，不能复用旧评测进行优化');
      const original = await this.options.skills.get(item.sourceAssetId);
      const developmentIds = new Set((source.questionSet?.cases ?? (await this.suite(source.configuration))!.cases).map(c => c.caseId));
      const variant = (a: SkillAssetRecord) => ({ mode: "skill_version", skillId: a.skillId, version: a.version, artifactSha256: a.artifactSha256 });
      const rerun = await this.options.runs.create({ ...source.configuration, caseSource: "fixed", selectedCaseIds: source.questionSet ? [] : source.report!.cases.filter(c => developmentIds.has(c.caseId)).map(c => c.caseId),
        ...optimizationRerunBindings(source.configuration,original!,item.candidate!),
        includeHoldout: final, leftVariant: variant(original!), rightVariant: variant(item.candidate!), skillAssetId: item.candidate!.assetId, judgeMode: "model",evaluationMode:source.configuration.evaluationMode }, source.questionSet);
      if(final)item.holdoutJobId=rerun.jobId;
      else item.rerunJobId = rerun.jobId;
      await this.stage(item, final?'final_verifying':"reevaluating");
      while (true) {
        controller.signal.throwIfAborted();
        const current = this.options.jobs.get(rerun.jobId)!;
        if (["failed", "cancelled", "interrupted"].includes(current.status)) throw new Error(current.error?.message ?? "Candidate evaluation did not complete");
        if (current.status === "completed") {
          if (!current.report?.cases.length || current.report.cases.some(c => !c.judge || c.left.status !== "completed" || c.right.status !== "completed"
              || [...c.left.toolCalls,...c.right.toolCalls].some(t=>t.status==='failed'))) throw new Error("候选复测存在未完成任务或工具失败，不能确认专业增益");
          if(item.evaluationFingerprint&&await this.protocolFingerprint(source,await this.suite(source.configuration))!==item.evaluationFingerprint)throw new Error('评测期间配置发生变化');
          if(fingerprint(current.report.models.execution)!==fingerprint(source.report!.models.execution))throw new Error('复测执行模型与基线不一致');
          if(final){
            const ids=pack!.holdoutCases!.map(c=>c.caseId),view=this.evaluationView(current,{id:item.candidate!.assetId,digest:item.candidate!.artifactSha256},ids,item.evaluationFingerprint??'legacy');
            if(view.cases.some(c=>c.passed!==true))throw new Error('留出集未全部达标，不能采纳候选');
          }
          break;
        }
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      if(final)item.holdoutVerified=true;
      if(!managed)await this.stage(item, "review");
  }
  decide(id:string,decision:'adopt'|'retain'|'cancel'){return this.reservations.run('create',()=>this.decideInternal(id,decision));}
  private async decideInternal(id: string, decision: "adopt" | "retain" | "cancel") {
    const item = await this.get(id);
    if (decision === "cancel") { this.active.get(id)?.abort(); return item; }
    if(this.active.has(id))throw new Error('优化仍在执行，请等待或取消');
    if (item.status !== "review") throw new Error("候选尚未完成复测");
    if (decision==='adopt'&&!item.holdoutVerified) throw new Error('请先完成独立留出集复核，再决定采纳候选');
    if(decision==='adopt'&&item.loop&&(item.reviewJobId!==item.rerunJobId||item.effectReview?.status!=='PRODUCED'||item.effectReview.review.recommendation!=='KEEP_CANDIDATE'))throw new Error('当前候选未通过独立效果审查');
    if(decision==='adopt'&&item.evaluationFingerprint){
      const source=this.options.jobs.get(item.sourceJobId)!;
      if(await this.protocolFingerprint(source,await this.suite(source.configuration))!==item.evaluationFingerprint)throw new Error('评测条件已经变化，不能沿用旧审查采纳候选');
    }
    await this.stage(item, decision === "adopt" ? "adopted" : "retained");
    // Adoption records a local decision only; originals and deployed Skills are immutable.
    return item;
  }
}
import {toolTraceStatus} from '../evaluation/domain/runtime-process.js';
