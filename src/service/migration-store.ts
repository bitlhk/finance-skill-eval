import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';
import { zipSync, strToU8 } from 'fflate';
import { fingerprint, type EvalPack } from '../contracts.js';
import { listJsonFiles, readJson, writeJsonAtomic } from './file-store.js';
import type { SkillStore, SkillAssetRecord } from './skill-store.js';
import type { EvaluationRunManager } from './run-manager.js';
import type { EvaluationJobStore } from './job-store.js';
import type { EvalPackCatalog } from './catalog.js';
import { runConfigurationSchema } from './contracts.js';

const createSchema = z.strictObject({sourceAssetId:z.string().min(1), name:z.string().min(1).max(120)});
const candidateSchema = z.strictObject({assetId:z.string().min(1), notes:z.string().min(1).max(8000)});
const draftSchema = z.strictObject({
  source:z.string().min(1).max(128000), notes:z.string().min(1).max(8000),
  baseAssetId:z.string().min(1),
});
const planSchema = z.strictObject({
  pair:z.enum(['AB','BC','AC']), configuration:runConfigurationSchema,
  dataSnapshot:z.string().min(1).max(300), permissionBasis:z.string().min(1).max(1000),
  sourceProjectRef:z.string().min(1).max(1000), dependencyLockRef:z.string().min(1).max(1000),
});
type Migration = {
  schemaVersion:'finance.skill-migration.v0.1'; id:string; name:string; createdAt:string;
  source:SkillAssetRecord; candidate:SkillAssetRecord|null; candidateNotes:string;
  candidateHistory?:Array<{asset:SkillAssetRecord;notes:string;recordedAt:string}>;
  runs:Array<{jobId:string; pair:'AB'|'BC'|'AC'; candidateDigest:string; comparisonFingerprint:string; packFingerprint:string;
    declaredPlan?:z.infer<typeof planSchema>;suiteSnapshot?:EvalPack}>;
  assessment:'NOT_VALIDATED';
};
const conflict = (message:string):never => {throw Object.assign(new Error(message),{statusCode:409});};

