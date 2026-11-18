const limit = 5, windowMs = 5 * 60_000;

// One named object shares the budget across all Worker locations, without using D1.
export class NewsChatLoginLimiter {
  constructor(private readonly ctx: DurableObjectState) {}

  async fetch() {
    const storage = this.ctx.storage;
    const retryAfter = storage.transactionSync(() => {
      const now = Date.now();
      const attempts = (storage.kv.get<number[]>('attempts') ?? []).filter(time => time > now - windowMs);
      if (attempts.length >= limit) return Math.ceil((Math.min(...attempts) + windowMs - now) / 1000);
      storage.kv.put('attempts', [...attempts, now]);
      return 0;
    });
    return retryAfter ? new Response(null, { status: 429, headers: { 'Retry-After': String(retryAfter) } }) : new Response(null, { status: 204 });
  }
}
