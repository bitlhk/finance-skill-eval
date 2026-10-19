import type { MigrationWorkbench } from './useMigrationWorkbench';
import type { BundleTask } from '../../../../src/migration/tasks/domain/task-model';
import { BuilderPanel } from './BuilderPanel';
export function RuntimeStage({ state }: { state: MigrationWorkbench; }) {
  const { catalog, api, task, setTask, setStage, config, setConfig, runtime, act, disabled } = state;
  if (!task) return null;
  return (
    <section className="stage-section">
      <h3>整组运行配置</h3>
      <div className="bundle-fields">
        <label>
          已登记执行环境
          <select
            aria-label="已登记执行环境"
            value={config.environmentId}
            onChange={(e) => {
              const runtime = catalog.executionRuntimes.find((r) => r.runtimeId === e.target.value);
              setConfig((c) => ({
                ...c,
                environmentId: e.target.value,
                modelId: runtime?.defaultModelId ?? '',
              }));
            }}
          >
            <option value="">选择支持多 Skill 的环境</option>
            {catalog.executionRuntimes.map((r) => (
              <option key={r.runtimeId} value={r.runtimeId}>
                {r.name}
              </option>
            ))}
          </select>
        </label>
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
            max={900}
            value={config.timeoutMs / 1000}
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
      <button
        className="button primary"
        disabled={disabled || !config.environmentId || !config.modelId}
        onClick={() =>
          void act(async () => {
            setTask(
              await api<BundleTask>('/api/migration-tasks/' + task.id + '/configuration', {
                method: 'PUT',
                body: JSON.stringify(config),
              }),
            );
            setStage(4);
          })
        }
      >
        保存运行配置
      </button>
      <BuilderPanel key={task.id} state={state} />
    </section>
  );
}
