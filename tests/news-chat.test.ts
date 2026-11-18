import { describe, expect, it, vi } from 'vitest';
import { handleNewsChat } from '../src/site/news-chat';
import { handleSiteRequest, NewsChatLoginLimiter } from '../src/site/index';
import { handleNewsChatAuth } from '../src/site/news-chat-auth';
import { loginSourceHeader } from '../src/site/news-chat-login-limit';
import { newsChatAsset } from '../src/site/news-chat-page';
import type { SiteEnv } from '../src/site/pipeline';
import { createDatabase } from './d1';

const now = Date.parse('2026-11-18T01:00:00Z');
const issuer = 'https://auth.falsita.cn', aud = 'news-client', origin = 'https://news.example';
const session = 'a'.repeat(43), sessionCookie = `__Host-news-chat-session=${session}`;
const loginPath = '/api/news-chat/login';
const loginRequest = (code = '123456', source = origin, headers: HeadersInit = {}) => new Request(origin + loginPath, {
  method: 'POST', headers: { ...Object.fromEntries(new Headers(headers)), Origin: source }, body: new URLSearchParams({ code }),
});
async function fixture() {
  const { db, close } = createDatabase();
  const run = vi.fn().mockResolvedValue({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: '{"query":"The Game Awards nominations","from":"2026-11-17","to":"2026-11-17"}' } }] });
  const search = vi.fn().mockResolvedValue({ items: [{ title: 'TGA nominees', summary: 'Full list', url: 'https://thegameawards.com/nominees', publishedAt: null }], credits: 1 });
  const reserveLogin = vi.fn(async () => new Response(null, { status: 204 }));
  const env: SiteEnv = { DB: db, NEWS_CHAT_ENABLED: 'true', APP_ORIGIN: origin, OIDC_ISSUER: issuer, OIDC_CLIENT_ID: aud, OIDC_CLIENT_SECRET: 'test-secret',
    NEWS_CHAT_LOGIN_LIMITER: { getByName: () => ({ fetch: reserveLogin }) } as unknown as DurableObjectNamespace,
    DIGEST_MODEL: 'test/model', AI_GATEWAY_ID: 'test', TAVILY_API_KEY: 'test', AI: { run } };
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(session));
  await db.prepare('INSERT INTO site_news_chat_sessions VALUES(?,?,?)').bind(Buffer.from(digest).toString('hex'), 'test-token', now + 300_000).run();
  const deps = { now, fetcher: vi.fn<typeof fetch>().mockImplementation(async () => Response.json({ sub: 'owner' })), search: { search } };
  const request = (cookie = sessionCookie, source = origin, message = '阵容公布了吗？') => new Request(origin + '/api/news-chat', { method: 'POST', headers: {
    Origin: source, Cookie: cookie, 'Content-Type': 'application/json',
  }, body: JSON.stringify({ message, history: ['昨天 TGA 有什么新闻？'] }) });
  return { env, deps, run, search, request, close, reserveLogin };
}

