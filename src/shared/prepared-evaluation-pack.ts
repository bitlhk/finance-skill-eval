import type { EvalPack,ModelRef } from '../contracts.js';
import { fingerprint } from '../contracts.js';
import type { PreparedEvaluation } from './contracts/prepared-evaluation.js';

export function buildPreparedEvaluationPack(input:{
  preparation:PreparedEvaluation;
  analyzerModel:ModelRef;
  executionModel:ModelRef;
  judgeModel:ModelRef;
  sourceFile:string;
}):EvalPack {
  const packFile={
    schemaVersion:'finance.skill-eval.pack.v1' as const,
    packId:`uploaded-${input.preparation.preparationId}`,
    version:'1.0.0',domain:'uploaded-skill',targetSkillId:input.preparation.skillId,
    targetSkillVersion:input.preparation.skillVersion,description:input.preparation.summary,
    models:{analyzer:input.analyzerModel,execution:{left:input.executionModel,right:input.executionModel},judge:input.judgeModel},
    variants:{left:{mode:'without_target_skill' as const,skillId:input.preparation.skillId},right:{mode:'skill_version' as const,skillId:input.preparation.skillId,version:input.preparation.skillVersion}},
    judgeProfileFile:'generated',caseFiles:[],metadata:{source:input.preparation.source,preparationId:input.preparation.preparationId,
      ...(input.preparation.assessmentMode?{assessmentMode:input.preparation.assessmentMode}:{}),
      ...(input.preparation.comparisonOnly?{comparisonOnly:'true'}:{})},
  };
  const judgeProfile={
    schemaVersion:'finance.skill-eval.judge-profile.v1' as const,profileId:'generic-finance-skill-value-judge',version:'1.0.0',reviewerLabel:'金融 Skill 专业价值 Judge',
    domainInstructions:['判断 Skill 是否实质提升专业判断，而不是只增加篇幅或规则复述。','重点比较业务问题识别、结果完整性、表达清晰度和下一步可执行性。','没有来源的事实、数字或工具执行结果不得获得奖励。'].join('\n'),
    dimensions:[
      {id:'professional_fit' as const,label:'专业匹配度',description:'是否体现岗位专业判断'},
      {id:'business_completeness' as const,label:'业务完整性',description:'是否覆盖任务所需闭环'},
      {id:'clarity' as const,label:'结构与清晰度',description:'是否易于理解和使用'},
      {id:'actionability' as const,label:'可执行性',description:'是否形成明确下一步'},
    ],
  };
  return {...packFile,sourceFile:input.sourceFile,cases:input.preparation.cases,holdoutCases:input.preparation.holdoutCases??[],judgeProfile,
    packFingerprint:fingerprint({pack:packFile,cases:input.preparation.cases,holdoutCases:input.preparation.holdoutCases??[],judgeProfile})};
}
