import {expect,it} from 'vitest';
import {standardCapabilities,standardMetadata} from './runtime-standard-fixture.js';
import {inspectRuntimeIntake} from '../src/evaluation/application/runtime-intake.js';
import {runtimeFeatureIssues} from '../src/shared/contracts/runtime-intake.js';
import {loadAgentRole} from '../src/agents/composition.js';

it('shares feature checks without requiring optional telemetry or project execution for every runtime',()=>{
  const caps=standardCapabilities('model');
  expect(inspectRuntimeIntake({capabilities:caps})).toMatchObject({compatible:true,execution:'NOT_PROVIDED',businessAcceptance:'NOT_EVALUATED'});
  const expected=runtimeFeatureIssues(caps,['projectExecution','otlpExport']);
  expect(expected).toEqual(['FEATURE_UNAVAILABLE_projectExecution','FEATURE_UNAVAILABLE_otlpExport']);
  expect(inspectRuntimeIntake({capabilities:caps,features:['projectExecution','otlpExport']}).issues).toEqual(expected);
});
it('never treats malformed or incorrectly correlated execution as an accepted runtime',()=>{
  const caps=standardCapabilities('model');
  const evidence={runId:'run',caseId:'case',side:'right',status:'completed',modelId:'model',skillVersion:null,output:'ok',elapsedMs:1,error:null,runtimeIdentityVerified:true,streamCompleted:true,metadata:standardMetadata};
  expect(inspectRuntimeIntake({capabilities:caps,evidence}).issues).toContain('execution.expected-identity-missing');
  expect(inspectRuntimeIntake({capabilities:caps,evidence,identity:{runId:'other',caseId:'case',side:'right'}}).issues).toContain('execution.correlation');
  expect(inspectRuntimeIntake({capabilities:caps,evidence,identity:{runId:'run',caseId:'case',side:'right'}})).toMatchObject({compatible:true,execution:'VERIFIED',businessAcceptance:'NOT_EVALUATED'});
});
it('loads the common intake contract into the engineering preparation Agent',()=>{
  const role=loadAgentRole('runtime-preparation');
  expect(role.resources.some(r=>r.path==='references/runtime-integration.md')).toBe(true);
  expect(role.systemPrompt).toContain('不要求 OTLP');
  expect(role.definition.writeScope).toBe('candidate');
});
