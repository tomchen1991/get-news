import { Store } from '../store';
import { localClock, reserve, type SiteEnv } from './pipeline';
import { modelDiagnostic, redact } from './diagnostics';
import { unwrapAiResponse } from './ai-response';

/** One explicitly authorized synthetic request. No feeds, profile, real news,
 * candidates, digest generation, or public route. A reservation is never retried.
 */
export async function dispatchJevSmoke(env: SiteEnv, now = Date.now): Promise<boolean> {
  const start = now(), clock = localClock(start, env.NEWS_TIMEZONE);
  const testId = env.JEV_SMOKE_TEST_ID;
  if (!testId || !testId.startsWith(`${clock.day}:`) || !/^\d{4}-\d{2}-\d{2}:[a-zA-Z0-9_-]{1,40}$/.test(testId)) return false;
  if (!env.AI || !/^[a-zA-Z0-9_-]{1,64}$/.test(env.AI_GATEWAY_ID ?? '')) throw new Error('Invalid smoke AI/Gateway configuration');
  const daily = Number(env.JEV_DAILY_REQUESTS ?? '360'), monthly = Number(env.JEV_MONTHLY_REQUESTS ?? '10000');
  if (env.JEV_DAILY_REQUESTS === '' || env.JEV_MONTHLY_REQUESTS === '' || !Number.isSafeInteger(daily) || daily < 0 || daily > 500 || !Number.isSafeInteger(monthly) || monthly < 0 || monthly > 15000) throw new Error('Invalid smoke budget');
  const store = new Store(env.DB), id = `jev-smoke:${testId}`;
  if (!await reserve(store, 'jev', id, 'synthetic-connectivity-test', start, clock.day, clock.month, daily, monthly)) return true;
  const model = 'typesafe/jev-1.14.0';
  let timer: ReturnType<typeof setTimeout> | undefined;
  let response: unknown;
  try {
    response = await Promise.race([
      env.AI.run(model, {
        state: { text: 'connectivity-test' },
        questions: { matches: { type: 'noul', instructions: 'Does text equal connectivity-test?' } },
      }, { gateway: { id: env.AI_GATEWAY_ID!, skipCache: true, collectLog: true } }),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Jev smoke timeout after 15000ms')), 15000); }),
    ]);
    const serialized = JSON.stringify(response);
    if (!serialized || serialized.length > 32768) throw new Error('Oversized or missing smoke response');
    const answer = (unwrapAiResponse(response) as { answers?: { matches?: { type?: unknown; noul?: unknown } } })?.answers?.matches;
    if (answer?.type !== 'noul' || typeof answer.noul !== 'number' || !Number.isFinite(answer.noul) || answer.noul < 0 || answer.noul > 1) throw new Error('Invalid Jev smoke response');
    const diagnostic = { model, gateway: env.AI_GATEWAY_ID, testId, answer: answer.noul, response: redact(serialized) };
    await store.run("UPDATE site_attempts SET status='completed',finished_at=?,diagnostic_json=? WHERE id=?", now(), JSON.stringify(diagnostic), id);
    console.log('jev_smoke_completed', JSON.stringify(diagnostic));
  } catch (error) {
    const diagnostic = { model, gateway: env.AI_GATEWAY_ID, testId, error: modelDiagnostic(error), response: response === undefined ? undefined : redact(JSON.stringify(response) ?? '') };
    console.error('jev_smoke_failed', JSON.stringify(diagnostic));
    await store.run("UPDATE site_attempts SET status='failed',finished_at=?,error_code='jev_smoke_failed',diagnostic_json=? WHERE id=?", now(), JSON.stringify(diagnostic), id);
  } finally { clearTimeout(timer); }
  return true;
}
