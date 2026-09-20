import { expect, it, vi } from 'vitest';
import { OptimizationManager } from '../src/service/optimization-manager.js';
import { readJson, writeJsonAtomic } from '../src/service/file-store.js';

vi.mock('../src/service/file-store.js', () => ({
  readJson: vi.fn(), writeJsonAtomic: vi.fn(), ensureDirectory: vi.fn(), listJsonFiles: vi.fn(),
}));

it('does not overwrite completion when a live task finishes during a stale read', async () => {
  const manager = new OptimizationManager({ dataDirectory: '/unused' } as ConstructorParameters<typeof OptimizationManager>[0]);
  const active = (manager as unknown as { active: Map<string, AbortController> }).active;
  active.set('opt-abcd', new AbortController());
  vi.mocked(readJson).mockImplementationOnce(async () => {
    active.delete('opt-abcd');
    return { optimizationId: 'opt-abcd', status: 'reevaluating' };
  });
  expect((await manager.get('opt-abcd')).status).toBe('reevaluating');
  expect(writeJsonAtomic).not.toHaveBeenCalled();
});

it('still marks an orphaned task interrupted after a restart', async () => {
  const manager = new OptimizationManager({ dataDirectory: '/unused' } as ConstructorParameters<typeof OptimizationManager>[0]);
  vi.mocked(readJson).mockResolvedValueOnce({ optimizationId: 'opt-abcd', status: 'reevaluating' });
  expect((await manager.get('opt-abcd')).status).toBe('failed');
  expect(writeJsonAtomic).toHaveBeenCalled();
});
