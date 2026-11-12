import { afterEach, describe, expect, it, vi } from 'vitest';
import { withWorkerPresence, type WorkerPresenceEnv } from '../src/site/worker-presence';
import site from '../src/site';

const env: WorkerPresenceEnv = {
  WORKER_PRESENCE_ENABLED: 'true', WORKER_PRESENCE_URL: 'https://collect.example.com/ingest/agent_presence/1',
  WORKER_PRESENCE_SOURCE_ID: 'get-news-worker-test', WORKER_PRESENCE_TOKEN: 't'.repeat(43),
};
function ack(body: string) {
  const input = JSON.parse(body);
  return { version: 1, persistence: 'memory', processId: '11111111-1111-4111-8111-111111111111',
    startedAt: '2026-11-12T00:00:00Z', observedAt: '2026-11-12T00:00:00Z', receivedAt: '2026-11-12T00:00:00Z',
    sourceId: input.sourceId, instanceId: input.data.instance_id, result: 'accepted', currentSeq: input.data.state_seq };
}
function transport() {
  const bodies: any[] = [];
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
    const body = String(init?.body); bodies.push(JSON.parse(body));
    return Response.json(ack(body));
  });
  return { bodies, fetcher };
}
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('Worker agent presence (not PI)', () => {
  it('reports real task start/end, a stable per-run identity and increasing seq', async () => {
    const { bodies, fetcher } = transport();
    const result = await withWorkerPresence(env, async () => 42, { fetcher });
    expect(result).toBe(42);
    expect(bodies.map(b => [b.data.status, b.data.state_seq])).toEqual([['working', 1], ['stopping', 2]]);
    expect(bodies[0].data.instance_id).toBe(bodies[1].data.instance_id);
    expect(bodies[0].data).toMatchObject({ member_name: '热点获取 Agent（Worker）', task_type: 'scheduled_task', repo: 'get-news', provider: null, model: null });
    expect(Object.keys(bodies[0]).sort()).toEqual(['data', 'sourceId']);
    expect(JSON.stringify(bodies)).not.toContain('PI');
    expect(fetcher.mock.calls[0][1]).toMatchObject({ method: 'POST', redirect: 'manual' });
    const headers = fetcher.mock.calls[0][1]?.headers as Record<string, string>;
    expect(Number(headers['Content-Length'])).toBe(new TextEncoder().encode(String(fetcher.mock.calls[0][1]?.body)).byteLength);
  });
  it('uses a new instance on each invocation instead of sharing isolate state', async () => {
    const { bodies, fetcher } = transport();
    await Promise.all([withWorkerPresence(env, async () => {}, { fetcher }), withWorkerPresence(env, async () => {}, { fetcher })]);
    expect(new Set(bodies.map(b => b.data.instance_id)).size).toBe(2);
  });
  it('heartbeats only while the task runs and clears timers after termination', async () => {
    vi.useFakeTimers();
    const { bodies, fetcher } = transport();
    let finish!: () => void;
    const result = withWorkerPresence(env, () => new Promise<void>(r => { finish = r; }), { fetcher });
    await vi.advanceTimersByTimeAsync(31000);
    expect(bodies.filter(b => b.data.status === 'working')).toHaveLength(3);
    finish(); await result;
    expect(bodies.at(-1).data.status).toBe('stopping');
    const count = bodies.length;
    await vi.advanceTimersByTimeAsync(60000);
    expect(bodies).toHaveLength(count);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('preserves job failures, with a safe terminal status instead of error text', async () => {
    const { bodies, fetcher } = transport();
    await expect(withWorkerPresence(env, async () => { throw Error('private news/provider error'); }, { fetcher })).rejects.toThrow('private news/provider error');
    expect(bodies.at(-1).data.status_detail).toBe('定时任务异常结束');
    expect(JSON.stringify(bodies)).not.toContain('private');
  });
  it.each([
    { WORKER_PRESENCE_ENABLED: undefined }, { WORKER_PRESENCE_URL: 'http://127.0.0.1/ingest/agent_presence/1' },
    { WORKER_PRESENCE_URL: 'https://collect.example.com/wrong' },
    { WORKER_PRESENCE_URL: 'https://collect.example.com/ingest/agent_presence/1?token=no' },
    { WORKER_PRESENCE_URL: 'https://collect.example.com/ingest/agent_presence/1#fragment' },
    { WORKER_PRESENCE_SOURCE_ID: 'bad source' }, { WORKER_PRESENCE_TOKEN: '' },
  ])('fails closed on disabled/invalid configuration without blocking work: %j', async override => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { fetcher } = transport();
    expect(await withWorkerPresence({ ...env, ...override }, async () => 'done', { fetcher })).toBe('done');
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each([401, 403, 409, 410, 302])('halts this invocation after explicit HTTP %s rejection', async status => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status }));
    await withWorkerPresence(env, async () => {}, { fetcher });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each(['broken-json', 'wrong-identity', 'wrong-seq', 'unknown-key'])('halts after malformed/mismatched ACK: %s', async kind => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      const data = ack(String(init?.body));
      if (kind === 'broken-json') return new Response('{');
      if (kind === 'wrong-identity') data.instanceId = 'other';
      if (kind === 'wrong-seq') data.currentSeq = 0;
      return Response.json(kind === 'unknown-key' ? { ...data, extra: true } : data);
    });
    await withWorkerPresence(env, async () => {}, { fetcher });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('does not replay ambiguous snapshots; a final observation has a new seq', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { bodies, fetcher } = transport();
    fetcher.mockImplementationOnce(async (_url, init) => { bodies.push(JSON.parse(String(init?.body))); throw Error('ambiguous secret'); });
    await withWorkerPresence(env, async () => {}, { fetcher });
    expect(bodies.map(b => b.data.state_seq)).toEqual([1, 2]);
    expect(bodies.map(b => b.data.status)).toEqual(['working', 'stopping']);
  });
  it('honors Retry-After instead of sending a terminal snapshot through backoff', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status: 429, headers: { 'Retry-After': '60' } }));
    await withWorkerPresence(env, async () => {}, { fetcher });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('bounds hung HTTP without preventing the job from starting', async () => {
    vi.useFakeTimers(); vi.spyOn(console, 'error').mockImplementation(() => {});
    const fetcher = vi.fn<typeof fetch>().mockImplementation(() => new Promise(() => {}));
    const job = vi.fn(async () => 'done');
    const result = withWorkerPresence(env, job, { fetcher });
    expect(job).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(8100);
    expect(await result).toBe('done');
    expect(vi.getTimerCount()).toBe(0);
  });
  it('is wired into the actual scheduled entry, never the public health handler', async () => {
    const { bodies, fetcher } = transport(); vi.stubGlobal('fetch', fetcher);
    const tasks: Promise<unknown>[] = [];
    const siteEnv = { ...env, DB: {} as D1Database };
    await site.scheduled({ scheduledTime: Date.now() } as ScheduledController, siteEnv,
      { waitUntil: (p: Promise<unknown>) => tasks.push(p) } as unknown as ExecutionContext);
    await Promise.all(tasks);
    expect(bodies.map(b => b.data.status)).toEqual(['working', 'stopping']);
    await site.fetch(new Request('https://news.example.com/health'), siteEnv);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
