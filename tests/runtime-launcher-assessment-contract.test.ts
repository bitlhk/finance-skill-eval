import {describe,expect,it} from 'vitest';
import {runConfigurationSchema} from '../src/shared/contracts/run-configuration.js';

const target={mode:'skill_version' as const,skillId:'wealth-manager-assistant',version:'1.0.0',artifactSha256:'a'.repeat(64)};
const baseline={mode:'without_target_skill' as const,skillId:'wealth-manager-assistant'};

describe('managed Runtime Skill assessment contract',()=>{
  it('accepts a bare-model baseline against a real Skill Agent when model inputs match',()=>{
    const result=runConfigurationSchema.safeParse({
      packId:'wealth',runtime:{type:'runtime_launcher',environmentId:'openjiuwen'},
      evaluationMode:'pairwise',leftVariant:baseline,rightVariant:target,
      leftExecutionModel:{providerId:'runtime',modelId:'same',parameters:{temperature:0,top_p:1,max_tokens:2000}},
      rightExecutionModel:{providerId:'runtime',modelId:'same',parameters:{temperature:0,top_p:1,max_tokens:2000}},
    });
    expect(result.success).toBe(true);
  });

  it('rejects a baseline comparison when model parameters differ',()=>{
    const result=runConfigurationSchema.safeParse({packId:'wealth',runtime:{type:'runtime_launcher',environmentId:'openjiuwen'},
      evaluationMode:'pairwise',leftVariant:baseline,rightVariant:target,
      leftExecutionModel:{providerId:'runtime',modelId:'same',parameters:{temperature:0}},
      rightExecutionModel:{providerId:'runtime',modelId:'same',parameters:{temperature:0.2}}});
    expect(result.success).toBe(false);
    if(!result.success)expect(result.error.issues.map(issue=>issue.message).join('\n')).toContain('同一模型和生成参数');
  });

  it('keeps target-only assessment and comparison between real versions compatible',()=>{
    expect(runConfigurationSchema.safeParse({
      packId:'wealth',runtime:{type:'runtime_launcher',environmentId:'openjiuwen'},
      evaluationMode:'candidate_assessment',leftVariant:baseline,rightVariant:target,
    }).success).toBe(true);
    expect(runConfigurationSchema.safeParse({
      packId:'wealth',runtime:{type:'runtime_launcher',environmentId:'openjiuwen'},
      evaluationMode:'pairwise',leftVariant:{...target,version:'0.9.0',artifactSha256:'b'.repeat(64)},rightVariant:target,
    }).success).toBe(true);
  });
});
