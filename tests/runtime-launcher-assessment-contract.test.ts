import {describe,expect,it} from 'vitest';
import {runConfigurationSchema} from '../src/shared/contracts/run-configuration.js';

const target={mode:'skill_version' as const,skillId:'wealth-manager-assistant',version:'1.0.0',artifactSha256:'a'.repeat(64)};
const baseline={mode:'without_target_skill' as const,skillId:'wealth-manager-assistant'};

describe('managed Runtime Skill assessment contract',()=>{
  it('rejects a pairwise request that the Launcher cannot materialize',()=>{
    const result=runConfigurationSchema.safeParse({
      packId:'wealth',runtime:{type:'runtime_launcher',environmentId:'openjiuwen'},
      evaluationMode:'pairwise',leftVariant:baseline,rightVariant:target,
    });
    expect(result.success).toBe(false);
    if(!result.success)expect(result.error.issues.map(issue=>issue.message).join('\n')).toContain('不执行无 Skill 基线');
  });

  it('accepts target-only assessment and a comparison between real versions',()=>{
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
