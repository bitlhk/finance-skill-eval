import type { MigrationWorkbench } from './useMigrationWorkbench';
import { downloadApi } from '../../api-path';
export function ExportStage({ state }: { state: MigrationWorkbench; }) {
  const { task, busy, current, active, act } = state;
  if (!task) return null;
  return (
    <section className="stage-section">
      <h3>交付结果</h3>
      <p>包含全部 Skill、共享文件、版本清单和有效验收报告。部署状态由目标环境另行确认。</p>
      <div className="bundle-actions">
        <button
          className="button secondary"
          disabled={!current || busy}
          onClick={() =>
            void act(() =>
              downloadApi(
                '/api/migration-tasks/' + task.id + '/export',
                'migration-bundle-candidate.zip',
              ),
            )
          }
        >
          下载候选源码
        </button>
        <button
          className="button primary"
          disabled={!current || !task.verifiedRunId || busy || Boolean(active)}
          onClick={() =>
            void act(() =>
              downloadApi(
                '/api/migration-tasks/' + task.id + '/export?verified=true',
                'migration-bundle-verified.zip',
              ),
            )
          }
        >
          下载已验收交付包
        </button>
      </div>
      <p role="status">{task.verifiedRunId ? '当前版本已有有效验收记录；下载时还会核对 Runtime 在线状态。' : '当前版本尚无有效验收记录，请完成联合验收。'}</p>
      <p>已验收交付要求当前候选、Runtime、运行配置、测试集和 Judge 与通过记录一致；有留出集时需留出验收通过。</p>
    </section>
  );
}
