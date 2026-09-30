import { expect, it } from 'vitest';
import { STAGE_ENVELOPE_VERSION, stageEnvelope, staleAgainst } from '../src/migration/domain/migration-stage-envelope.js';

const base = { assetDigest: 'd'.repeat(64), stageId: 'A2' as const, producer: 'AGENT' as const, status: 'PRODUCED' as const, payload: { tools: [] } };

it('refuses a product that cannot say what it was built from', () => {
  // Without the binding there is no way to invalidate the product when its input moves, so the
  // envelope is not allowed to exist in that state.
  expect(() => stageEnvelope({ ...base, assetDigest: '' })).toThrow(/built from/u);
});

it('refuses a stage, producer or status outside the defined sets', () => {
  expect(() => stageEnvelope({ ...base, stageId: 'A9' as never })).toThrow(/unknown stage/u);
  expect(() => stageEnvelope({ ...base, producer: 'SOMEONE' as never })).toThrow(/unknown producer/u);
  expect(() => stageEnvelope({ ...base, status: 'OK' as never })).toThrow(/unknown status/u);
});

it('keeps an abstention distinct from a failure', () => {
  const abstained = stageEnvelope({ ...base, status: 'ABSTAINED', payload: { reason: '读不到源码', missing: ['a.jar'] } });
  expect(abstained.status).toBe('ABSTAINED');
  expect(stageEnvelope({ ...base, status: 'FAILED' }).status).toBe('FAILED');
});

it('stamps the version and the moment, and keeps the binding it was given', () => {
  const envelope = stageEnvelope({ ...base, inputDigests: { asset: 'c'.repeat(64) }, producedAt: '2026-01-01T00:00:00.000Z' });
  expect(envelope.schemaVersion).toBe(STAGE_ENVELOPE_VERSION);
  expect(envelope.binding).toEqual({ assetDigest: base.assetDigest, stageId: 'A2', producer: 'AGENT',
    producedAt: '2026-01-01T00:00:00.000Z', inputDigests: { asset: 'c'.repeat(64) } });
});

it('goes stale when the asset or an upstream product moves, and only then', () => {
  const envelope = stageEnvelope({ ...base, inputDigests: { decisions: 'e'.repeat(64) } });
  expect(staleAgainst(envelope, { asset: base.assetDigest, decisions: 'e'.repeat(64) })).toBeNull();
  expect(staleAgainst(envelope, { asset: 'f'.repeat(64) })).toContain('资产已变化');
  expect(staleAgainst(envelope, { decisions: 'f'.repeat(64) })).toContain('decisions');
  // A digest nobody asked about is not a reason to invalidate anything.
  expect(staleAgainst(envelope, { unrelated: 'f'.repeat(64) })).toBeNull();
});
