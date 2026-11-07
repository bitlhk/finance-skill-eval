import type { MigrationWorkbench } from './useMigrationWorkbench';
import { downloadApi } from '../../api-path';
export function ExportStage({ state }: { state: MigrationWorkbench; }) {
  const { task, busy, current, active, act } = state;
  if (!task) return null;
  const basic=task.basicDelivery;
  return (
    <section className="migration-stage">
      <div className="migration-stage-heading"><div><h3>下载迁移结果</h3><p>下载迁移后的 Skill 与运行所需文件，交付前请确认验收状态。</p></div></div>
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
        <button className="button secondary" disabled={!current||!basic||busy||Boolean(active)}
          onClick={()=>void act(()=>downloadApi('/api/migration-tasks/'+task.id+'/export?basic=true','migration-bundle-reviewed-scope.zip'))}>
          下载已审查范围的交付包
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
      <p role="status">{task.verifiedRunId ? '当前版本已通过验收；下载前会再次检查运行环境。' : '当前版本尚未完成正式验收。可以下载当前源码并查看已有的基础验证和效果审查记录。'}</p>
      {task.deliveryVerification&&<p>基础范围：{task.deliveryVerification.basicScope}；效果目标：{task.deliveryVerification.effectGoal}。
        {task.deliveryVerification.rates.target===null?'未设定目标通过率':`目标通过率 ${Math.round(task.deliveryVerification.rates.target*100)}%`}，开发集 {Math.round(task.deliveryVerification.rates.development*100)}%
        {task.deliveryVerification.rates.holdout!==null?`，留出集 ${Math.round(task.deliveryVerification.rates.holdout*100)}%`:''}。</p>}
      {basic&&<p>已审查的基础验证范围：{basic.scope}。该交付不表示效果目标或正式验收已通过。</p>}
      <details><summary>交付检查说明</summary><p>迁移结果、环境、运行配置、测试案例和评审配置须与通过记录一致；设置了独立验收案例时，也需通过独立验收。</p></details>
      {task.analysis?.standardization&&<p>交付包包含工具调用说明、选型依据、审查及逐项验证证据。验收结论仅适用于实际记录的环境与用例，不代表所有框架都已实测。</p>}
    </section>
  );
}
