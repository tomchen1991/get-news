const limit = 5, sourceLimit = 2, windowMs = 5 * 60_000;
export const loginSourceHeader = 'X-News-Chat-Login-Source';

export function loginSourceBucket(ip: string | null) {
  if (ip && /^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/.test(ip)) {
    const octets = ip.split('.').map(Number);
    if (octets.every(octet => octet <= 255)) return octets.join('.');
  }
  if (ip?.includes(':') && /^[a-f0-9:.]{2,45}$/i.test(ip)) {
    try {
      // Group IPv6 privacy addresses on the same network by their /64 prefix.
      const [head, tail] = new URL(`http://[${ip}]`).hostname.slice(1, -1).split('::');
      const groups = head ? head.split(':') : [];
      if (tail !== undefined) {
        const suffix = tail ? tail.split(':') : [];
        groups.push(...Array<string>(8 - groups.length - suffix.length).fill('0'), ...suffix);
      }
      return `${groups.slice(0, 4).join(':')}::/64`;
    } catch { /* Invalid addresses share the unknown bucket. */ }
  }
  return 'unknown';
}

// Old deployments stored only timestamps; keep counting them towards the shared cap until they expire.
type Attempt = number | { time: number; source: string };
const timeOf = (attempt: Attempt) => typeof attempt === 'number' ? attempt : attempt.time;
const availableAt = (attempts: Attempt[], cap: number, now: number) =>
  attempts.length >= cap ? Math.min(...attempts.map(timeOf)) + windowMs : now;

// One named object enforces both caps atomically across all Worker locations, without using D1.
export class NewsChatLoginLimiter {
  constructor(private readonly ctx: DurableObjectState) {}

  async fetch(request: Request) {
    const key = request.headers.get(loginSourceHeader) ?? '';
    const source = /^[a-f0-9]{64}$/.test(key) ? key : 'unknown';
    const storage = this.ctx.storage;
    const retryAfter = storage.transactionSync(() => {
      const now = Date.now();
      const attempts = (storage.kv.get<Attempt[]>('attempts') ?? []).filter(attempt => timeOf(attempt) > now - windowMs);
      const own = attempts.filter(attempt => typeof attempt !== 'number' && attempt.source === source);
      const next = Math.max(availableAt(attempts, limit, now), availableAt(own, sourceLimit, now));
      if (next > now) return Math.ceil((next - now) / 1000);
      storage.kv.put('attempts', [...attempts, { time: now, source }]);
      return 0;
    });
    return retryAfter ? new Response(null, { status: 429, headers: { 'Retry-After': String(retryAfter) } }) : new Response(null, { status: 204 });
  }
}
