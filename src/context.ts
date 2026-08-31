import type {
  EvaluationContextAdapter,
  EvaluationContextRequest,
} from "./adapters.js";
import {
  evaluationContextPayloadSchema,
  evaluationContextSnapshotSchema,
  fingerprint,
  type EvaluationContextSnapshot,
} from "./contracts.js";

export async function resolveEvaluationContext(input: {
  adapter?: EvaluationContextAdapter;
  request: EvaluationContextRequest;
}): Promise<EvaluationContextSnapshot | null> {
  if (!input.adapter) return null;
  const loaded = await input.adapter.load(input.request);
  if (!loaded) return null;
  const payload = evaluationContextPayloadSchema.parse(loaded);
  const body = {
    ...payload,
    schemaVersion: "finance.skill-eval.context-snapshot.v1" as const,
    providerId: input.adapter.adapterId,
  };
  return evaluationContextSnapshotSchema.parse({
    ...body,
    snapshotFingerprint: fingerprint(body),
  });
}

export function verifyEvaluationContextSnapshot(
  snapshot: EvaluationContextSnapshot,
): boolean {
  const parsed = evaluationContextSnapshotSchema.safeParse(snapshot);
  if (!parsed.success) return false;
  const { snapshotFingerprint, ...body } = parsed.data;
  return fingerprint(body) === snapshotFingerprint;
}
