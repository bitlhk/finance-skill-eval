import { createHash } from 'node:crypto';
import { strToU8, zipSync } from 'fflate';
import type { MigrationSkillRepository } from './migration-skill-repository.js';
import type { MigrationProjectRepository } from '../infrastructure/migration-project-repository.js';
import type { MigrationEvaluationService } from './migration-evaluation-service.js';
import { migrationConflict as conflict } from './migration-errors.js';

export class MigrationExportService {
  constructor(
    private readonly projects:MigrationProjectRepository,
    private readonly skills:MigrationSkillRepository,
    private readonly evaluation:MigrationEvaluationService,
  ) {}

  async exportCandidate(id:string) {
    const value=await this.projects.get(id);
    if (!value.candidate) return conflict('请先生成候选');
    const files=await this.skills.readArchive(value.candidate.assetId);
    if (['migration-manifest.json','migration-report.json'].some(name=>name in files)) return conflict('候选里已存在导出要用的元数据路径，未覆盖任何文件');
    for(const [name,bytes] of Object.entries(files)){
      if(/(^|\/)(\.env(?:\..*)?|access-token|id_rsa|id_ed25519)$|\.(pem|key)$/i.test(name)||/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|(?:api[_-]?key|password|secret|token)\s*[:=]\s*["'][^"'\n]{8,}["']/i.test(Buffer.from(bytes).toString())) {
        return conflict('候选可能包含凭据，请先检查并移除敏感配置；未导出任何文件');
      }
    }
    // V2 exports are the standard Skill/Tool delivery itself. Migration evidence
    // remains available from /report and must not pollute the specified package.
    if(value.schemaVersion==='finance.skill-migration.v2')return Buffer.from(zipSync(files));

    const report=await this.evaluation.report(id);
    const state=report.verification.targetExecution==='PASSED'?'TARGET_VERIFIED_CANDIDATE':'DRAFT_NOT_VALIDATED';
    const manifest={schemaVersion:'finance.skill-migration.exchange.v0.1',projectId:id,source:value.source,candidate:value.candidate,
      state,builderImport:'NOT_VERIFIED',installationLock:'ASSEMBLER_RESPONSIBILITY',
      executionPolicy:'INERT_ARCHIVE_ONLY_NO_SCRIPT_EXECUTION',dependencies:'NOT_VALIDATED',
      fileDigestAlgorithm:'SHA-256 of original file bytes',
      files:Object.fromEntries(Object.entries(files).map(([name,content])=>[name,createHash('sha256').update(content).digest('hex')]))};
    return Buffer.from(zipSync({...files,'migration-manifest.json':strToU8(JSON.stringify(manifest,null,2)),
      'migration-report.json':strToU8(JSON.stringify({schemaVersion:'migration.export-scope.v1',state,
        candidateDigest:value.candidate.artifactSha256,inspection:report.inspection,decisions:report.decisions,migrationPlan:report.migrationPlan,
        technicalValidations:report.technicalValidations.map(validation=>({validationId:validation.validationId,toolId:validation.toolId,assetDigest:validation.assetDigest,implementationDigest:validation.implementationDigest,casesDigest:validation.casesDigest,mode:validation.mode,status:validation.status,stages:validation.stages,current:validation.current})),openJiuwenValidations:report.openJiuwenValidations,verification:report.verification,
        changes:(value.portableGenerationDiff??value.generation?.diff??[]).map(change=>({path:change.path,operation:change.operation})),
        targetRuns:report.targetRuns.map(run=>({id:run.id,candidateDigest:run.candidateDigest,status:run.status,
          cases:run.cases.map(testCase=>({caseId:testCase.caseId,passed:testCase.passed}))})),
        professionalAcceptance:report.professionalReview?'ADMIN_RECORDED_NOT_INDEPENDENTLY_VERIFIED':'NOT_REVIEWED',
        professionalReview:report.professionalReview?{decision:report.professionalReview.decision,source:report.professionalReview.source,recordedAt:report.professionalReview.recordedAt}:null,
        originalEquivalence:'NOT_VERIFIED',
        excluded:'No raw model answers, test payloads, connection configuration or complete experiment reports. Review your own method/resource files for private content before sharing.'},null,2))}));
  }
}