describe('news chat', () => {
  it('renders the browser conversation and only exposes the navigation when configured', async () => {
    const f = await fixture();
    try {
      const page = await handleSiteRequest(new Request(origin + '/ask'), f.env);
      expect(page.status).toBe(303);
      expect(page.headers.get('Location')).toBe('/api/news-chat/login');
      expect((await handleSiteRequest(new Request('https://other.example/ask'), f.env)).status).toBe(403);
      expect((await handleSiteRequest(new Request(origin + '/ask'), { ...f.env, OIDC_CLIENT_SECRET: undefined })).status).toBe(503);
      expect(await (await handleSiteRequest(new Request(origin + '/'), f.env)).text()).toContain('href="/ask"');
      const script = await (await handleSiteRequest(new Request(origin + '/news-chat.js'), f.env)).text();
      expect(() => new Function(script)).not.toThrow();
      expect(script).toContain("fetch('/api/news-chat'");
      expect((await handleSiteRequest(new Request(origin + '/ask'), { ...f.env, NEWS_CHAT_ENABLED: 'false' })).status).toBe(404);
    } finally { f.close(); }
  });

  it('sets a same-origin referrer policy for both browser POSTs without changing the page policy', async () => {
    expect(newsChatAsset('/ask').headers.get('Referrer-Policy')).toBe('no-referrer');
    const script = await newsChatAsset('/news-chat.js').text();
    const listeners = new Map<string, (event?: { preventDefault(): void }) => Promise<void>>();
    const element = () => ({ value: '最近有什么新闻？', append() {}, focus() {} });
    const document = {
      getElementById: (id: string) => ({ ...element(), addEventListener: (_event: string, fn: () => Promise<void>) => listeners.set(id, fn) }),
      createElement: element,
    };
    const fetcher = vi.fn(async (_path: string, _options: { method?: string; referrerPolicy?: string }) => Response.json({ query: 'test', items: [] }));
    const assign = vi.fn();
    new Function('document', 'fetch', 'location', script)(document, fetcher, { assign });
    await listeners.get('logout')!();
    await listeners.get('ask-form')!({ preventDefault() {} });
    expect(fetcher.mock.calls.map(([path, init]) => [path, init.method, init.referrerPolicy])).toEqual([
      ['/api/news-chat/logout', 'POST', 'same-origin'],
      ['/api/news-chat', 'POST', 'same-origin'],
    ]);
    expect(assign).toHaveBeenCalledExactlyOnceWith('/');
  });

  it('returns the login limit before token exchange or any D1 access', async () => {
    const f = await fixture();
    const fetcher = vi.fn<typeof fetch>();
    const prepare = vi.spyOn(f.env.DB, 'prepare'), batch = vi.spyOn(f.env.DB, 'batch');
    const getByName = vi.fn(() => ({ fetch: async () => new Response(null, { status: 429, headers: { 'Retry-After': '42' } }) }));
    const env = { ...f.env, NEWS_CHAT_LOGIN_LIMITER: { getByName } as unknown as DurableObjectNamespace };
    try {
      const response = await handleNewsChatAuth(loginRequest(), env, fetcher);
      expect(response.status).toBe(429);
      expect(response.headers.get('Retry-After')).toBe('42');
      expect(response.headers.get('Cache-Control')).toBe('no-store');
      expect(response.headers.has('Set-Cookie')).toBe(false);
      expect(await response.text()).toContain('尝试次数过多');
      expect(getByName).toHaveBeenCalledExactlyOnceWith('login');
      expect(fetcher).not.toHaveBeenCalled();
      expect(prepare).not.toHaveBeenCalled();
      expect(batch).not.toHaveBeenCalled();
    } finally { f.close(); }
  });

  it('does not contact Auth or D1 when the login limiter is unavailable', async () => {
    const f = await fixture();
    const fetcher = vi.fn<typeof fetch>();
    const prepare = vi.spyOn(f.env.DB, 'prepare');
    try {
      f.reserveLogin.mockRejectedValueOnce(new Error('unavailable'));
      expect((await handleNewsChatAuth(loginRequest(), f.env, fetcher)).status).toBe(503);
      expect((await handleNewsChatAuth(loginRequest(), { ...f.env, NEWS_CHAT_LOGIN_LIMITER: undefined }, fetcher)).status).toBe(503);
      expect(fetcher).not.toHaveBeenCalled();
      expect(prepare).not.toHaveBeenCalled();
    } finally { f.close(); }
  });

  it('passes only a hashed Cloudflare source bucket to the limiter', async () => {
    const f = await fixture();
    const fetchLimit = vi.fn(async (_url: string, _init: RequestInit) => new Response(null, { status: 429 }));
    const env = { ...f.env, NEWS_CHAT_LOGIN_LIMITER: { getByName: () => ({ fetch: fetchLimit }) } as unknown as DurableObjectNamespace };
    const bucket = async (ip?: string) => {
      const headers = new Headers({ 'X-Forwarded-For': '192.0.2.1', [loginSourceHeader]: 'f'.repeat(64) });
      if (ip) headers.set('CF-Connecting-IP', ip);
      const request = loginRequest('123456', origin, headers);
      expect((await handleNewsChatAuth(request, env)).status).toBe(429);
      const sent = new Headers(fetchLimit.mock.lastCall![1].headers);
      expect(Array.from(sent.keys())).toEqual([loginSourceHeader.toLowerCase()]);
      return sent.get(loginSourceHeader);
    };
    try {
      const ipv4 = await bucket('192.0.2.1');
      expect(ipv4).toMatch(/^[a-f0-9]{64}$/);
      expect(ipv4).not.toBe('f'.repeat(64));
      expect(await bucket('192.0.2.2')).not.toBe(ipv4);
      const ipv6 = await bucket('2001:db8:0:1::1');
      expect(await bucket('2001:0DB8:0000:0001:abcd::2')).toBe(ipv6);
      expect(await bucket('2001:db8:0:2::1')).not.toBe(ipv6);
      const unknown = await bucket();
      expect(unknown).not.toBe(ipv4);
      expect(await bucket('192.0.2.1, 192.0.2.2')).toBe(unknown);
    } finally { f.close(); }
  });

  it('enforces independent source and shared rolling allowances across object recreation', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    // Preserve the shared reservation made before the source-aware deployment.
    const data = new Map<string, unknown>([['attempts', [now]]]);
    const put = vi.fn((key: string, value: unknown) => data.set(key, value));
    const ctx = { storage: { transactionSync: (op: () => unknown) => op(), kv: { get: (key: string) => data.get(key), put } } } as unknown as DurableObjectState;
    let limiter = new NewsChatLoginLimiter(ctx);
    const reserve = (source: string) => limiter.fetch(new Request('https://news-chat-login-limit.internal/', { headers: { [loginSourceHeader]: source.repeat(64) } }));
    try {
      clock.mockReturnValue(now + 60_000);
      const sameSource = await Promise.all([reserve('a'), reserve('a'), reserve('a')]);
      expect(sameSource.map(r => r.status)).toEqual([204, 204, 429]);
      expect(sameSource[2].headers.get('Retry-After')).toBe('300');
      expect((await reserve('b')).status).toBe(204);
      expect((await reserve('c')).status).toBe(204);
      expect(put).toHaveBeenCalledTimes(4);

      limiter = new NewsChatLoginLimiter(ctx);
      expect((await reserve('a')).headers.get('Retry-After')).toBe('300');
      expect((await reserve('d')).headers.get('Retry-After')).toBe('240');
      clock.mockReturnValue(now + 299_999);
      const denied = await reserve('d');
      expect(denied.status).toBe(429);
      expect(denied.headers.get('Retry-After')).toBe('1');
      clock.mockReturnValue(now + 300_000);
      expect((await reserve('a')).status).toBe(429);
      expect((await reserve('d')).status).toBe(204);
      expect((await reserve('e')).status).toBe(429);
      clock.mockReturnValue(now + 360_000);
      expect((await reserve('a')).status).toBe(204);
    } finally { clock.mockRestore(); }
  });

  it('exchanges a same-origin TOTP for an owner session and revokes it on logout', async () => {
    const f = await fixture();
    const tokenCall = vi.fn(), revoke = vi.fn();
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      expect(url.origin).toBe(issuer);
      expect(init?.redirect).toBe('manual');
      switch (url.pathname) {
        case '/token': {
          tokenCall();
          expect(init?.method).toBe('POST');
          expect(new Headers(init?.headers).get('Authorization')).toBe('Basic ' + btoa('news-client:test-secret'));
          expect(Object.fromEntries(new URLSearchParams(String(init?.body)))).toEqual({ code: '012345', scope: 'openid profile', grant_type: 'urn:falsita:params:oauth:grant-type:totp' });
          return Response.json({ access_token: 'access', token_type: 'Bearer', expires_in: 300, refresh_token: 'never-store' });
        }
        case '/me':
          expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer access');
          return Response.json({ sub: 'owner' });
        case '/token/revocation':
          revoke(new URLSearchParams(String(init?.body)).get('token'));
          return new Response(null, { status: 200 });
        default: throw new Error('Unexpected URL');
      }
    });
    try {
      const login = await handleSiteRequest(new Request(origin + loginPath), f.env);
      expect(login.status).toBe(200);
      expect(login.headers.get('Referrer-Policy')).toBe('same-origin');
      expect(await login.text()).toContain('action="/api/news-chat/login" method="post"');
      expect((await handleSiteRequest(new Request(origin + '/api/news-chat/callback'), f.env)).status).toBe(404);
      expect(fetcher).not.toHaveBeenCalled();
      const result = await handleNewsChatAuth(loginRequest('012345'), f.env, fetcher);
      expect(result.status).toBe(303);
      expect(result.headers.get('Location')).toBe('/ask');
      expect(result.headers.get('Cache-Control')).toBe('no-store');
      const session = result.headers.getSetCookie().find(value => value.startsWith('__Host-news-chat-session='))!;
      expect(session).toMatch(/Path=\/; Max-Age=[1-9]\d*; HttpOnly; Secure; SameSite=Lax/);
      expect(session).not.toContain('access');
      expect(tokenCall).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(await f.env.DB.prepare('SELECT * FROM site_news_chat_sessions').all())).not.toMatch(/012345|never-store/);
      vi.stubGlobal('fetch', fetcher);
      const ask = new Request(origin + '/ask', { headers: { Cookie: session.split(';')[0] } });
      expect(await (await handleSiteRequest(ask, f.env)).text()).toContain('昨天 TGA 年度游戏有哪些提名');
      const logout = (source: string) => new Request(origin + '/api/news-chat/logout', { method: 'POST', headers: { Origin: source, Cookie: session.split(';')[0] } });
      expect((await handleNewsChatAuth(logout('https://other.example'), f.env, fetcher)).status).toBe(403);
      expect((await handleNewsChatAuth(logout('null'), f.env, fetcher)).status).toBe(403);
      const loggedOut = await handleNewsChatAuth(logout(origin), f.env, fetcher);
      expect(loggedOut.status).toBe(204);
      expect(loggedOut.headers.get('Set-Cookie')).toContain('__Host-news-chat-session=; Path=/; Max-Age=0');
      expect(revoke).toHaveBeenCalledExactlyOnceWith('access');
      expect((await handleSiteRequest(ask, f.env)).status).toBe(303);
      expect(f.reserveLogin).toHaveBeenCalledTimes(1);
    } finally { vi.unstubAllGlobals(); f.close(); }
  });

  it('rejects cross-origin and invalid login submissions before contacting Auth', async () => {
    const f = await fixture();
    const fetcher = vi.fn<typeof fetch>();
    try {
      for (const request of [loginRequest('123456', 'https://other.example'), loginRequest('123456', 'null'), loginRequest('123456', origin, { 'Sec-Fetch-Site': 'cross-site' })]) {
        expect((await handleNewsChatAuth(request, f.env, fetcher)).status).toBe(403);
      }
      for (const code of ['12345', 'a'.repeat(257)]) expect((await handleNewsChatAuth(loginRequest(code), f.env, fetcher)).status).toBe(400);
      expect(f.reserveLogin).not.toHaveBeenCalled();
      expect(fetcher).not.toHaveBeenCalled();
    } finally { f.close(); }
  });

  it('fails closed for rejected or unavailable Auth and creates no session', async () => {
    const f = await fixture();
    const fetcher = vi.fn<typeof fetch>();
    try {
      fetcher.mockResolvedValueOnce(Response.json({ error: 'invalid_grant' }, { status: 400 }))
        .mockResolvedValueOnce(Response.json({ error: 'unauthorized_client' }, { status: 400 }))
        .mockResolvedValueOnce(Response.redirect('https://other.example', 307))
        .mockRejectedValueOnce(new Error('network'))
        .mockResolvedValueOnce(Response.json({ access_token: 'access', token_type: 'Bearer', expires_in: 900 }))
        .mockResolvedValueOnce(Response.json({ sub: 'guest' }));
      for (const status of [401, 503, 503, 503, 403]) {
        const result = await handleNewsChatAuth(loginRequest(), f.env, fetcher);
        expect(result.status).toBe(status);
        expect(result.headers.get('Set-Cookie')).toBeNull();
        expect(result.headers.get('Location')).toBeNull();
        expect(await result.text()).not.toMatch(/123456|unauthorized_client/);
      }
      expect(await f.env.DB.prepare('SELECT COUNT(*) AS count FROM site_news_chat_sessions').first()).toEqual({ count: 1 });
      expect(f.run).not.toHaveBeenCalled();
      expect(f.search).not.toHaveBeenCalled();
    } finally { f.close(); }
  });

  it('uses the main model to resolve a follow-up, executes one search and returns sources', async () => {
    const f = await fixture();
    try {
      const res = await handleNewsChat(f.request(), f.env, f.deps);
      expect(res.status).toBe(200);
      expect(res.headers.get('Cache-Control')).toBe('no-store');
      expect(await res.json()).toMatchObject({ query: 'The Game Awards nominations', from: '2026-11-17', items: [{ url: 'https://thegameawards.com/nominees' }] });
      expect(f.run).toHaveBeenCalledTimes(1);
      expect(f.run.mock.calls[0][0]).toBe('test/model');
      expect(JSON.parse(f.run.mock.calls[0][1].messages[1].content)).toMatchObject({ today: '2026-11-18', message: '阵容公布了吗？', history: ['昨天 TGA 有什么新闻？'] });
      expect(f.run.mock.calls[0][2].gateway.collectLog).toBe(false);
      expect(f.search).toHaveBeenCalledExactlyOnceWith({ query: 'The Game Awards nominations', maxResults: 8, startDate: '2026-11-17', endDate: '2026-11-17' });
      expect(await f.env.DB.prepare('SELECT ref,units,status FROM site_attempts').first()).toMatchObject({ ref: 'news-chat', units: 1, status: 'completed' });
    } finally { f.close(); }
  });

  it('blocks cross-site, anonymous and invalid requests before model calls', async () => {
    const f = await fixture();
    try {
      expect((await handleNewsChat(f.request(sessionCookie, 'https://other.example'), f.env, f.deps)).status).toBe(403);
      expect((await handleNewsChat(f.request(''), f.env, f.deps)).status).toBe(401);
      expect((await handleNewsChat(f.request(sessionCookie, origin, 'x'.repeat(801)), f.env, f.deps)).status).toBe(400);
      f.deps.fetcher.mockResolvedValueOnce(Response.json({ sub: 'guest' })).mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(new Response(null, { status: 401 }));
      for (const status of [403, 503, 401, 401]) {
        const response = await handleNewsChat(f.request(), f.env, f.deps);
        expect(response.status).toBe(status);
        expect(response.headers.get('Location')).toBeNull();
      }
      expect(f.deps.fetcher).toHaveBeenCalledTimes(4);
      expect(f.deps.fetcher).toHaveBeenCalledWith(`${issuer}/me`, expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer test-token' }) }));
      expect(f.run).not.toHaveBeenCalled();
      expect(f.search).not.toHaveBeenCalled();
    } finally { f.close(); }
  });

  it('rejects expired sessions on both routes without contacting Auth or news upstreams', async () => {
    const f = await fixture();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 300_000);
    vi.stubGlobal('fetch', f.deps.fetcher);
    try {
      const page = await handleSiteRequest(new Request(origin + '/ask', { headers: { Cookie: sessionCookie } }), f.env);
      expect(page.status).toBe(303);
      expect(page.headers.get('Location')).toBe(loginPath);
      expect(page.headers.get('Set-Cookie')).toContain('Max-Age=0');
      // Restore the expired row so the API exercises the expiry path, not just a missing session.
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(session));
      await f.env.DB.prepare('INSERT INTO site_news_chat_sessions VALUES(?,?,?)').bind(Buffer.from(digest).toString('hex'), 'test-token', now + 300_000).run();
      const api = await handleNewsChat(f.request(), f.env, { ...f.deps, now: now + 300_000 });
      expect(api.status).toBe(401);
      expect(api.headers.get('Location')).toBeNull();
      expect(api.headers.get('Set-Cookie')).toContain('Max-Age=0');
      expect(f.deps.fetcher).not.toHaveBeenCalled();
      expect(f.run).not.toHaveBeenCalled();
      expect(f.search).not.toHaveBeenCalled();
    } finally { clock.mockRestore(); vi.unstubAllGlobals(); f.close(); }
  });

  it('does not search on an invalid plan, and caps concurrent failed turns', async () => {
    const f = await fixture();
    f.run.mockResolvedValue({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: '{"query":"TGA","from":"2026-02-31","to":"2026-11-17"}' } }] });
    try {
      const results = await Promise.all(Array.from({ length: 6 }, () => handleNewsChat(f.request(), f.env, f.deps)));
      expect(results.map(r => r.status).sort()).toEqual([429, 503, 503, 503, 503, 503]);
      expect(f.run).toHaveBeenCalledTimes(5);
      expect(f.search).not.toHaveBeenCalled();
    } finally { f.close(); }
  });
});
