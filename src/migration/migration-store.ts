import type { MigrationSkillRepository } from './application/migration-skill-repository.js';
import type { MigrationEvaluationJobReader,MigrationEvaluationRunner } from './application/migration-evaluation-ports.js';
import type { MigrationEvalPackCatalog } from './application/migration-eval-pack-catalog.js';
import type { MigrationPreparationRepository } from './application/migration-preparation-repository.js';
import { FileMigrationPreparationPackFactory } from './infrastructure/migration-preparation-pack-factory.js';
import type { MigrationOptimizationPort } from './application/migration-optimization-port.js';
import { configuredModelRole } from '../service/config.js';
import { MigrationDiagnostics } from './infrastructure/migration-diagnostics.js';
import type { MigrationEnvironmentRepository } from './application/migration-environment-repository.js';
import { analyzeWithAgent,implementWithAgent } from './infrastructure/migration-agent.js';
import type {MigrationAnalyzer,MigrationImplementer} from './application/migration-agent-port.js';
import {generateSuiteWithAnalyzer} from './infrastructure/migration-suite-generator.js';
import type {MigrationSuiteGenerator} from './application/migration-suite-generator.js';
import { MigrationCodeGenerator } from './infrastructure/migration-code-generator.js';
import type { MigrationCodeGeneratorPort } from './application/migration-code-generator-port.js';
import { MigrationProjectRepository } from './infrastructure/migration-project-repository.js';
import type { MigrationProjectStore } from './application/migration-project-store.js';
import type { MigrationProject } from './domain/migration-project.js';
import { MigrationProjectService } from './application/migration-project-service.js';
import { MigrationInspectionService, type MigrationRuntimeReference } from './application/migration-inspection-service.js';
import { MigrationSuiteService } from './application/migration-suite-service.js';
import { MigrationCandidateService } from './application/migration-candidate-service.js';
import { MigrationGenerationService } from './application/migration-generation-service.js';
import { MigrationTechnicalValidationWorkflow } from './application/migration-technical-validation-service.js';
import { MigrationEvaluationService } from './application/migration-evaluation-service.js';
import { MigrationOpenJiuwenService } from './application/migration-openjiuwen-service.js';
import { MigrationOptimizationService } from './application/migration-optimization-service.js';
import { MigrationExportService } from './application/migration-export-service.js';
import { MigrationLegacyService } from './application/migration-legacy-service.js';
import { migrationConflict as conflict } from './application/migration-errors.js';
import { MigrationRuntimeConfig } from './infrastructure/migration-runtime-config.js';
import { MigrationTargetRuns } from './infrastructure/migration-target.js';

