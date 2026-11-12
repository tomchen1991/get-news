/** Third-party AI.run responses may use Cloudflare's completed-result envelope.
 * Provider-native JSON is also accepted. Never treat queued/failed jobs as results.
 */
export function unwrapAiResponse(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const envelope = raw as Record<string, unknown>;
  if (!Object.hasOwn(envelope, 'state')) return raw;
  if (envelope.state !== 'Completed' || !envelope.result || typeof envelope.result !== 'object' || Array.isArray(envelope.result)) throw new Error('AI response is not a completed result');
  return envelope.result;
}
