import { assertPublicHttpsUrl, fetchBounded } from '../http';

export interface WorkerPresenceEnv {
  WORKER_PRESENCE_ENABLED?: string;
  WORKER_PRESENCE_URL?: string;
  WORKER_PRESENCE_SOURCE_ID?: string;
  WORKER_PRESENCE_TOKEN?: string;
}
const identity = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$(?![\s\S])/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ackKeys = 'currentSeq,instanceId,observedAt,persistence,processId,receivedAt,result,sourceId,startedAt,version';
const timestamp = (v: unknown): v is string => typeof v === 'string' && v.length <= 64 &&
  /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(v) && Number.isFinite(Date.parse(v)) &&
  new Date(v).toISOString().slice(0, 19) === v.slice(0, 19);

function configuration(env: WorkerPresenceEnv) {
  const url = assertPublicHttpsUrl(env.WORKER_PRESENCE_URL ?? '');
  if (url.pathname !== '/ingest/agent_presence/1' || url.search || url.hash ||
      !identity.test(env.WORKER_PRESENCE_SOURCE_ID ?? '') ||
      !/^[A-Za-z0-9_-]{43,128}$(?![\s\S])/.test(env.WORKER_PRESENCE_TOKEN ?? '')) throw new Error('Invalid worker presence configuration');
  return { url: url.href, sourceId: env.WORKER_PRESENCE_SOURCE_ID!, token: env.WORKER_PRESENCE_TOKEN! };
}

/** One transient Worker invocation is one agent instance. No global/isolate identity,
 * D1 outbox, PI metadata, durable-online claim, or automatic retry of a snapshot.
 */
export async function withWorkerPresence<T>(
  env: WorkerPresenceEnv,
  job: () => Promise<T>,
  deps: { fetcher?: typeof fetch; now?: () => number } = {},
): Promise<T> {
  if (env.WORKER_PRESENCE_ENABLED !== 'true') return job();
  let config: ReturnType<typeof configuration>;
  try { config = configuration(env); }
  catch { console.error('worker_presence_configuration_failed'); return job(); }
  const now = deps.now ?? Date.now;
  const instanceId = crypto.randomUUID(), startedAt = new Date(now()).toISOString();
  let seq = 0, closed = false, blocked = false, failed = false;
  const stop = new AbortController();
  let retryAfter = 0;
  // The single loop owns HTTP: never more than one request in flight.
  const send = async (status: 'working' | 'stopping') => {
    if (blocked || now() < retryAfter) return;
    const submittedSeq = ++seq;
    const payload = {
      sourceId: config.sourceId,
      data: {
        instance_id: instanceId, member_name: '热点获取 Agent（Worker）', status,
        task_type: 'scheduled_task', task_name: '热点采集与日报', task_started_at: startedAt,
        status_detail: status === 'working' ? '定时任务执行中' : failed ? '定时任务异常结束' : '定时任务结束',
        provider: null, model: null, repo: 'get-news', state_seq: submittedSeq,
      },
    };
    const body = JSON.stringify(payload);
    try {
      const { response, text } = await fetchBounded(config.url, {
        method: 'POST', headers: {
          Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json; charset=utf-8',
          'Content-Length': String(new TextEncoder().encode(body).byteLength),
        }, body,
      }, 8192, 4000, async (url, init) => {
        const response = await (deps.fetcher ?? fetch)(url, init);
        if (response.status >= 300 && response.status < 400) blocked = true;
        return response;
      });
      if (response.status === 429) {
        const raw = response.headers.get('Retry-After');
        const delay = raw && /^\d+$/.test(raw) ? Number(raw) * 1000 : raw ? Date.parse(raw) - now() : NaN;
        retryAfter = now() + (Number.isFinite(delay) && delay > 0 ? Math.max(1000, delay) : 60000);
        console.error('worker_presence_rate_limited');
        return;
      }
      if (response.status !== 200) {
        // Explicit rejection stops this invocation; network/5xx may publish a fresh
        // observation later, but never replay an ambiguous old snapshot.
        if (response.status < 500) blocked = true;
        console.error('worker_presence_send_failed');
        return;
      }
      let ack: Record<string, unknown>;
      try { ack = JSON.parse(text); }
      catch { blocked = true; console.error('worker_presence_invalid_ack'); return; }
      if (!ack || Object.keys(ack).sort().join() !== ackKeys || ack.version !== 1 || ack.persistence !== 'memory' ||
          ack.sourceId !== config.sourceId || ack.instanceId !== instanceId ||
          typeof ack.processId !== 'string' || !uuid.test(ack.processId) ||
          !timestamp(ack.startedAt) || !timestamp(ack.observedAt) || !timestamp(ack.receivedAt) ||
          !['accepted', 'duplicate', 'outdated'].includes(String(ack.result)) ||
          !Number.isSafeInteger(ack.currentSeq) || (ack.currentSeq as number) < submittedSeq ||
          (ack.result !== 'outdated' && ack.currentSeq !== submittedSeq)) {
        blocked = true;
        console.error('worker_presence_invalid_ack');
      }
    } catch {
      // Do not log body, credentials, provider errors or untrusted response text.
      console.error('worker_presence_send_failed');
    }
  };
  const wait = () => new Promise<void>(resolve => {
    const finish = () => { clearTimeout(timer); stop.signal.removeEventListener('abort', finish); resolve(); };
    const timer = setTimeout(finish, 15000);
    stop.signal.addEventListener('abort', finish, { once: true });
    if (stop.signal.aborted) finish();
  });
  const reporting = (async () => {
    while (!closed && !blocked) {
      await send('working');
      if (!closed && !blocked) await wait();
    }
  })();
  try { return await job(); }
  catch (error) { failed = true; throw error; }
  finally {
    closed = true;
    stop.abort();
    // A bounded request may still finish. Join before terminal snapshot so an old
    // working frame can never arrive after our own stopping send.
    await reporting;
    await send('stopping');
  }
}
