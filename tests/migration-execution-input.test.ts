import {it,expect} from 'vitest';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {analyzeDependencies} from '../src/migration/infrastructure/migration-dependencies.js';
import {dependencyBlocksMigration,isExecutionInput} from '../src/migration/domain/migration-dependency.js';
import {buildMigrationPlan} from '../src/migration/domain/migration-model.js';
import {MigrationSupplementService} from '../src/migration/application/migration-supplement-service.js';
import {ExecutionInputDependency} from '../web/src/DiagnosisStep.js';
import {inspectionFixture,toolFixture} from './analysis-fixture.js';

const files={'scripts/query.py':"def query(order_id):\n    file = Path('requests') / (order_id + '.json')\n    if not file.exists(): return {'error': 'NOT_FOUND'}\n    return json.loads(file.read_text())\n"};
const inspection=inspectionFixture([toolFixture({name:'query',sourcePaths:['scripts/query.py'],kind:'SCRIPT',portability:'PORTABLE_SCRIPT',language:'Python'})]);
const evidence={path:'scripts/query.py',snippet:"file = Path('requests') / (order_id + '.json')"};
function payload(){return {dependencyAnalysis:{dependencies:[{key:'request-data',name:'Request data',kind:'DATA',owner:'TOOL',action:'KEEP',contractStatus:'KNOWN',sensitive:false,binding:null,purpose:'Read data supplied for the current request',blocking:true,availability:'UNKNOWN',references:[{toolName:'query',...evidence}],schema:{type:'object'},schemaCompleteness:'PARTIAL',schemaEvidence:[evidence],executionInput:{contract:'Caller supplies requests/<order_id>.json for each invocation; absent file returns NOT_FOUND.',evidence:[evidence]}}],chains:[{toolName:'query',nodes:[{id:'read',title:'Read request',detail:'Read current invocation input',dependencyKeys:['request-data'],evidence:[evidence]}]}]}};}
function analyze(raw:unknown=payload()) {return analyzeDependencies(raw,inspection,files,[],0,'digest');}

it('separates per-call data readiness from migration readiness without inventing values or schema',()=>{
 const analysis=analyze(),dep=analysis.dependencies[0]!;
 expect(analysis.status).toBe('COMPLETE');expect(dep).toMatchObject({availability:'UNKNOWN',provided:'NONE',blocking:true,schemaCompleteness:'PARTIAL'});
 expect(isExecutionInput(dep)).toBe(true);expect(dependencyBlocksMigration(dep)).toBe(false);
 expect(buildMigrationPlan({...inspection,dependencyAnalysis:analysis},[{toolId:inspection.tools[0]!.toolId,form:'SCRIPT',language:'python',baseAssetId:'asset',reason:'',decidedAt:'now'}],'asset').generationAllowed).toBe(true);
 const missing=payload();missing.dependencyAnalysis.dependencies[0]!.availability='MISSING';expect(analyze(missing).status).toBe('COMPLETE');
});

it('does not exempt DATA merely by kind, purpose, availability or a partial schema',()=>{
 const raw=payload() as any;delete raw.dependencyAnalysis.dependencies[0].executionInput;
 expect(analyze(raw).status).toBe('PARTIAL');expect(dependencyBlocksMigration(analyze(raw).dependencies[0]!)).toBe(true);
});

it.each([{kind:'CONFIG'},{kind:'RESOURCE'},{kind:'SDK'},{owner:'UNKNOWN'},{owner:'RUNTIME',action:'INJECT',binding:{kind:'HTTP_HEADER',name:'Authorization'}},{action:'MOVE_TO_RUNTIME'},{contractStatus:'UNKNOWN'},{binding:{kind:'SCRIPT_CONTEXT',name:'workspace'}},{executionInput:{contract:'Per call',evidence:[{...evidence,snippet:'invented original source'}]}},{executionInput:{contract:'Per call',evidence:[{...evidence,path:'../outside.py'}]}}])('rejects invalid input ownership or unverified claims: %j',change=>{
 const raw=payload() as any;Object.assign(raw.dependencyAnalysis.dependencies[0],change);
 const result=analyze(raw);expect(result.status).toBe('PARTIAL');expect(result.rejectedClaims).toBeGreaterThan(0);expect(result.dependencies[0]?.executionInput).toBeUndefined();
});

it('retains the original unresolved SDK/config/resource checks alongside a valid input',()=>{
 for(const kind of ['SDK','CONFIG','RESOURCE']){
  const raw=payload() as any;raw.dependencyAnalysis.dependencies.push({...raw.dependencyAnalysis.dependencies[0],key:'fixed-material',kind,executionInput:null});
  expect(analyze(raw).status).toBe('PARTIAL');
 }
});

it('renders an input contract without a production/test data editor or optional label',()=>{
 const html=renderToStaticMarkup(createElement(ExecutionInputDependency,{dependency:analyze().dependencies[0]!}));
 expect(html).toContain('调用时提供');expect(html).toContain('NOT_FOUND');expect(html).toContain('案例工作区文件');
 for(const forbidden of ['<textarea','<input','保存数据','（可选）','尚未确认'])expect(html).not.toContain(forbidden);
});

it('rejects storing invocation values as migration material while allowing contract corrections',async()=>{
 const analysis=analyze(),dep=analysis.dependencies[0]!;let saved:any;
 const project={sourceInspection:{dependencyAnalysis:analysis}} as any;
 const projects={runExclusive:(_id:string,fn:()=>unknown)=>fn(),get:async()=>project,save:async()=>{}} as any;
 const supplements={get:async()=>({revision:0,items:[]}),save:async(_id:string,value:any)=>{saved=value;return {revision:1}},digest:()=> 'new-digest'} as any;
 const service=new MigrationSupplementService(projects,supplements);
 await expect(service.supplementDependency('p',dep.id,{revision:0,value:{production:'value'}})).rejects.toThrow('调用输入请通过');
 expect(saved).toBeUndefined();
 await service.explainDependency('p',dep.id,{revision:0,explanation:'Document the caller input contract, not actual values.'});
 expect(saved.files).toBeDefined();expect(saved.value).toBeUndefined();expect(analysis.status).toBe('PARTIAL');
});
