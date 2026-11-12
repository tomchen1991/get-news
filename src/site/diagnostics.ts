/** Operator diagnostics only: never returned by public news/digest APIs. */
export function redact(value: string): string {
  return value
    .replace(/Bearer\s+[^\s"'<>]+/gi, 'Bearer [REDACTED]')
    .replace(/\b(?:sk-|tvly-|cfat_)[a-zA-Z0-9_-]+/g, '[REDACTED]')
    .replace(/((?:api[_-]?key|authorization|access[_-]?token|oauth[_-]?token)\s*["']?\s*[:=]\s*["']?)[^\s,"'}]+/gi, '$1[REDACTED]')
    .slice(0, 2000);
}
export function modelDiagnostic(error: unknown, depth = 0): Record<string, unknown> {
  if (!error || typeof error !== 'object') return { message: redact(String(error)) };
  const raw = error as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const key of ['name', 'message', 'code', 'status', 'statusCode', 'requestId', 'request_id', 'cfRay']) {
    const value = raw[key];
    if (typeof value === 'string') result[key] = redact(value);
    else if (typeof value === 'number' && Number.isFinite(value)) result[key] = value;
  }
  if (!result.message) result.message = 'Unknown model error';
  if (raw.cause !== undefined && depth < 2) result.cause = modelDiagnostic(raw.cause, depth + 1);
  return result;
}
