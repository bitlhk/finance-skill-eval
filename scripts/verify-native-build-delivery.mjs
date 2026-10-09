import assert from 'node:assert/strict';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {EnvironmentStore} from '../dist/service/environment-store.js';
import {withRequirementsDigest} from '../dist/shared/contracts/runtime-builder.js';

const info=JSON.parse(await readFile(process.env.LAUNCHER_FIXTURE_INFO,'utf8'));
const output=process.env.LAUNCHER_UI_OUTPUT;await mkdir(output,{mode:0o700});
process.env.NATIVE_DELIVERY_TEST_TOKEN=info.token;
const reports=[];
for(const alias of ['oj','as']){
  const baseUrl=new URL(alias+'/',info.baseUrl).toString(),spec=info.runtimes[alias];
  const call=async(route,body,method=body?'POST':'GET')=>{
    const r=await fetch(new URL(route,baseUrl),{method,headers:{authorization:`Bearer ${info.token}`,'content-type':'application/json','idempotency-key':randomUUID()},
      ...(body?{body:JSON.stringify(body)}:{})});const value=await r.json();assert(r.ok,JSON.stringify(value));return value;
  };
  const catalog=await call('v1/native-tool-catalog');
  const protocols={capabilities:'finance.skill-eval.runtime-capabilities.v1',instance:'finance.skill-eval.runtime-instance.v1',execution:'finance.skill-eval.runtime-case.v1',observation:'finance.runtime-observation.v1'};
  const requirements=withRequirementsDigest({schemaVersion:'finance.runtime-build-requirements.v1',requestId:randomUUID(),
    source:{assetId:info.skill.skillId,artifactSha256:info.skill.artifactSha256},target:{runtimeType:spec.runtime.type,protocols},
    requiredCapabilities:catalog.contracts.map(c=>({id:c.capabilityId,name:c.nativeToolNames[0],required:true,reason:'Explicit admitted tool binding',
      contract:c.contract,constraints:c.constraints,preferredTargetCapability:c.capabilityId,consumerTools:c.nativeToolNames,evidence:[{path:'SKILL.md',line:1,detail:'Read-only native conformance fixture'}]}))});
  const variant={mode:'skill_version',skillId:info.skill.skillId,version:info.skill.version,artifactSha256:info.skill.artifactSha256};
  let build;
  try{
    build=await call('v1/runtime-builds',{requirements,instanceRequest:{schemaVersion:'finance.skill-eval.runtime-instance.v1',runId:randomUUID(),side:'right',modelId:info.modelId,
      variant,skill:info.skill,environment:{requiredToolNames:spec.requiredToolNames},configuration:{},secrets:{mode:'inline',values:{}},limits:{timeoutMs:300000}}});
    const deadline=Date.now()+360000;
    while(!build.result&&Date.now()<deadline){await new Promise(r=>setTimeout(r,1000));build=await call(`v1/runtime-builds/${build.buildId}`)}
    assert.equal(build.result?.status,'SUCCEEDED',JSON.stringify(build.result?.errors));
    const store=new EnvironmentStore(path.join(output,alias),[{reference:'local',label:'Isolated fixture',baseUrlPrefix:baseUrl,credentialEnv:'NATIVE_DELIVERY_TEST_TOKEN'}]);
    await store.initialize();
    const accepted=await store.acceptBuilderDelivery({requirements,result:build.result,trustReference:'local',conformance:{skill:info.skill,requiredTools:spec.requiredToolNames}});
    assert.equal(accepted.environment.delivery.evalConformance.status,'PASSED');
    reports.push({runtime:spec.runtime,buildResult:build.result,accepted:accepted.environment});
  }finally{if(build)await call(`v1/runtime-builds/${build.buildId}`,undefined,'DELETE')}
}
await writeFile(path.join(output,'report.json'),JSON.stringify({status:'PASS',scope:'ACTUAL_BUILD_AND_EVAL_LIFECYCLE_ADMISSION',reports},null,2),{mode:0o600});
