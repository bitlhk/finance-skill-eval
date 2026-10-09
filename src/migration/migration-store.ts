import type { MigrationProject } from './domain/migration-project.js';
import type { MigrationRuntimeReference } from './application/migration-runtime-configuration-service.js';
import { migrationConflict as conflict } from './application/migration-errors.js';
import {createMigrationServices,type MigrationCompositionOptions,type MigrationServices} from './migration-composition.js';

/** Stable migration facade; concrete adapters are assembled only by migration-composition. */
export class MigrationStore {
  private readonly services:MigrationServices;
  constructor(root:string, options:Omit<MigrationCompositionOptions,'root'>) {
    this.services=createMigrationServices({root,...options});
  }
  async list() {return this.services.projectService.list();}
  async get(id:string):Promise<MigrationProject> {return this.services.projectService.get(id);}
  async listLegacy(){return this.services.projectService.listLegacy();}
  async readLegacy(id:string){return this.services.projectService.readLegacy(id);}
  async create(input:unknown) {return this.services.projectService.create(input);}
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
  async runtimeRequirements(id:string,runtimeType?:string){return this.services.planningService.runtimeRequirements(id,runtimeType);}
  async runtimeRequirementsYaml(id:string,runtimeType?:string){return this.services.planningService.runtimeRequirementsYaml(id,runtimeType);}
  async bindRuntimeDelivery(id:string,input:unknown){return this.services.planningService.bindRuntimeDelivery(id,input);}
  async validateTechnical(id:string,input:unknown,signal?:AbortSignal){return this.services.technicalValidation.validate(id,input,signal);}
  async technicalValidations(id:string){return this.services.technicalValidation.list(id);}
  async validateOpenJiuwen(id:string,input:unknown){return this.services.openJiuwenService.validate(id,input);}
  async openJiuwenValidations(id:string){return this.services.openJiuwenService.validations(id);}
  async generate(id:string,input:unknown){return this.services.generationService.generate(id,input);}
  async candidate(id:string,input:unknown) {return this.services.candidateService.import(id,input);}
  async nativeCandidate(id:string,input:unknown,targets:import('../shared/contracts/native-tool-catalog.js').NativeBindingTarget[]){return this.services.nativeBindingService.bind(id,input,targets);}
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
  async conformanceCandidate(id:string) {return this.services.exportService.conformanceCandidate(id);}
  release():never {return conflict('发布已阻止：原环境基线、目标 Host 接入、依赖验证与独立业务验收都还没有验证');}
}
