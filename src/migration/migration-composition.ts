import {configuredModelRole} from '../service/config.js';
import {FileExecutionConfigurationRepository} from '../execution-configuration/file-execution-configuration-repository.js';
import type {MigrationAnalyzer,MigrationImplementer} from './application/migration-agent-port.js';
import {MigrationCandidateInspectionService} from './application/migration-candidate-inspection-service.js';
import {MigrationCandidateService} from './application/migration-candidate-service.js';
import type {MigrationDiagnosisPort} from './application/migration-diagnosis-port.js';
import type {MigrationEnvironmentRepository} from './application/migration-environment-repository.js';
import type {MigrationEvalPackCatalog} from './application/migration-eval-pack-catalog.js';
import type {MigrationEvaluationJobReader,MigrationEvaluationRunner} from './application/migration-evaluation-ports.js';
import {MigrationEvaluationService} from './application/migration-evaluation-service.js';
import {MigrationExportService} from './application/migration-export-service.js';
import {MigrationGenerationService} from './application/migration-generation-service.js';
import {MigrationImplementationService} from './application/migration-implementation-service.js';
import {MigrationInspectionService} from './application/migration-inspection-service.js';
import {MigrationOpenJiuwenService} from './application/migration-openjiuwen-service.js';
import {MigrationOptimizationService} from './application/migration-optimization-service.js';
import type {MigrationOptimizationPort} from './application/migration-optimization-port.js';
import {MigrationPlanningService} from './application/migration-planning-service.js';
import type {MigrationPreparationRepository} from './application/migration-preparation-repository.js';
import {MigrationProjectService} from './application/migration-project-service.js';
import type {MigrationProjectStore} from './application/migration-project-store.js';
import {MigrationReportService} from './application/migration-report-service.js';
import {MigrationRuntimeConfigurationService} from './application/migration-runtime-configuration-service.js';
import type {MigrationSkillRepository} from './application/migration-skill-repository.js';
import {MigrationSuiteService} from './application/migration-suite-service.js';
import type {MigrationSuiteGenerator} from './application/migration-suite-generator.js';
import {MigrationSupplementService} from './application/migration-supplement-service.js';
import {MigrationTechnicalValidationWorkflow} from './application/migration-technical-validation-service.js';
import type {MigrationValidationRunner} from './application/migration-technical-validator.js';
import {AgentMigrationDependencyAnalyzer} from './infrastructure/migration-dependencies.js';
import {AgentResultMapper} from './infrastructure/migration-agent-result-mapper.js';
import {analyzeWithAgent,implementWithAgent} from './infrastructure/migration-agent-gateway.js';
import {PortableCandidatePackager} from './infrastructure/migration-candidate-packager.js';
import {FileMigrationPreparationPackFactory} from './infrastructure/migration-preparation-pack-factory.js';
import {MigrationProjectRepository} from './infrastructure/migration-project-repository.js';
import {HttpMigrationBusinessConnectionProbe} from './infrastructure/migration-business-connection-probe.js';
import type {ConnectionCheck} from './application/migration-runtime-configuration-repository.js';
import {YamlMigrationHarnessSerializer} from './infrastructure/migration-harness-serializer.js';
import {MigrationSupplements} from './infrastructure/migration-supplements.js';
import {generateSuiteWithAnalyzer} from './infrastructure/migration-suite-generator.js';
import {LocalMigrationCommandResolver,LocalMigrationValidationRunner} from './infrastructure/migration-technical-validator.js';

export type MigrationCompositionOptions={
  root:string;
  skills:MigrationSkillRepository;
  runs:MigrationEvaluationRunner;
  jobs:MigrationEvaluationJobReader;
  catalog:MigrationEvalPackCatalog;
  preparations?:MigrationPreparationRepository;
  optimizers?:MigrationOptimizationPort;
  diagnostics?:MigrationDiagnosisPort;
  environments?:MigrationEnvironmentRepository;
  analyzer?:MigrationAnalyzer;
  implementer?:MigrationImplementer;
  suiteGenerator?:MigrationSuiteGenerator;
  projects?:MigrationProjectStore;
  validationRunner?:MigrationValidationRunner;
};

