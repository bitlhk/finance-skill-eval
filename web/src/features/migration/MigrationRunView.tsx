import type { BundleRun } from '../../../../src/migration/tasks/domain/task-model';
import { statusLabels } from './presentation';
export function MigrationRunView({
  run,
  currentCandidateId,
  configurationMatches,
}: {
  run: BundleRun;
  currentCandidateId: string | null;
  configurationMatches: boolean;
}) {
  return (
    <div className="bundle-run">
      <h4>
        {statusLabels[run.status]} · {run.cases.filter((c) => c.passed).length}/
        {run.phase === 'holdout' ? run.suite.holdoutCases?.length : run.suite.cases.length} 个案例通过
      </h4>
      {run.candidateId !== currentCandidateId && (
        <p className="bundle-notice">历史候选的验收记录；当前候选需重新验收。</p>
      )}
      {!configurationMatches && (
        <p className="bundle-notice">Runtime 选择、运行配置、测试集或 Judge 已变化；此记录不能作为当前交付的验收结论。</p>
      )}
      {run.cases.map((c) => (
        <details key={c.id}>
          <summary>
            {c.id} · {c.passed ? '通过' : '未通过'}
          </summary>
          <p>{c.reason}</p>
          <h5>实际输出</h5>
          <pre>{c.evidence?.output ?? '未获得执行结果'}</pre>
          <h5>装载成员</h5>
          <p>{c.evidence?.loadedSkills.map((s) => s.skillId + ' · ' + s.version).join('、') ?? '未采集'}</p>
          <p>Skill 激活证据以工具记录为准，装载不表示每个成员均被调用。</p>
          <details>
            <summary>工具与运行证据</summary>
            <pre>{JSON.stringify(c.evidence, null, 2)}</pre>
          </details>
        </details>
      ))}
    </div>
  );
}
