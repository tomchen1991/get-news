import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDatabase } from './d1';
import { Store } from '../src/store';
import { dispatchJevSmoke } from '../src/site/smoke';
import { modelDiagnostic } from '../src/site/diagnostics';
import { createJevEvaluator, parseEvaluation } from '../src/site/jev';
import { unwrapAiResponse } from '../src/site/ai-response';
import { createGatewayChat } from '../src/site/chat';
import type { SiteEnv } from '../src/site/pipeline';

const now = Date.parse('2026-11-11T04:10:00Z');
const databases: ReturnType<typeof createDatabase>[] = [];
afterEach(() => { databases.splice(0).forEach(db => db.close()); vi.restoreAllMocks(); vi.useRealTimers(); });
function setup() {
  const database = createDatabase(); databases.push(database);
  vi.spyOn(console, 'log').mockImplementation(() => {}); vi.spyOn(console, 'error').mockImplementation(() => {});
  const ai = { run: vi.fn(async () => ({ answers: { matches: { type: 'noul', noul: 0.99 } } })) };
  const env: SiteEnv = { DB: database.db, AI: ai, AI_GATEWAY_ID: 'news', JEV_SMOKE_TEST_ID: '2026-11-11:test', SEARCH_ENABLED: 'false', JEV_ENABLED: 'false', DIGEST_ENABLED: 'false' };
  return { env, ai, store: new Store(database.db) };
}
describe('logged, once-only minimum Jev request', () => {
  it('reserves once, enables logging, sends one synthetic question, and never collects or publishes news', async () => {
    const { env, ai, store } = setup();
    expect(await dispatchJevSmoke(env, () => now)).toBe(true);
    await dispatchJevSmoke(env, () => now);
    expect(ai.run).toHaveBeenCalledTimes(1);
    const [model, input, options] = ai.run.mock.calls[0] as unknown as [string, any, any];
    expect(model).toBe('typesafe/jev-1.14.0');
    expect(input.state).toEqual({ text: 'connectivity-test' }); expect(Object.keys(input.questions)).toEqual(['matches']);
    expect(options).toEqual({ gateway: { id: 'news', skipCache: true, collectLog: true } });
    const attempt = await store.first<any>('SELECT status,diagnostic_json FROM site_attempts');
    expect(attempt.status).toBe('completed'); expect(JSON.parse(attempt.diagnostic_json).answer).toBe(0.99);
    for (const table of ['site_news', 'site_candidates', 'site_digest_attempts', 'site_digests']) expect(await store.first(`SELECT count(*) AS n FROM ${table}`)).toEqual({ n: 0 });
  });
  it('replays the exact completed-result shape captured by the real smoke request', async () => {
    const { env, ai, store } = setup();
    // Saved synthetic response, replayed offline: no second real request.
    ai.run.mockResolvedValue({ state: 'Completed', result: { model: 'jev-1.14.0', answers: { matches: { type: 'noul', noul: 0.99 } }, usage: { input_tokens: 282, output_tokens: 20 } } } as any);
    await dispatchJevSmoke(env, () => now);
    const attempt = await store.first<any>('SELECT status,diagnostic_json FROM site_attempts');
    expect(attempt.status).toBe('completed'); expect(JSON.parse(attempt.diagnostic_json).answer).toBe(0.99);
    const values = { worthReading: 0.9 };
    const result = { answers: Object.fromEntries(Object.entries(values).map(([key, noul]) => [key, { type: 'noul', noul }])) };
    expect(parseEvaluation({ state: 'Completed', result })).toEqual(values);
    expect(parseEvaluation(result)).toEqual(values);
  });
  it('unwraps completed third-party chat results before validating choices', async () => {
    const { ai } = setup();
    ai.run.mockResolvedValue({ state: 'Completed', result: { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'offline digest' } }] } } as any);
    expect(await createGatewayChat(ai, 'news', 'deepseek/test').complete('test', {})).toBe('offline digest');
  });
  it.each([
    { state: 'Pending', result: { answers: {} } },
    { state: 'Failed', result: { answers: {} } },
    { state: 'Completed', result: null },
    { state: 'Completed', result: [] },
  ])('rejects incomplete/failed envelopes instead of fabricating success: %o', raw => {
    expect(() => unwrapAiResponse(raw)).toThrow();
  });
  it('stores the actual provider code, status and request ID without credentials and never retries', async () => {
    const { env, ai, store } = setup();
    ai.run.mockRejectedValue(Object.assign(new Error('Provider rejected; Authorization: Bearer sk-secret-test'), { code: 2001, status: 403, requestId: 'request-123' }));
    await dispatchJevSmoke(env, () => now); await dispatchJevSmoke(env, () => now);
    expect(ai.run).toHaveBeenCalledTimes(1);
    const attempt = await store.first<any>('SELECT status,diagnostic_json FROM site_attempts');
    expect(attempt.status).toBe('failed'); expect(attempt.diagnostic_json).not.toContain('sk-secret-test');
    expect(JSON.parse(attempt.diagnostic_json).error).toMatchObject({ code: 2001, status: 403, requestId: 'request-123' });
    expect(console.error).toHaveBeenCalledWith('jev_smoke_failed', expect.stringContaining('request-123'));
  });
  it('keeps a malformed result as diagnostic evidence, not a fabricated success', async () => {
    const { env, ai, store } = setup(); ai.run.mockResolvedValue({ error: 'upstream problem' } as any);
    await dispatchJevSmoke(env, () => now);
    const attempt = await store.first<any>('SELECT status,diagnostic_json FROM site_attempts');
    expect(attempt.status).toBe('failed'); expect(attempt.diagnostic_json).toContain('upstream problem');
  });
  it('does not run with an absent/stale request or without remaining budget', async () => {
    const { env, ai } = setup();
    expect(await dispatchJevSmoke({ ...env, JEV_SMOKE_TEST_ID: undefined }, () => now)).toBe(false);
    expect(await dispatchJevSmoke({ ...env, JEV_SMOKE_TEST_ID: '2026-11-10:test' }, () => now)).toBe(false);
    await dispatchJevSmoke({ ...env, JEV_DAILY_REQUESTS: '0' }, () => now);
    expect(ai.run).not.toHaveBeenCalled();
  });
  it('times out once without retrying', async () => {
    const { env, ai, store } = setup(); vi.useFakeTimers();
    ai.run.mockImplementation(() => new Promise(() => {}));
    const run = dispatchJevSmoke(env, () => now); await vi.advanceTimersByTimeAsync(15001); await run;
    expect(ai.run).toHaveBeenCalledTimes(1);
    expect((await store.first<any>('SELECT diagnostic_json FROM site_attempts')).diagnostic_json).toContain('timeout');
  });
  it('uses the verified Workers AI DeepSeek Flash chat schema, without reasoning or tools', async () => {
    const { ai } = setup();
    const model = '@cf/deepseek-ai/deepseek-v4.1-flash-1017';
    ai.run.mockResolvedValue({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: '{"overview":"offline"}', refusal: null, tool_calls: [], function_call: null } }] } as any);
    expect(await createGatewayChat(ai, 'news', model, 4096).complete('Return JSON.', { articles: [] })).toBe('{"overview":"offline"}');
    const [calledModel, input, options] = ai.run.mock.calls[0] as unknown as [string, any, any];
    expect(calledModel).toBe(model);
    expect(input).toMatchObject({ max_completion_tokens: 4096, reasoning_effort: 'none', response_format: { type: 'json_object' }, stream: false, temperature: 0 });
    expect(input.max_tokens).toBeUndefined(); expect(input.tools).toBeUndefined();
    expect(options.gateway).toEqual({ id: 'news', skipCache: true, collectLog: true });
    expect(ai.run).toHaveBeenCalledTimes(1);
  });
  it('retains diagnostic causes in the regular judge and chat errors', async () => {
    const { ai } = setup(); ai.run.mockRejectedValue(Object.assign(new Error('Billing not enabled'), { code: 4001, requestId: 'request-a' }));
    const item = { externalId: 'test', title: 'test', summary: 'test', url: 'https://example.com/test', publishedAt: null };
    await expect(createJevEvaluator(ai, 'news').evaluate(item, { name: 'test', guidance: '', priority: 'core' })).rejects.toMatchObject({ cause: { message: 'Billing not enabled', code: 4001, requestId: 'request-a' } });
    await expect(createGatewayChat(ai, 'news', 'deepseek/test').complete('test', {})).rejects.toMatchObject({ cause: { message: 'Billing not enabled', code: 4001 } });
    expect(modelDiagnostic(new Error('Wrapper', { cause: new Error('Nested tvly-secret-value') }))).toMatchObject({ cause: { message: 'Nested [REDACTED]' } });
  });
});
