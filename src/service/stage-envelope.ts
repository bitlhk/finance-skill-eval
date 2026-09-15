/**
 * One envelope for every stage product.
 *
 * Before this there were five names for "the asset this was built from" -- `assetDigest`,
 * `artifactSha256`, `candidateDigest`, `baseAssetId`, `digest` -- and a reader had to know which
 * stage they were looking at to know what the field meant. Three rules, from L1 §3.5:
 *
 * 1. **Binding is mandatory.** `binding.assetDigest` is the one name for the asset a product was
 *    built from, and `inputDigests` records the upstream products it consumed.
 * 2. **`ABSTAINED` is a result.** A stage may legitimately decide it cannot proceed; that is not a
 *    failure and must not be flattened into one (or into absence).
 * 3. **A human gate cannot be substituted.** Anything a person produced says so.
 *
 * What it does *not* cover, so nobody looks for it here: the runtime request envelope
 * (`finance.skill-eval.runtime-request.v1`) is the target Host's own contract, and the persisted
 * skill/migration records keep the digests they already had. Those are other people's formats or
 * stored history, not stage hand-offs.
 */
export const STAGE_ENVELOPE_VERSION = "finance.skill-eval.stage-envelope.v1";

export type StageId = "A1" | "A2" | "A3" | "A4";
export type StageProducer = "RULES" | "MODEL" | "AGENT" | "HUMAN";
export type StageStatus = "PRODUCED" | "ABSTAINED" | "FAILED";

export type StageEnvelope<T> = {
  schemaVersion: string;
  binding: {
    assetDigest: string;
    stageId: StageId;
    producer: StageProducer;
    producedAt: string;
    inputDigests: Record<string, string>;
  };
  status: StageStatus;
  trace?: { rounds: Array<Record<string, unknown>> };
  /** Facts about producing it: which model, how long, and why if it did not. */
  run?: { modelId?: string; elapsedMs?: number; error?: string };
  payload: T;
};

const STAGES: readonly StageId[] = ["A1", "A2", "A3", "A4"];
const PRODUCERS: readonly StageProducer[] = ["RULES", "MODEL", "AGENT", "HUMAN"];
const STATUSES: readonly StageStatus[] = ["PRODUCED", "ABSTAINED", "FAILED"];

export function stageEnvelope<T>(input: {
  assetDigest: string;
  stageId: StageId;
  producer: StageProducer;
  status: StageStatus;
  payload: T;
  inputDigests?: Record<string, string>;
  trace?: { rounds: Array<Record<string, unknown>> };
  run?: { modelId?: string; elapsedMs?: number; error?: string };
  producedAt?: string;
}): StageEnvelope<T> {
  // A product that cannot say what it was built from cannot be invalidated when that changes, so
  // the binding is checked here rather than trusted from the caller.
  if (!input.assetDigest) throw new Error("stage envelope requires the asset it was built from");
  if (!STAGES.includes(input.stageId)) throw new Error(`unknown stage: ${input.stageId}`);
  if (!PRODUCERS.includes(input.producer)) throw new Error(`unknown producer: ${input.producer}`);
  if (!STATUSES.includes(input.status)) throw new Error(`unknown status: ${input.status}`);
  return {
    schemaVersion: STAGE_ENVELOPE_VERSION,
    binding: {
      assetDigest: input.assetDigest,
      stageId: input.stageId,
      producer: input.producer,
      producedAt: input.producedAt ?? new Date().toISOString(),
      inputDigests: { ...(input.inputDigests ?? {}) },
    },
    status: input.status,
    ...(input.trace ? { trace: input.trace } : {}),
    ...(input.run ? { run: input.run } : {}),
    payload: input.payload,
  };
}

/**
 * Rule 1, applied: if the asset this product was built from, or any upstream product it consumed,
 * has moved, the product is stale. Returns the reason, or null while it still holds.
 *
 * `current.asset` is compared against the binding; every other key against `inputDigests`. An
 * `inputDigests` entry named `asset` would be a second name for the binding, so it is not allowed.
 */
export function staleAgainst(envelope: StageEnvelope<unknown>, current: Record<string, string>): string | null {
  const { asset, ...upstream } = current;
  if (asset !== undefined && asset !== envelope.binding.assetDigest)
    return `${envelope.binding.stageId} 绑定的资产已变化，产物失效`;
  for (const [name, digest] of Object.entries(envelope.binding.inputDigests)) {
    const now = upstream[name];
    if (now !== undefined && now !== digest) return `${envelope.binding.stageId} 的 ${name} 已变化，产物失效`;
  }
  return null;
}
