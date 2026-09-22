import {CheckCircle2,Clock3,AlertCircle,ChevronRight} from 'lucide-react';

export type GenerationEvidence={toolId:string;readyForValidation:boolean;callExecuted?:boolean;runtimeDependenciesPending?:string[];checks?:Array<{name:string;passed:boolean;message:string}>};
export function generatedCallState(g:GenerationEvidence):'PASSED'|'PENDING'|'UNKNOWN'{
 if(g.callExecuted===true)return 'PASSED';
 if(g.callExecuted===false||g.checks?.some(check=>/尚未执行|待验证|待测试|需准备测试依赖/u.test(check.message)))return 'PENDING';
 return 'UNKNOWN';
}

export function GenerationStatus({generation:g,latest,configure}:{generation:GenerationEvidence;latest?:{status:'PASSED'|'FAILED'};configure?:()=>void}){
 const state=latest?.status??generatedCallState(g);
 return <div className="generation-evidence">
  <p>{g.readyForValidation?'迁移代码已生成。':'已生成工具工程，请先完成代码中的待办。'}</p>
  <p className={`generation-status ${state==='PASSED'?'passed':state==='FAILED'?'failed':'pending'}`}>
   {state==='PASSED'?<CheckCircle2 size={16}/>:state==='FAILED'?<AlertCircle size={16}/>:<Clock3 size={16}/>}
   <strong>{state==='PASSED'?'业务调用已通过':state==='FAILED'?'最近一次业务调用失败':state==='PENDING'?'业务调用待验证':'业务调用状态未记录'}</strong>
  </p>
  {state!=='PASSED'&&<p>{state==='FAILED'?'修正测试配置或代码后重新试运行。':state==='PENDING'?'生成阶段未执行实际业务调用，请准备测试输入和所需依赖后试运行。':'这条旧记录没有明确保存实际调用结果，请重新试运行确认。'}</p>}
  {!!g.runtimeDependenciesPending?.length&&state!=='PASSED'&&<p>测试所需依赖：{g.runtimeDependenciesPending.join('、')}。已保存的测试配置可直接复用。</p>}
  {g.checks?.filter(check=>check.name!=='JSON_SMOKE').map(check=><p className={`generation-status ${check.passed?'passed':'failed'}`} key={check.name}>{check.passed?<CheckCircle2 size={16}/>:<AlertCircle size={16}/>}代码检查：{check.message}</p>)}
  {g.checks?.filter(check=>check.name==='JSON_SMOKE').map(check=><p className={`generation-status ${generatedCallState(g)==='PASSED'&&check.passed?'passed':'pending'}`} key={check.name}>{generatedCallState(g)==='PASSED'&&check.passed?<CheckCircle2 size={16}/>:<Clock3 size={16}/>}生成阶段检查：{check.message}</p>)}
  {configure&&g.readyForValidation&&<button className="button secondary" onClick={configure}>{state==='PASSED'?'再次试运行':'配置并试运行'}<ChevronRight size={16}/></button>}
 </div>;
}