/** Separate migration snapshots from optimization jobs. No uploaded code is executed here. */
export class MigrationStore {
  private chain:Promise<unknown> = Promise.resolve();
  constructor(private root:string, private skills:SkillStore, private runs:EvaluationRunManager,
    private jobs:EvaluationJobStore, private catalog:EvalPackCatalog) {}
  private file(id:string) {
    if (!/^migration-[a-f0-9-]+$/.test(id)) throw Object.assign(new Error('Invalid migration id'),{statusCode:400});
    return path.join(this.root,'migrations',id+'.json');
  }
  private serial<T>(fn:()=>Promise<T>):Promise<T> {
    const p=this.chain.then(fn); this.chain=p.catch(()=>{}); return p;
  }
  async list() {return Promise.all((await listJsonFiles(path.join(this.root,'migrations'))).map(f=>readJson<Migration>(f)));}
  async get(id:string):Promise<Migration> {return readJson<Migration>(this.file(id));}
  async create(input:unknown) {
    const p=createSchema.parse(input), source=await this.skills.get(p.sourceAssetId);
    if (!source) return conflict('Source Skill unavailable');
    const value:Migration={schemaVersion:'finance.skill-migration.v0.1',id:'migration-'+randomUUID(),name:p.name,
      createdAt:new Date().toISOString(),source,candidate:null,candidateNotes:'',runs:[],assessment:'NOT_VALIDATED'};
    await writeJsonAtomic(this.file(value.id),value); return value;
  }
  async candidate(id:string,input:unknown) {return this.serial(async()=>{
    const p=candidateSchema.parse(input), value=await this.get(id), candidate=await this.skills.get(p.assetId);
    if (!candidate || candidate.artifactSha256===value.source.artifactSha256) return conflict('Import a separate versioned candidate; source remains immutable');
    if (candidate.version===value.source.version) return conflict('Candidate must use a new version');
    value.candidate=candidate; value.candidateNotes=p.notes;
    (value.candidateHistory??=[]).push({asset:candidate,notes:p.notes,recordedAt:new Date().toISOString()});
    await writeJsonAtomic(this.file(id),value); return value;
  });}
  async draft(id:string,input:unknown) {return this.serial(async()=>{
    const p=draftSchema.parse(input), value=await this.get(id), base=value.candidate??value.source;
    if (p.baseAssetId!==base.assetId) return conflict('Candidate changed; reload before editing');
    const files=await this.skills.readArchive(base.assetId);
    files[base.skillFile]=strToU8(p.source);
    const candidate=await this.skills.uploadZip(Buffer.from(zipSync(files)));
    if (candidate.version==='0.0.0-upload' || candidate.version===base.version || candidate.version===value.source.version)
      return conflict('Set an explicit new version in Skill metadata before saving');
    if (candidate.skillId!==base.skillId) return conflict('Method edits cannot silently change the Skill identity');
    value.candidate=candidate;value.candidateNotes=p.notes;
    (value.candidateHistory??=[]).push({asset:candidate,notes:p.notes,recordedAt:new Date().toISOString()});
    await writeJsonAtomic(this.file(id),value);return value;
  });}
  async analyze(id:string) {
    const value=await this.get(id), source=await this.skills.readSource(value.source.assetId);
    const files=await this.skills.readFiles((value.candidate??value.source).assetId);
    const archive=await this.skills.readArchive((value.candidate??value.source).assetId);
    return {project:value, source, candidate:value.candidate ? await this.skills.readSource(value.candidate.assetId):null,
      readableFiles:Object.keys(files), inventoryComplete:false,
      fileInventory:Object.entries(archive).map(([name,bytes])=>({name,bytes:bytes.length,
        sha256:createHash('sha256').update(bytes).digest('hex'),
        executableReviewRequired:/\.(py|sh|js|mjs|cjs|exe|jar)$/i.test(name)})),
      unresolved:['ORIGINAL_AGENTSCOPE_PROJECT_AND_LOCK_REQUIRED','TRUSTED_NATIVE_RUNTIME_IDENTITY_REQUIRED',
        'READ_ONLY_TOOL_AND_DATA_MAPPING_REVIEW_REQUIRED','BUILDER_JAVA_HOST_ADAPTER_NOT_CONNECTED'],
      analysisMode:'STATIC_INVENTORY_NOT_DEPENDENCY_VALIDATION', uploadedScriptsExecuted:false};
  }
  async validate(id:string,input:unknown) {return this.serial(async()=>{
    const p=planSchema.parse(input), value=await this.get(id), c=value.candidate;
    if (!c || !p.configuration.runtimeBindings) return conflict('Candidate and per-side bindings are required');
    const pack=p.configuration.packId ? this.catalog.get(p.configuration.packId):null;
    if (!pack || p.configuration.preparationId || p.configuration.includeHoldout) return conflict('Select one frozen catalog suite');
    const expected=p.pair==='AB' ? [value.source,c] : p.pair==='BC' ? [c,c] : [value.source,c];
    for (const [index,side] of (['left','right'] as const).entries()) {
      const binding=p.configuration.runtimeBindings[side], variant=p.configuration[side==='left'?'leftVariant':'rightVariant'];
      const asset=expected[index]!;
      if (binding.skillAssetId!==asset.assetId || variant?.mode!=='skill_version' || variant.artifactSha256!==asset.artifactSha256
          || variant.skillId!==asset.skillId || variant.version!==asset.version) return conflict('Pair asset binding does not match the frozen source/candidate');
    }
    if (p.pair==='AB' && p.configuration.runtimeBindings.left.environmentId!==p.configuration.runtimeBindings.right.environmentId) return conflict('AB must preserve the original Runtime environment');
    const comparisonFingerprint=fingerprint({pack:pack.packFingerprint, model:p.configuration.executionModel,
      cases:p.configuration.selectedCaseIds, data:p.dataSnapshot, permissions:p.permissionBasis,
      sourceProject:p.sourceProjectRef, lock:p.dependencyLockRef});
    const job=await this.runs.create(p.configuration);
    value.runs.push({jobId:job.jobId,pair:p.pair,candidateDigest:c.artifactSha256,comparisonFingerprint,packFingerprint:pack.packFingerprint,declaredPlan:p,suiteSnapshot:pack});
    await writeJsonAtomic(this.file(id),value);
    return {job,comparisonFingerprint,acceptance:'NOT_VALIDATED',note:'Runs are experiments; declared environment/material references are not native-runtime or authorization attestation.'};
  });}
  async report(id:string) {
    const value=await this.get(id);
    return {project:value, experiments:value.runs.map(r=>{
      const job=this.jobs.get(r.jobId);
      return {...r,execution:job?.status??'MISSING',report:job?.report??null,
        evidence:job?.status==='completed'?'HTTP_LOADED_DIGEST_CHECKED':'NOT_COMPLETE',
        taskSuccess:'NOT_INDEPENDENTLY_VERIFIED',professionalAcceptance:'NOT_REVIEWED',migrationAcceptance:'NOT_VALIDATED'};
    }), attribution:'BC compares target execution stacks, including Harness; not a pure Runtime effect.'};
  }
  async exportCandidate(id:string) {
    const value=await this.get(id);
    if (!value.candidate) return conflict('Candidate required');
    await this.skills.readArchive(value.candidate.assetId);
    const files=await this.skills.readFiles(value.candidate.assetId);
    if (Object.keys(files).length !== value.candidate.fileCount) return conflict('Candidate contains unsupported or out-of-root files; export must not silently drop dependencies');
    const manifest={schemaVersion:'finance.skill-migration.exchange.v0.1',projectId:id,source:value.source,candidate:value.candidate,
      state:'DRAFT_NOT_VALIDATED',builderImport:'NOT_VERIFIED',installationLock:'ASSEMBLER_RESPONSIBILITY',
      fileDigestAlgorithm:'SHA-256 of UTF-8 bytes',
      files:Object.fromEntries(Object.entries(files).map(([name,content])=>[name,createHash('sha256').update(content,'utf8').digest('hex')]))};
    return Buffer.from(zipSync(Object.fromEntries([...Object.entries(files).map(([k,v])=>[k,strToU8(v)] as const),
      ['migration-manifest.json',strToU8(JSON.stringify(manifest,null,2))]])));
  }
  release():never {return conflict('Release blocked: native AgentScope baseline, Java Host integration, dependency validation and independent business acceptance remain unverified');}
}
