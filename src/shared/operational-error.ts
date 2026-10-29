export function operationalError(value: unknown) {
  const error = value as { name?: unknown; type?: unknown; code?: unknown; statusCode?: unknown; } | null;
  const safe = (v: unknown) => typeof v === 'string' && /^[A-Za-z0-9_.-]{1,80}$/.test(v) ? v : undefined;
  return {
    type: safe(error?.name) ?? safe(error?.type) ?? 'Error', code: safe(error?.code), message: 'See protected task evidence', stack: '',
    statusCode: typeof error?.statusCode === 'number' ? error.statusCode : undefined
  };
}
