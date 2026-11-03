import { useState } from 'react';
import type { MigrationWorkbench } from './useMigrationWorkbench';
import type { BundleConfiguration, BundleTask } from '../../../../src/migration/tasks/domain/task-model';
import { SuiteEditor } from './SuiteEditor';
import { MigrationRunView } from './MigrationRunView';
import { sameConfiguration,fitRuntimeTimeout } from './presentation';

/** Original-project baseline uses the same suite editor and evidence report as acceptance. */
export function ProjectBaseline({state}:{state:MigrationWorkbench}) {
  const {task,catalog,api,act,setTask,suite,setSuite,disabled,start}=state;
  const [configuration,setConfiguration]=useState<BundleConfiguration>(task?.baselineConfiguration ?? {
    environmentId:'',modelId:'',timeoutMs:310000,harnessTools:[],
  });
  if (!task?.preparations?.length) return null;
  const runtime=catalog.executionRuntimes.find(item=>item.runtimeId===configuration.environmentId);
  const maxTimeout=runtime?.inspection?.capabilities?.limits.maxTimeoutMs;
  const effectiveConfiguration=fitRuntimeTimeout(configuration,maxTimeout);
  const preparation=task.preparations.at(-1)!;
  const runs=task.runs.filter(run=>run.purpose==='baseline');
  return <section className="stage-secondary-card">
    <h4>原工程业务基线</h4>
    <p>在支持完整工程执行的 Runtime 上运行真实测试，复用统一证据校验与评判。业务案例未通过也能建立基线；运行或评判未完成则不能。</p>
    <div className="bundle-fields">
      <label>基线运行环境<select aria-label="基线运行环境" disabled={disabled} value={configuration.environmentId} onChange={event=>{
        const selected=catalog.executionRuntimes.find(item=>item.runtimeId===event.target.value);
        setConfiguration(current=>fitRuntimeTimeout({...current,environmentId:event.target.value,modelId:selected?.defaultModelId??''},selected?.inspection?.capabilities?.limits.maxTimeoutMs));
      }}><option value="">选择原工程执行环境</option>{catalog.executionRuntimes.map(item=><option value={item.runtimeId} key={item.runtimeId}>{item.name}</option>)}</select></label>
      <label>基线执行模型<select aria-label="基线执行模型" disabled={disabled} value={configuration.modelId} onChange={event=>setConfiguration(current=>({...current,modelId:event.target.value}))}>
        <option value="">选择模型</option>{runtime?.models.map(model=><option value={model.modelId} key={model.modelId}>{model.label??model.modelId}</option>)}
      </select></label>
    </div>
    <SuiteEditor value={suite} onChange={setSuite} disabled={disabled}/>
    <button className="button primary" disabled={disabled || !configuration.environmentId || !configuration.modelId} onClick={()=>void act(async()=>{
      setConfiguration(effectiveConfiguration);
      setTask(await api<BundleTask>(`/api/migration-tasks/${task.id}/baseline-configuration`,{method:'PUT',body:JSON.stringify(effectiveConfiguration)}));
      setTask(await api<BundleTask>(`/api/migration-tasks/${task.id}/suite`,{method:'PUT',body:JSON.stringify(JSON.parse(suite))}));
      await start('baseline');
    })}>运行正式业务基线</button>
    <p>{task.currentBaselineRunId ? '当前准备版本已有完整业务基线。' : '当前准备版本尚无有效业务基线；修改工程、环境、测试集或评判配置后需重新评测。'}</p>
    {runs.map(run=><div key={run.id}>
      {run.id!==task.currentBaselineRunId&&<p>历史或未完成的基线记录，不代表当前版本的有效基线。</p>}
      <MigrationRunView run={run} currentCandidateId={preparation.id} configurationMatches={sameConfiguration(configuration,run.configuration)} disabled={disabled} rescorings={task.rescorings}
        taskId={task.id} allRuns={task.runs} analyses={task.runAnalyses} onAnalyze={()=>void act(async()=>{setTask(await api<BundleTask>(`/api/migration-tasks/${task.id}/analyze-run`,{method:'POST',body:JSON.stringify({runId:run.id})}));})}
        onRescore={repetitions=>void act(async()=>{setTask(await api<BundleTask>(`/api/migration-tasks/${task.id}/rescore`,{method:'POST',body:JSON.stringify({runId:run.id,repetitions})}));})}/>
    </div>)}
  </section>;
}
