import {EventEmitter} from 'node:events';
import {PassThrough,Writable} from 'node:stream';
import {spawn as realSpawn,execFileSync} from 'node:child_process';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {ContainerMigrationValidationRunner,migrationSandboxSchema} from '../src/migration/infrastructure/container-migration-validator.js';
import {toolFixture} from './analysis-fixture.js';
import type {SkillAssetRecord} from '../src/shared/contracts/skill-asset.js';

vi.mock('node:child_process',async original=>{
  const actual=await original<typeof import('node:child_process')>();
  return {...actual,spawn:vi.fn(actual.spawn)};
});
const spawnMock=vi.mocked(realSpawn);
const asset:SkillAssetRecord={schemaVersion:'finance.skill-eval.skill-asset.v1',assetId:'asset-trial',skillId:'trial',
  version:'1',displayName:'trial',description:'synthetic',sourceType:'uploaded',artifactSha256:'a'.repeat(64),
  skillFile:'SKILL.md',fileCount:1,createdAt:'2026-10-12T00:00:00Z'};
const tool=toolFixture({name:'trial',kind:'SCRIPT',sourcePaths:['scripts/run.mjs'],entrypoint:{kind:'NODE',path:'scripts/run.mjs'}});
const config=migrationSandboxSchema.parse({image:'sha256:'+'b'.repeat(64),timeoutMs:1000});
const input={asset,tool,archive:{'scripts/run.mjs':Buffer.from('console.log("{}")')},request:{value:1}};
let behavior:'success'|'stall'|'mismatch'|'output-limit'|'error'='success';
let sent:unknown;
beforeEach(()=>{
  behavior='success';sent=undefined;
  spawnMock.mockImplementation(((program:string,args:string[])=>{
    expect(program).toBe('docker');
    const child=new EventEmitter() as any;
    child.stdout=new PassThrough();child.stderr=new PassThrough();
    child.kill=vi.fn(()=>{queueMicrotask(()=>child.emit('close',137));return true;});
    child.stdin=new Writable({write(chunk,_encoding,done){
      sent=JSON.parse(String(chunk));done();
      queueMicrotask(()=>{
        if(behavior==='stall')return;
        if(behavior==='error'){child.emit('error',new Error('PRIVATE_TEST_TOKEN'));return;}
        child.stdout.write(behavior==='output-limit'?'x'.repeat(1024*1024+1):JSON.stringify({
          validationId:'technical-synthetic',toolId:tool.toolId,assetId:asset.assetId,
          assetDigest:behavior==='mismatch'?'wrong':asset.artifactSha256,implementationDigest:'implementation',casesDigest:'cases',
          mode:'LOCAL_TRUSTED',status:'PASSED',startedAt:'now',finishedAt:'now',stages:[],error:null,
        }));
        child.emit('close',0);
      });
    }});
    if(args[0]==='rm')queueMicrotask(()=>child.emit('close',0));
    return child;
  }) as typeof realSpawn);
});
afterEach(()=>{spawnMock.mockReset();vi.unstubAllEnvs();});
const removals=()=>spawnMock.mock.calls.filter(([,args])=>args?.[0]==='rm');

it('keeps host state and test secrets out of the container arguments',async()=>{
  vi.stubEnv('HOST_SENTINEL','PRIVATE_HOST_VALUE');
  const runner=new ContainerMigrationValidationRunner(config);
  const result=await runner.validateScript(input);
  expect(result.mode).toBe('ISOLATED_CONTAINER');expect(result.status).toBe('PASSED');
  const args=spawnMock.mock.calls[0]![1] as string[];
  expect(args).toEqual(expect.arrayContaining(['--read-only','--cap-drop=ALL','no-new-privileges','--pids-limit','128','--network','none']));
  expect(args).not.toContain('--volume');expect(args).not.toContain('--publish');expect(args.join(' ')).not.toContain('PRIVATE_HOST_VALUE');
  expect(sent).toMatchObject({kind:'SCRIPT',input:{archive:{'scripts/run.mjs':Buffer.from('console.log("{}")').toString('base64')}}});
  expect(removals()).toHaveLength(3);
});

it('passes only per-project business configuration through stdin',async()=>{
  const runner=new ContainerMigrationValidationRunner(config);
  await runner.validateMcp({...input,service:{start:['node','mcp/server.mjs']},headers:{Authorization:'Bearer synthetic-only'},environment:{BUSINESS_SERVICE_URL:'https://business.example'}});
  expect(sent).toMatchObject({kind:'MCP',input:{headers:{Authorization:'Bearer synthetic-only'},environment:{BUSINESS_SERVICE_URL:'https://business.example'}}});
  expect(JSON.stringify(spawnMock.mock.calls)).not.toContain('synthetic-only');
});

it.each(['host','bridge','default','container:other','--privileged'])('rejects shared or injected network mode %s',network=>{
  expect(()=>migrationSandboxSchema.parse({...config,network})).toThrow();
});
it('requires an immutable image and rejects arbitrary external MCP endpoints',()=>{
  expect(()=>migrationSandboxSchema.parse({...config,image:'sandbox:latest'})).toThrow();
  const runner=new ContainerMigrationValidationRunner(config);
  expect(()=>runner.validateMcp({...input,endpoint:'http://127.0.0.1:9999/mcp'})).toThrow('不连接外部');
  expect(spawnMock).not.toHaveBeenCalled();
});