/** Separate migration snapshots from optimization jobs. No uploaded code is executed here. */
export class MigrationStore {
  private readonly projects: MigrationProjectStore;
  private readonly projectService: MigrationProjectService;
  private readonly inspectionService: MigrationInspectionService;
  private readonly suiteService: MigrationSuiteService;
  private readonly candidateService: MigrationCandidateService;
  private readonly generationService: MigrationGenerationService;
  private readonly technicalValidation: MigrationTechnicalValidationWorkflow;
  private readonly evaluationService: MigrationEvaluationService;
  private readonly openJiuwenService: MigrationOpenJiuwenService;
  private readonly optimizationService: MigrationOptimizationService;
  private readonly exportService: MigrationExportService;
  private readonly legacyService: MigrationLegacyService;
  constructor(root:string, skills:MigrationSkillRepository, runs:MigrationEvaluationRunner,
    jobs:MigrationEvaluationJobReader, catalog:MigrationEvalPackCatalog, preparations?:MigrationPreparationRepository,
    optimizers?:MigrationOptimizationPort, diagnostics?:MigrationDiagnostics, environments?:MigrationEnvironmentRepository,
    codeGenerator:MigrationCodeGeneratorPort=new MigrationCodeGenerator(()=>configuredModelRole('MIGRATION')),
    analyzer:MigrationAnalyzer=(input,)=>analyzeWithAgent(input,{projectRoot:process.env.FINANCE_EVAL_ROOT?.trim()||process.cwd(),
      modelId:process.env.FINANCE_EVAL_AGENT_MODEL_ID?.trim()||'enterprise-model'}),
    implementer:MigrationImplementer=(input,)=>implementWithAgent(input,{projectRoot:process.env.FINANCE_EVAL_ROOT?.trim()||process.cwd(),
      modelId:process.env.FINANCE_EVAL_AGENT_MODEL_ID?.trim()||'enterprise-model'}),
    suiteGenerator:MigrationSuiteGenerator=(input,)=>generateSuiteWithAnalyzer(input,()=>configuredModelRole('ANALYZER')),
    projects?: MigrationProjectStore) {
    this.projects = projects ?? new MigrationProjectRepository(root);
    const runtimeConfigs=new MigrationRuntimeConfig(root);
    const targets=new MigrationTargetRuns(root,skills);
    this.projectService = new MigrationProjectService(this.projects, skills, diagnostics);
    this.inspectionService = new MigrationInspectionService(root, this.projects, skills, analyzer,runtimeConfigs);
    this.suiteService = new MigrationSuiteService(this.projects, skills, analyzer, suiteGenerator, preparations);
    this.candidateService = new MigrationCandidateService(this.projects, skills, diagnostics);
    this.generationService = new MigrationGenerationService(root, this.projects, skills, implementer, codeGenerator, diagnostics);
    this.technicalValidation = new MigrationTechnicalValidationWorkflow(root, this.projects, skills,runtimeConfigs);
    this.evaluationService = new MigrationEvaluationService(root, this.projects, skills, runs, jobs, catalog, preparations,
      preparations?new FileMigrationPreparationPackFactory(root):undefined,
      {analyzer:()=>configuredModelRole('ANALYZER').model,judge:()=>configuredModelRole('JUDGE').model},
      optimizers, diagnostics, environments,runtimeConfigs,targets);
    this.openJiuwenService = new MigrationOpenJiuwenService(root, this.projects, skills, this.technicalValidation, this.evaluationService, environments,runtimeConfigs);
    this.optimizationService = new MigrationOptimizationService(root, this.projects, skills, jobs, this.technicalValidation, optimizers, environments,runtimeConfigs);
    this.exportService = new MigrationExportService(this.projects, skills, this.evaluationService);
    this.legacyService = new MigrationLegacyService(root, this.projects, this.projectService, skills, diagnostics, environments,targets);
  }
  async target(){return this.legacyService.target();}
  async verifyTarget(id:string,input:unknown){return this.legacyService.verifyTarget(id,input);}
  async list() {return this.projectService.list();}
  async get(id:string):Promise<MigrationProject> {return this.projectService.get(id);}
  async create(input:unknown) {return this.projectService.create(input);}
  async upgrade(id:string){return this.projectService.upgrade(id);}
  async diagnose(id:string,retry=false){return this.projectService.diagnose(id,retry);}
  async inspect(id:string,sourceOnly=false){return this.inspectionService.inspect(id,sourceOnly);}
  async dependencyData(id:string,dependencyId:string){
    return this.inspectionService.dependencyData(id,dependencyId);
  }
  async runtimeConfiguration(id:string){
    return this.inspectionService.runtimeConfiguration(id);
  }
  async saveRuntimeDependency(id:string,dependencyId:string,input:unknown){return this.inspectionService.saveRuntimeDependency(id,dependencyId,input);}
  async resolveRuntimeDependencies(reference:MigrationRuntimeReference){return this.inspectionService.resolveRuntimeDependencies(reference);}
  async resolveServiceEnvironment(reference:MigrationRuntimeReference,toolNames:string[]){return this.inspectionService.resolveServiceEnvironment(reference,toolNames);}
  async checkBusinessConnection(id:string,input:unknown,signal?:AbortSignal){return this.inspectionService.checkBusinessConnection(id,input,signal);}
  async supplementDependency(id:string,dependencyId:string,input:unknown){return this.inspectionService.supplementDependency(id,dependencyId,input);}
  async uploadDependency(id:string,dependencyId:string,revision:number,filename:string,bytes:Buffer){return this.inspectionService.uploadDependency(id,dependencyId,revision,filename,bytes);}
  async explainDependency(id:string,dependencyId:string,input:unknown){return this.inspectionService.explainDependency(id,dependencyId,input);}
  async inspection(id:string){return this.inspectionService.inspection(id);}
  async decide(id:string,toolId:string,input:unknown){return this.inspectionService.decide(id,toolId,input);}
  async plan(id:string){return this.inspectionService.plan(id);}
  async runtimeRequirements(id:string){return this.inspectionService.runtimeRequirements(id);}
  async runtimeRequirementsYaml(id:string){return this.inspectionService.runtimeRequirementsYaml(id);}
  async validateTechnical(id:string,input:unknown,signal?:AbortSignal){return this.technicalValidation.validate(id,input,signal);}
  async technicalValidations(id:string){return this.technicalValidation.list(id);}
  async validateOpenJiuwen(id:string,input:unknown){return this.openJiuwenService.validate(id,input);}
  async openJiuwenValidations(id:string){return this.openJiuwenService.validations(id);}
  async generate(id:string,input:unknown){
    if(input&&typeof input==='object'&&'runtime' in input)return this.legacyService.generate(id,input);
    return this.generationService.generate(id,input);
  }
  async candidate(id:string,input:unknown) {return this.candidateService.import(id,input);}
  async draft(id:string,input:unknown) {return this.candidateService.saveDraft(id,input);}
  async analyze(id:string) {return this.candidateService.analyze(id);}
  async review(id:string,input:unknown){return this.candidateService.review(id,input);}
  async createSuite(id:string,input:unknown) {return this.suiteService.create(id,input);}
  async importSimpleSuite(id:string,input:unknown){return this.suiteService.importSimple(id,input);}
  async generateSuite(id:string,input:unknown) {return this.suiteService.generate(id,input);}
  async optimize(id:string,input:unknown) {return this.optimizationService.optimize(id,input);}
  async adoptOptimization(id:string,input:unknown) {return this.optimizationService.adopt(id,input);}
  async validate(id:string,input:unknown) {return this.evaluationService.validate(id,input);}
  async report(id:string) {return this.evaluationService.report(id);}
  async exportCandidate(id:string) {return this.exportService.exportCandidate(id);}
  release():never {return conflict('发布已阻止：原环境基线、目标 Host 接入、依赖验证与独立业务验收都还没有验证');}
}
