import type {MigrationReusePlanner} from '../src/migration/application/migration-reuse-planner.js';

/** Explicit model stand-in for lifecycle tests; never used by live acceptance scripts. */
export const reusePlannerFixture:MigrationReusePlanner=async input=>{
  if(input.mode==='REVIEW'){
    const [path,content]=Object.entries(input.candidateFiles).find(([path])=>path.endsWith('SKILL.md'))!;
    return {status:'REVIEWED',review:{changes:input.design.changes.map(item=>({changeId:item.id,status:'CONFORMING',reason:'Fixture implementation review',evidence:[{path,snippet:content.slice(0,160)}]})),unexpectedDependencies:[],semanticIssues:[]}};
  }
  const [path,content]=Object.entries(input.sourceFiles).find(([path])=>path.endsWith('SKILL.md'))!;
  return {status:'PROPOSED',design:{scope:'声明环境中的测试 Skill',preservedBehavior:['保留输入输出及业务行为'],
    sourceCouplings:[],changes:[{id:'portable-delivery',title:'独立交付 Skill 和工具',implementation:'保留业务逻辑，生成声明依赖的交付包',toolNames:input.inspection.tools.map(tool=>tool.name),evidence:[{path,snippet:content.slice(0,160)}]}],
    dependencies:(input.inspection.dependencyAnalysis?.dependencies??[]).filter(item=>item.action!=='MOVE_TO_RUNTIME').map(item=>({key:item.key,name:item.name,contract:item.purpose,configuration:item.binding?.name??'随包提供'})),
    conditions:['提供交付包声明的运行环境'],unresolvedQuestions:[],acceptanceChecks:[{id:'behavior',purpose:'业务行为保持',procedure:'在独立工作目录运行业务样例',expectedResult:'输出与源样例一致'}]}};
};

export async function approveReuseOverHttp(post:(url:string,payload:unknown)=>Promise<{statusCode:number;json:()=>any}>,id:string){
  const response=await post(`/api/migrations/${id}/plan/proposal`,{});
  if(response.statusCode!==200)throw new Error(JSON.stringify(response.json()));
  const proposal=response.json();
  const result=await post(`/api/migrations/${id}/plan/approval`,{proposalId:proposal.proposalId,inputDigest:proposal.inputDigest});
  if(result.statusCode!==200)throw new Error(JSON.stringify(result.json()));
  return proposal;
}
