import {describe,it,expect} from 'vitest';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {RuntimeAdaptationStep} from '../web/src/MigrationPanel';

describe('runtime adaptation delivery controls',()=>{
  const binding=(environmentId:string)=>({environmentId,buildId:`build-${environmentId}`,requestId:'request',deploymentId:'deployment',artifactSha256:'artifact',capabilitiesDigest:'capabilities',resultDigest:`result-${environmentId}`,builder:{name:'Builder',version:'1'},acceptedAt:'2026-10-01T00:00:00Z',expiresAt:null});
  const runtimes=['openjiuwen','agentscope'].map(runtimeType=>({runtimeId:runtimeType,launcherEnvironmentId:runtimeType,runtimeType,name:runtimeType,models:[]}));
  function view(deliveries:Record<string,ReturnType<typeof binding>>,last?:ReturnType<typeof binding>){
    return renderToStaticMarkup(createElement(RuntimeAdaptationStep,{
      capabilities:[],deliveries,delivery:last,runtimes:runtimes as never,projectId:'project',trustReferences:[{reference:'managed',label:'Managed',baseUrlPrefix:'http://localhost'}],busy:false,importResult:async()=>{},next:()=>{},
    }));
  }
  it('keeps import and both target choices after first delivery clears requirements',()=>{
    const html=view({openjiuwen:binding('openjiuwen')});
    expect(html).toContain('Builder Result JSON');
    expect(html).toContain('验收并登记 Launcher');
    expect(html).toContain('value="agentscope"');
    expect(html).toContain('value="openjiuwen"');
    expect(html).toContain('build-openjiuwen');
    expect(html).toContain('尚未登记项目交付');
  });
  it('shows both independent results after second delivery and reload',()=>{
    const html=view({openjiuwen:binding('openjiuwen'),agentscope:binding('agentscope')},binding('agentscope'));
    expect(html).toContain('result-openjiuwen');
    expect(html).toContain('result-agentscope');
    expect(html).not.toContain('尚未登记项目交付');
    expect(html).toContain('Builder Result JSON');
  });
  it('retains legacy delivery and labels unavailable environments without guessing Runtime',()=>{
    const html=view({},binding('retired'));
    expect(html).toContain('build-retired');
    expect(html).toContain('无法确认所属 Runtime');
  });
});
