import type { MigrationSkillRepository } from './application/migration-skill-repository.js';
import type { MigrationEvaluationJobReader,MigrationEvaluationRunner } from './application/migration-evaluation-ports.js';
import type { MigrationEvalPackCatalog } from './application/migration-eval-pack-catalog.js';
import type { MigrationPreparationRepository } from './application/migration-preparation-repository.js';
import type { MigrationOptimizationPort } from './application/migration-optimization-port.js';
import type { MigrationDiagnosisPort } from './application/migration-diagnosis-port.js';
import type { MigrationEnvironmentRepository } from './application/migration-environment-repository.js';
import type {MigrationAnalyzer,MigrationImplementer} from './application/migration-agent-port.js';
import type {MigrationSuiteGenerator} from './application/migration-suite-generator.js';
import type { MigrationCodeGeneratorPort } from './application/migration-code-generator-port.js';
import type { MigrationProjectStore } from './application/migration-project-store.js';
import type { MigrationProject } from './domain/migration-project.js';
import type { MigrationRuntimeReference } from './application/migration-runtime-configuration-service.js';
import { migrationConflict as conflict } from './application/migration-errors.js';
import {createMigrationServices,type MigrationServices} from './migration-composition.js';

/** Stable migration facade; concrete adapters are assembled only by migration-composition. */
export class MigrationStore {
  private readonly services:MigrationServices;
  constructor(root:string, skills:MigrationSkillRepository, runs:MigrationEvaluationRunner,
    jobs:MigrationEvaluationJobReader, catalog:MigrationEvalPackCatalog, preparations?:MigrationPreparationRepository,
    optimizers?:MigrationOptimizationPort, diagnostics?:MigrationDiagnosisPort, environments?:MigrationEnvironmentRepository,
    codeGenerator?:MigrationCodeGeneratorPort,
    analyzer?:MigrationAnalyzer,
    implementer?:MigrationImplementer,
    suiteGenerator?:MigrationSuiteGenerator,
    projects?: MigrationProjectStore) {
    this.services=createMigrationServices({root,skills,runs,jobs,catalog,preparations,optimizers,diagnostics,environments,
      codeGenerator,analyzer,implementer,suiteGenerator,projects});
  }
  async target(){return this.services.legacyService.target();}
  async verifyTarget(id:string,input:unknown){return this.services.legacyService.verifyTarget(id,input);}
  async list() {return this.services.projectService.list();}
  async get(id:string):Promise<MigrationProject> {return this.services.projectService.get(id);}
  async create(input:unknown) {return this.services.projectService.create(input);}
  async upgrade(id:string){return this.services.projectService.upgrade(id);}
  async diagnose(id:string,retry=false){return this.services.projectService.diagnose(id,retry);}
  async inspect(id:string,sourceOnly=false){return this.services.inspectionService.inspect(id,sourceOnly);}
  async dependencyData(id:string,dependencyId:string){
    return this.services.runtimeConfigurationService.dependencyData(id,dependencyId);
  }
  async runtimeConfiguration(id:string){
    return this.services.runtimeConfigurationService.runtimeConfiguration(id);
  }
  async saveRuntimeDependency(id:string,dependencyId:string,input:unknown){return this.services.runtimeConfigurationService.saveRuntimeDependency(id,dependencyId,input);}
  async resolveRuntimeDependencies(reference:MigrationRuntimeReference){return this.services.runtimeConfigurationService.resolveRuntimeDependencies(reference);}
  async resolveServiceEnvironment(reference:MigrationRuntimeReference,toolNames:string[]){return this.services.runtimeConfigurationService.resolveServiceEnvironment(reference,toolNames);}
  async checkBusinessConnection(id:string,input:unknown,signal?:AbortSignal){return this.services.runtimeConfigurationService.checkBusinessConnection(id,input,signal);}
  async supplementDependency(id:string,dependencyId:string,input:unknown){return this.services.supplementService.supplementDependency(id,dependencyId,input);}
  async uploadDependency(id:string,dependencyId:string,revision:number,filename:string,bytes:Buffer){return this.services.supplementService.uploadDependency(id,dependencyId,revision,filename,bytes);}
  async explainDependency(id:string,dependencyId:string,input:unknown){return this.services.supplementService.explainDependency(id,dependencyId,input);}
  async inspection(id:string){return this.services.inspectionService.inspection(id);}
  async decide(id:string,toolId:string,input:unknown){return this.services.planningService.decide(id,toolId,input);}
  async plan(id:string){return this.services.planningService.plan(id);}
  async runtimeRequirements(id:string){return this.services.planningService.runtimeRequirements(id);}
  async runtimeRequirementsYaml(id:string){return this.services.planningService.runtimeRequirementsYaml(id);}
  async validateTechnical(id:string,input:unknown,signal?:AbortSignal){return this.services.technicalValidation.validate(id,input,signal);}
  async technicalValidations(id:string){return this.services.technicalValidation.list(id);}
  async validateOpenJiuwen(id:string,input:unknown){return this.services.openJiuwenService.validate(id,input);}
  async openJiuwenValidations(id:string){return this.services.openJiuwenService.validations(id);}
  async generate(id:string,input:unknown){
    if(input&&typeof input==='object'&&'runtime' in input)return this.services.legacyService.generate(id,input);
    return this.services.generationService.generate(id,input);
  }
  async candidate(id:string,input:unknown) {return this.services.candidateService.import(id,input);}
  async draft(id:string,input:unknown) {return this.services.candidateService.saveDraft(id,input);}
  async analyze(id:string) {return this.services.candidateService.analyze(id);}
  async review(id:string,input:unknown){return this.services.candidateService.review(id,input);}
  async createSuite(id:string,input:unknown) {return this.services.suiteService.create(id,input);}
  async importSimpleSuite(id:string,input:unknown){return this.services.suiteService.importSimple(id,input);}
  async generateSuite(id:string,input:unknown) {return this.services.suiteService.generate(id,input);}
  async optimize(id:string,input:unknown) {return this.services.optimizationService.optimize(id,input);}
  async adoptOptimization(id:string,input:unknown) {return this.services.optimizationService.adopt(id,input);}
  async validate(id:string,input:unknown) {return this.services.evaluationService.validate(id,input);}
  async report(id:string) {return this.services.reportService.report(id);}
  async exportCandidate(id:string) {return this.services.exportService.exportCandidate(id);}
  release():never {return conflict('发布已阻止：原环境基线、目标 Host 接入、依赖验证与独立业务验收都还没有验证');}
}
