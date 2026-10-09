import {expect,it,vi} from 'vitest';
import {MigrationTechnicalValidationWorkflow} from '../src/migration/application/migration-technical-validation-service.js';
import {LocalMigrationValidationRunner} from '../src/migration/infrastructure/migration-technical-validator.js';
import {startService} from '../src/service/service-launch.js';
import {validateMcpTool} from '../src/mcp-preflight.js';
vi.mock('../src/service/service-launch.js',()=>({startService:vi.fn()}));
vi.mock('../src/mcp-preflight.js',()=>({validateMcpTool:vi.fn()}));

it('reuses private user-supplied technical inputs for isolated candidates without copying them into public records',async()=>{
  const secret='PRIVATE_BUSINESS_TEST_ACCOUNT';
  const project:any={id:'migration-1234',source:{assetId:'source'},candidate:{assetId:'base',artifactSha256:'base-digest'},
    inspection:{tools:[{toolId:'lookup',name:'lookup',kind:'SCRIPT',samples:[],inputSchema:{type:'object',required:['account'],properties:{account:{type:'string'}}}}]}};
  const config:any={revision:0,values:{},checks:[]};
  const projects:any={get:async()=>project,save:async()=>{},runExclusive:async(_id:string,fn:()=>Promise<unknown>)=>fn()};
  const configs:any={get:async()=>config,saveValidationInput:async(_id:string,key:string,value:unknown)=>{(config.validationInputs??={})[key]=value}};
  const runner:any={validateScript:vi.fn(async({request,asset}:any)=>{
    expect(request).toEqual({account:secret});return {validationId:'check',toolId:'lookup',status:'PASSED',assetDigest:asset.artifactSha256,stages:[]};
  })};
  const service=new MigrationTechnicalValidationWorkflow(projects,{readArchive:async()=>({})} as any,configs,runner);
  await service.validate(project.id,{toolId:'lookup',baseAssetId:'base',request:{account:secret}});
  const result=await service.validateIsolated(project.id,{assetId:'trial',artifactSha256:'trial-digest'} as any,'lookup');
  expect(result.status).toBe('PASSED');expect(runner.validateScript).toHaveBeenCalledTimes(2);
  expect(config.validationInputs.lookup.account).toBe(secret);
  expect(JSON.stringify(project)).not.toContain(secret);expect(JSON.stringify(result)).not.toContain(secret);
  expect(project.technicalValidations).toHaveLength(1);
});

it('provides an isolated per-request MCP workspace and cleans it up without exposing the service package',async()=>{
  const disposeCode=vi.fn(async()=>{}),disposeExecution=vi.fn(async()=>{}),stop=vi.fn(async()=>{});
  const open=vi.fn().mockResolvedValueOnce({directory:'package-root',dispose:disposeCode})
    .mockResolvedValueOnce({directory:'isolated-task-root',dispose:disposeExecution});
  vi.mocked(startService).mockResolvedValue({ok:true,running:{endpoint:'http://127.0.0.1:9876/mcp',stop}} as any);
  vi.mocked(validateMcpTool).mockResolvedValue({status:'ready',tools:[{name:'lookup',inputSchema:{type:'object'}}],callResult:{},error:null} as any);
  const runner=new LocalMigrationValidationRunner({open} as any);
  const input:any={asset:{assetId:'candidate',artifactSha256:'digest'},tool:{toolId:'lookup',name:'lookup',sourcePaths:['server.py']},
    archive:{'server.py':Buffer.from('code'),'workspace/data.json':Buffer.from('not task data')},service:{start:['python','server.py']},
    headers:{'x-workspace-root':'untrusted-root','X-Business-Context':'private-context'},arguments:{account:'example'}};
  const result=await runner.validateMcp(input);expect(result.status).toBe('PASSED');
  expect(open.mock.calls[1]).toEqual([[]]);
  expect(vi.mocked(validateMcpTool).mock.calls.at(-1)?.[0].headers).toEqual({'X-Workspace-Root':'isolated-task-root','X-Business-Context':'private-context'});
  expect(disposeExecution).toHaveBeenCalledOnce();expect(disposeCode).toHaveBeenCalledOnce();expect(stop).toHaveBeenCalledOnce();
  expect(JSON.stringify(result)).not.toContain('private-context');
});