/** Creates the migration feature graph. The store itself remains a thin compatibility facade. */
export function createMigrationServices(options:MigrationCompositionOptions){
  const {root,skills,runs,jobs,catalog,preparations,optimizers,diagnostics,environments}=options;
  const projects=options.projects??new MigrationProjectRepository(root);
  const analyzer=options.analyzer??((input)=>analyzeWithAgent(input,{
    projectRoot:process.env.FINANCE_EVAL_ROOT?.trim()||process.cwd(),
    modelId:process.env.FINANCE_EVAL_AGENT_MODEL_ID?.trim()||'enterprise-model',
  }));
  const implementer=options.implementer??((input)=>implementWithAgent(input,{
    projectRoot:process.env.FINANCE_EVAL_ROOT?.trim()||process.cwd(),
    modelId:process.env.FINANCE_EVAL_AGENT_MODEL_ID?.trim()||'enterprise-model',
  }));
  const suiteGenerator=options.suiteGenerator??((input)=>generateSuiteWithAnalyzer(input,()=>configuredModelRole('ANALYZER')));
  const runtimeConfigs=new FileExecutionConfigurationRepository<ConnectionCheck>(root,'migration-runtime-config',id=>/^migration-[a-f0-9-]+$/u.test(id));
  const commandResolver=new LocalMigrationCommandResolver();
  const validationRunner=options.validationRunner??new LocalMigrationValidationRunner(undefined,commandResolver);
  const technicalValidation=new MigrationTechnicalValidationWorkflow(projects,skills,runtimeConfigs,validationRunner);
  const supplements=new MigrationSupplements(root);
  const agentResults=new AgentResultMapper();
  const projectService=new MigrationProjectService(projects,skills,diagnostics);
  const evaluationService=new MigrationEvaluationService(projects,runs,catalog,preparations,
    preparations?new FileMigrationPreparationPackFactory(root):undefined,
    {analyzer:()=>configuredModelRole('ANALYZER').model,judge:()=>configuredModelRole('JUDGE').model},runtimeConfigs);
  const reportService=new MigrationReportService(projects,jobs,preparations,optimizers,diagnostics,environments,runtimeConfigs);
  const implementationService=new MigrationImplementationService(implementer,agentResults);
  return {
    projectService,
    inspectionService:new MigrationInspectionService(projects,skills,analyzer,supplements,new AgentMigrationDependencyAnalyzer(),agentResults),
    planningService:new MigrationPlanningService(projects,new YamlMigrationHarnessSerializer()),
    runtimeConfigurationService:new MigrationRuntimeConfigurationService(projects,runtimeConfigs,supplements,new HttpMigrationBusinessConnectionProbe()),
    supplementService:new MigrationSupplementService(projects,supplements),
    suiteService:new MigrationSuiteService(projects,skills,analyzer,suiteGenerator,agentResults,preparations),
    candidateService:new MigrationCandidateService(projects,skills,diagnostics),
    generationService:new MigrationGenerationService(projects,skills,supplements,new PortableCandidatePackager(),implementationService,new MigrationCandidateInspectionService(diagnostics)),
    technicalValidation,
    evaluationService,
    reportService,
    openJiuwenService:new MigrationOpenJiuwenService(projects,skills,technicalValidation,evaluationService,reportService,commandResolver,environments,runtimeConfigs),
    optimizationService:new MigrationOptimizationService(projects,skills,jobs,technicalValidation,optimizers,environments,runtimeConfigs),
    exportService:new MigrationExportService(projects,skills),
  };
}

export type MigrationServices=ReturnType<typeof createMigrationServices>;
