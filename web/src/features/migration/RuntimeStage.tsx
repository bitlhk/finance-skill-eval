import { useState } from 'react';
import type { MigrationWorkbench } from './useMigrationWorkbench';
import type { BundleTask } from '../../../../src/migration/tasks/domain/task-model';
import { BuilderPanel } from './BuilderPanel';
import { MarkdownContent } from '../../MarkdownContent';
import {RuntimeRequirements} from './RuntimeRequirements';
import {runtimeInputIssues} from '../../../../src/migration/tasks/domain/task-runtime-inputs';
import {sameConfiguration,fitRuntimeTimeout} from './presentation';
export function RuntimeStage({ state }: { state: MigrationWorkbench; }) {
  const { catalog, api, task, setTask, setStage, config, setConfig, runtime, act, disabled, current } = state;
  const [showBuilder, setShowBuilder] = useState(["PENDING", "STALE"].includes(task?.builderStatus ?? ""));
  if (!task) return null;
  const effectiveConfig=fitRuntimeTimeout(config,runtime?.inspection?.capabilities?.limits.maxTimeoutMs);
  const configurationSaved=sameConfiguration(config,task.configuration);
  const inputIssues=runtimeInputIssues(task,config,true);
  return (
    <section className="migration-stage">
      <div className="migration-stage-heading"><div><h3>准备运行环境</h3><p>根据迁移结果的依赖与运行要求选择候选环境。保存选择后还需验证，环境已登记不代表满足本次迁移要求。</p></div></div>
      {current && <details className="stage-detail runtime-migration-notes"><summary>查看迁移结果说明</summary><MarkdownContent compact content={current.summary}/></details>}
      <RuntimeRequirements task={{...task,runtimeReviewCurrent:Boolean(task.runtimeReviewCurrent&&configurationSaved)}}/>
      {!!task.analysis?.standardization?.configurationInputs?.length&&<section className="stage-secondary-card"><h4>补充运行配置</h4><p>填写迁移结果实际需要的配置。缺少必填项时仍可查看方案和源码，但不能进行运行验证；填写完成也不代表调用已通过。</p>
        {task.analysis.standardization.configurationGroups?.map((group,index)=><p key={index}>{group.label}：任选一组填写。{group.alternatives.map(option=>option.map(name=>task.analysis!.standardization!.configurationInputs!.find(field=>field.name===name)?.label??name).join('、')).join('；或 ')}</p>)}
        <div className="bundle-fields">{task.analysis.standardization.configurationInputs.map(field=>{const input=config.runtimeInputs?.[field.name];return <label key={field.name}>{field.label}{field.required?'（必填）':task.analysis?.standardization?.configurationGroups?.some(group=>group.alternatives.some(option=>option.includes(field.name)))?'（按配置组选填）':'（可选）'}
          <input disabled={disabled} value={input?('value' in input?input.value:input.secretEnv):''} autoComplete="off" placeholder={field.sensitive?'填写环境中已有的凭证配置名称，不填密钥':field.label} onChange={e=>setConfig(c=>{const values={...c.runtimeInputs};if(!e.target.value.trim())delete values[field.name];else values[field.name]=field.sensitive?{secretEnv:e.target.value}:{value:e.target.value};return {...c,runtimeInputs:values};})}/>
          <small>{field.description}{field.sensitive?'。实际凭证由环境维护者配置，不会写入迁移源码。':''}</small></label>;})}</div>
        {!!inputIssues.length&&<p role="status">{inputIssues.join('；')}</p>}
      </section>}
      <div className="bundle-fields">
        <label>
          候选运行环境
          <select
            aria-label="已登记执行环境"
            value={config.environmentId}
            onChange={(e) => {
              const runtime = catalog.executionRuntimes.find((r) => r.runtimeId === e.target.value);
              setConfig((c) => fitRuntimeTimeout({
                ...c,
                environmentId: e.target.value,
                modelId: runtime?.defaultModelId ?? '',
              },runtime?.inspection?.capabilities?.limits.maxTimeoutMs));
            }}
          >
            <option value="">选择任务执行环境</option>
            {catalog.executionRuntimes.map((r) => (
              <option key={r.runtimeId} value={r.runtimeId}>
                {r.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      <details className="stage-detail" open={Boolean(config.environmentId && !config.modelId)}><summary>高级运行设置</summary>
      <div className="bundle-fields">
        <label>
          执行模型
          <select
            aria-label="执行模型"
            value={config.modelId}
            onChange={(e) => setConfig((c) => ({ ...c, modelId: e.target.value }))}
          >
            <option value="">选择模型</option>
            {runtime?.models.map((m) => (
              <option key={m.modelId} value={m.modelId}>
                {m.label ?? m.modelId}
              </option>
            ))}
          </select>
        </label>
        <label>
          入口指令文件（可选）
          <input
            value={config.entryInstructionsFile ?? ''}
            onChange={(e) =>
              setConfig((c) => ({ ...c, entryInstructionsFile: e.target.value || undefined }))
            }
            placeholder="现有 Agent 业务指令的相对路径"
          />
        </label>
        <label>
          每个案例超时（秒）
          <input
            type="number"
            min={10}
            max={(runtime?.inspection?.capabilities?.limits.maxTimeoutMs??900000)/1000}
            value={effectiveConfig.timeoutMs / 1000}
            onChange={(e) => setConfig((c) => ({ ...c, timeoutMs: Number(e.target.value) * 1000 }))}
          />
        </label>
      </div>
      {!catalog.managedWorkspace && (
        <label className="bundle-checkbox">
          <input
            type="checkbox"
            checked={config.harnessTools.includes('bash')}
            onChange={(e) =>
              setConfig((c) => ({
                ...c,
                harnessTools: e.target.checked
                  ? ['read_file', 'glob', 'list_files', 'bash']
                  : ['read_file', 'glob', 'list_files'],
              }))
            }
          />
          允许执行 Skill 包中的脚本（目标环境需支持）
        </label>
      )}
      <p>
        已有的共享外部 MCP 通过执行环境绑定；包内 MCP
        按迁移产物启动。入口指令仅支持文本业务指令，不执行工作流配置。
      </p>
      </details>
      <button
        className="button primary"
        disabled={disabled || !config.environmentId || !config.modelId || task.candidatePlanCurrent === false}
        onClick={() =>
          void act(async () => {
            setConfig(effectiveConfig);
            setTask(
              await api<BundleTask>('/api/migration-tasks/' + task.id + '/configuration', {
                method: 'PUT',
                body: JSON.stringify(effectiveConfig),
              }),
            );
            setTask(await api<BundleTask>('/api/migration-tasks/'+task.id+'/runtime-review',{method:'POST',body:'{}'}));
          })
        }
      >
        核对所选环境
      </button>
      {configurationSaved&&task.runtimeReviewCurrent&&task.runtimeReview?.status!=='FAILED'&&<button className="button primary" disabled={disabled} onClick={()=>setStage(4)}>下一步：验证能否运行</button>}
      <details className="stage-detail" open={showBuilder} onToggle={event => setShowBuilder(event.currentTarget.open)}><summary>接入其他运行环境</summary><BuilderPanel key={task.id} state={state} /></details>
    </section>
  );
}