it.each(['mismatch','error','output-limit'] as const)('fails closed and cleans up on %s without exposing diagnostics',async value=>{
  behavior=value;
  await expect(new ContainerMigrationValidationRunner(config).validateScript(input)).rejects.toThrow('隔离试运行未完成');
  expect(removals()).toHaveLength(3);
});

it('bounds shared concurrency and removes a timed-out container before releasing its slot',async()=>{
  behavior='stall';const runner=new ContainerMigrationValidationRunner(config);
  const first=runner.validateScript(input);const failed=expect(first).rejects.toThrow('隔离试运行未完成');
  await expect(runner.validateScript(input)).rejects.toMatchObject({statusCode:429});
  await failed;expect(removals()).toHaveLength(3);
  behavior='success';expect((await runner.validateScript(input)).status).toBe('PASSED');
});

it('cleans up cancellation and shutdown, and does not execute a pre-cancelled request',async()=>{
  behavior='stall';const runner=new ContainerMigrationValidationRunner(config),controller=new AbortController();
  const first=runner.validateScript({...input,signal:controller.signal});const failed=expect(first).rejects.toThrow('cancelled');
  controller.abort(new Error('cancelled'));await failed;expect(removals()).toHaveLength(3);
  spawnMock.mockClear();await expect(runner.validateScript({...input,signal:controller.signal})).rejects.toThrow('cancelled');
  expect(spawnMock).not.toHaveBeenCalled();
  const second=runner.validateScript(input);const stopped=expect(second).rejects.toThrow('shutting down');
  await runner.close();await stopped;expect(()=>runner.validateScript(input)).toThrow('正在关闭');
});

it.skipIf(!process.env.FINANCE_EVAL_TEST_SANDBOX_IMAGE)('runs a real isolated container and removes successful and timed-out trials',async()=>{
  const actual=await vi.importActual<typeof import('node:child_process')>('node:child_process');
  spawnMock.mockImplementation(actual.spawn);
  const image=process.env.FINANCE_EVAL_TEST_SANDBOX_IMAGE!;
  vi.stubEnv('HOST_SENTINEL','should-not-enter-container');
  const source=`import assert from 'node:assert/strict';import fs from 'node:fs';
    assert.equal(process.getuid(),1000);assert.equal(process.env.HOST_SENTINEL,undefined);
    assert.equal(fs.existsSync('/var/run/docker.sock'),false);
    assert.throws(()=>fs.writeFileSync('/app/host-write','no'));
    fs.writeFileSync('/tmp/trial-write','yes');
    const {createConnection}=await import('node:net');
    await new Promise((resolve,reject)=>{const socket=createConnection({host:'1.1.1.1',port:443});
      socket.on('connect',()=>{socket.destroy();reject(new Error('Unexpected egress'));});
      socket.on('error',()=>{socket.destroy();resolve();});
      socket.setTimeout(1000,()=>{socket.destroy();resolve();});});
    console.log(JSON.stringify({ok:true}));`;
  const runner=new ContainerMigrationValidationRunner({...config,image,timeoutMs:30000});
  const result=await runner.validateScript({...input,archive:{'scripts/run.mjs':Buffer.from(source)}});
  expect(result.status,result.error??'').toBe('PASSED');expect(result.mode).toBe('ISOLATED_CONTAINER');
  const mcpSource=`import {createServer} from 'node:http';
    createServer(async(req,res)=>{let raw='';for await(const chunk of req)raw+=chunk;
      const body=JSON.parse(raw);
      if(!body.id){res.writeHead(202);res.end();return;}
      const result=body.method==='initialize'?{protocolVersion:'2025-06-18',serverInfo:{name:'isolated-test'}}:
        body.method==='tools/list'?{tools:[{name:${JSON.stringify(tool.name)},inputSchema:{type:'object'}}]}:
        {content:[{type:'text',text:'ok'}],isError:req.headers.authorization!=='Bearer synthetic-only'||process.env.BUSINESS_SERVICE_URL!=='https://business.example'};
      res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({jsonrpc:'2.0',id:body.id,result}));
    }).listen(Number(process.env.PORT),'127.0.0.1');`;
  const mcp=await runner.validateMcp({...input,tool:{...tool,kind:'MCP'},archive:{'mcp/server.mjs':Buffer.from(mcpSource)},
    service:{start:['node','mcp/server.mjs']},headers:{Authorization:'Bearer synthetic-only'},environment:{BUSINESS_SERVICE_URL:'https://business.example'}});
  expect(mcp.status,mcp.error??'').toBe('PASSED');expect(mcp.stages.find(stage=>stage.name==='TOOLS_CALL')?.passed).toBe(true);
  const slow=new ContainerMigrationValidationRunner({...config,image,timeoutMs:1000});
  await expect(slow.validateScript({...input,archive:{'scripts/run.mjs':Buffer.from('setInterval(()=>{},1000)')}})).rejects.toThrow();
  for(const [,args] of spawnMock.mock.calls){
    if(args?.[0]!=='run')continue;
    const name=args[args.indexOf('--name')+1]!;
    expect(execFileSync('docker',['ps','-a','--filter',`name=^/${name}$`,'--format','{{.Names}}'],{encoding:'utf8'}).trim()).toBe('');
  }
},60000);
