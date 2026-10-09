/** Deterministic UI control regression only; live acceptance must use configured models. */
export async function reusePlanFixture(input){
  const files=input.mode==='PROPOSE'?input.sourceFiles:input.candidateFiles;
  const [path,content]=Object.entries(files).find(([path])=>path.endsWith('SKILL.md'));
  const evidence=[{path,snippet:content.slice(0,180)}];
  if(input.mode==='REVIEW')return {status:'REVIEWED',review:{changes:input.design.changes.map(change=>({changeId:change.id,status:'CONFORMING',reason:'UI fixture review',evidence})),unexpectedDependencies:[],semanticIssues:[]}};
  return {status:'PROPOSED',design:{scope:'UI 控制回归中的独立 Skill 包',preservedBehavior:['保留夹具业务行为'],sourceCouplings:[],
    changes:[{id:'package',title:'独立交付',implementation:'按选择生成 Skill 和工具包',toolNames:input.inspection.tools.map(tool=>tool.name),evidence}],
    dependencies:(input.inspection.dependencyAnalysis?.dependencies??[]).filter(d=>d.action!=='MOVE_TO_RUNTIME').map(d=>({key:d.key,name:d.name,contract:d.purpose,configuration:d.binding?.name??'随包提供'})),
    conditions:['提供声明的运行环境'],unresolvedQuestions:[],acceptanceChecks:[{id:'control',purpose:'UI 控制链路',procedure:'完成本脚本的控制回归',expectedResult:'各界面操作正确'}]}};
}
