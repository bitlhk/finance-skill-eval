import { Check, CircleAlert, LoaderCircle } from 'lucide-react';
import type { BundleTask } from "../../../../contracts/platform/responses";
import { stages } from './presentation';
import { migrationProgress } from './progress';

export function MigrationProgress({ task, stage, onSelect, checkingRuntime }: {
  task: BundleTask | null; stage: number; onSelect(stage: number): void; checkingRuntime: boolean;
}) {
  const progress = migrationProgress(task, checkingRuntime);
  return <nav className="migration-progress" aria-label="迁移步骤">
    {stages.map((label, index) => {
      const item = progress[index]!;
      return <button key={label} type="button" title={item.label} className={`${item.status} ${stage === index ? 'active' : 'upcoming'}`}
        aria-current={stage === index ? 'step' : undefined} disabled={!item.available} onClick={() => onSelect(index)}>
        <span className="migration-step-marker" aria-hidden="true">{item.status === 'completed' ? <Check size={14}/> : item.status === 'running' ? <LoaderCircle size={14}/> : item.status === 'attention' ? <CircleAlert size={14}/> : index + 1}</span>
        <span className="migration-step-label">{label}</span>
      </button>;
    })}
  </nav>;
}
