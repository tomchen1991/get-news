import { beforeAll, describe, expect, it, vi } from 'vitest';
import { handleNewsChat } from '../src/site/news-chat';
import { handleSiteRequest, NewsChatLoginLimiter } from '../src/site/index';
import { handleNewsChatAuth } from '../src/site/news-chat-auth';
import type { SiteEnv } from '../src/site/pipeline';
import { createDatabase } from './d1';

const now = Date.parse('2026-11-18T01:00:00Z');
const issuer = 'https://auth.falsita.cn', aud = 'news-client', origin = 'https://news.example';
const session = 'a'.repeat(43), sessionCookie = `__Host-news-chat-session=${session}`;
let privateKey: CryptoKey, jwk: JsonWebKey & { kid: string };
const b64 = (data: object) => Buffer.from(JSON.stringify(data)).toString('base64url');
const discovery = () => Response.json({ issuer, authorization_endpoint: issuer + '/auth', token_endpoint: issuer + '/token',
  jwks_uri: issuer + '/jwks', userinfo_endpoint: issuer + '/me', revocation_endpoint: issuer + '/token/revocation' });
beforeAll(async () => {
  const alg = { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1,0,1]), hash: 'SHA-256' };
  const keys = await crypto.subtle.generateKey(alg, true, ['sign', 'verify']) as CryptoKeyPair;
  jwk = { ...(await crypto.subtle.exportKey('jwk', keys.publicKey) as JsonWebKey), kid: 'test' };
  privateKey = keys.privateKey;
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

  it('returns the login limit before OIDC discovery or any D1 access', async () => {
    const f = await fixture();
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => discovery());
    const prepare = vi.spyOn(f.env.DB, 'prepare'), batch = vi.spyOn(f.env.DB, 'batch');
    const getByName = vi.fn(() => ({ fetch: async () => new Response(null, { status: 429, headers: { 'Retry-After': '42' } }) }));
    const env = { ...f.env, NEWS_CHAT_LOGIN_LIMITER: { getByName } as unknown as DurableObjectNamespace };
    try {
      const response = await handleNewsChatAuth(new Request(origin + '/api/news-chat/login'), env, fetcher);
      expect(response.status).toBe(429);
      expect(response.headers.get('Retry-After')).toBe('42');
      expect(response.headers.get('Cache-Control')).toBe('no-store');
      expect(response.headers.has('Set-Cookie')).toBe(false);
      expect(await response.json()).toEqual({ error: 'login_rate_limit' });
      expect(getByName).toHaveBeenCalledExactlyOnceWith('login');
      expect(fetcher).not.toHaveBeenCalled();
      expect(prepare).not.toHaveBeenCalled();
      expect(batch).not.toHaveBeenCalled();
    } finally { f.close(); }
  });

  it('does not fall back to discovery or D1 when the login limiter is unavailable', async () => {
    const f = await fixture();
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => discovery());
    const prepare = vi.spyOn(f.env.DB, 'prepare');
    const request = new Request(origin + '/api/news-chat/login');
    try {
      f.reserveLogin.mockRejectedValueOnce(new Error('unavailable'));
      expect((await handleNewsChatAuth(request, f.env, fetcher)).status).toBe(503);
      expect((await handleNewsChatAuth(request, { ...f.env, NEWS_CHAT_LOGIN_LIMITER: undefined }, fetcher)).status).toBe(503);
      expect(fetcher).not.toHaveBeenCalled();
      expect(prepare).not.toHaveBeenCalled();
    } finally { f.close(); }
  });

  it('shares a rolling login allowance that survives object recreation', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    const data = new Map<string, unknown>();
    const put = vi.fn((key: string, value: unknown) => data.set(key, value));
    const ctx = { storage: { transactionSync: (op: () => unknown) => op(), kv: { get: (key: string) => data.get(key), put } } } as unknown as DurableObjectState;
    try {
      let limiter = new NewsChatLoginLimiter(ctx);
      expect((await limiter.fetch()).status).toBe(204);
      clock.mockReturnValue(now + 60_000);
      const responses = await Promise.all(Array.from({ length: 5 }, () => limiter.fetch()));
      expect(responses.map(r => r.status)).toEqual([204, 204, 204, 204, 429]);
      expect(responses[4].headers.get('Retry-After')).toBe('240');
      expect(put).toHaveBeenCalledTimes(5);
      limiter = new NewsChatLoginLimiter(ctx);
      clock.mockReturnValue(now + 299_999);
      const denied = await limiter.fetch();
      expect(denied.status).toBe(429);
      expect(denied.headers.get('Retry-After')).toBe('1');
      clock.mockReturnValue(now + 300_000);
      expect((await limiter.fetch()).status).toBe(204);
      expect((await limiter.fetch()).status).toBe(429);
    } finally { clock.mockRestore(); }
  });

  it.each(['valid nonce', 'wrong nonce'])('handles OIDC login with %s, rejects replay, and revokes on logout for valid sessions', async mode => {
    const f = await fixture();
    let nonce = '', challenge = '';
    const tokenCall = vi.fn(), userinfo = vi.fn(), revoke = vi.fn();
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
      switch (new URL(String(input)).pathname) {
        case '/.well-known/openid-configuration': return discovery();
        case '/jwks': return Response.json({ keys: [jwk] });
        case '/token': {
          tokenCall();
          const form = new URLSearchParams(String(init?.body));
          expect(form.get('redirect_uri')).toBe(origin + '/api/news-chat/callback');
          expect(form.get('code')).toBe('valid-code');
          expect(new Headers(init?.headers).get('Authorization')).toBe('Basic ' + btoa('news%2Dclient:test%2Dsecret'));
          expect(Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(form.get('code_verifier')!))).toString('base64url')).toBe(challenge);
          const iat = Math.floor(Date.now() / 1000);
          const token = `${b64({ alg: 'RS256', kid: 'test' })}.${b64({ iss: issuer, aud, sub: 'owner', nonce: mode === 'valid nonce' ? nonce : 'wrong', iat, exp: iat + 300 })}`;
          const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', privateKey, new TextEncoder().encode(token));
          return Response.json({ access_token: 'access', token_type: 'Bearer', expires_in: 300, id_token: `${token}.${Buffer.from(sig).toString('base64url')}` });
        }
        case '/me':
          userinfo();
          expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer access');
          return Response.json({ sub: 'owner' });
        case '/token/revocation':
          revoke(new URLSearchParams(String(init?.body)).get('token'));
          return new Response(null, { status: 200 });
        default: throw new Error('Unexpected URL');
      }
    });
    try {
      const login = await handleNewsChatAuth(new Request(origin + '/api/news-chat/login?next=https://other.example'), f.env, fetcher);
      expect(login.status).toBe(303);
      const target = new URL(login.headers.get('Location')!);
      const state = target.searchParams.get('state');
      nonce = target.searchParams.get('nonce')!;
      challenge = target.searchParams.get('code_challenge')!;
      expect(target.origin).toBe(issuer);
      expect(target.searchParams.get('code_challenge_method')).toBe('S256');
      expect(target.searchParams.get('scope')).toBe('openid profile');
      const cookie = login.headers.get('Set-Cookie')!.split(';')[0];
      const callback = (value: string) => new Request(`${origin}/api/news-chat/callback?code=valid-code&state=${value}&iss=${encodeURIComponent(issuer)}`, { headers: { Cookie: cookie } });
      expect((await handleNewsChatAuth(callback('wrong'), f.env, fetcher)).status).toBe(400);
      const result = await handleNewsChatAuth(callback(state!), f.env, fetcher);
      if (mode === 'wrong nonce') {
        expect(result.status).toBe(503);
        expect(result.headers.get('Location')).toBeNull();
        expect(result.headers.getSetCookie().every(value => !value.startsWith('__Host-news-chat-session='))).toBe(true);
        expect(userinfo).not.toHaveBeenCalled();
        expect((await handleNewsChatAuth(callback(state!), f.env, fetcher)).status).toBe(400);
        expect(tokenCall).toHaveBeenCalledTimes(1);
        return;
      }
      expect(result.status).toBe(303);
      expect(result.headers.get('Location')).toBe('/ask');
      expect(result.headers.get('Cache-Control')).toBe('no-store');
      const session = result.headers.getSetCookie().find(value => value.startsWith('__Host-news-chat-session='))!;
      expect(session).toMatch(/Path=\/; Max-Age=[1-9]\d*; HttpOnly; Secure; SameSite=Lax/);
      expect(session).not.toContain('access');
      expect((await handleNewsChatAuth(callback(state!), f.env, fetcher)).status).toBe(400);
      expect(tokenCall).toHaveBeenCalledTimes(1);
      vi.stubGlobal('fetch', fetcher);
      const ask = new Request(origin + '/ask', { headers: { Cookie: session.split(';')[0] } });
      expect(await (await handleSiteRequest(ask, f.env)).text()).toContain('昨天 TGA 年度游戏有哪些提名');
      const logout = (source: string) => new Request(origin + '/api/news-chat/logout', { method: 'POST', headers: { Origin: source, Cookie: session.split(';')[0] } });
      expect((await handleNewsChatAuth(logout('https://other.example'), f.env, fetcher)).status).toBe(403);
      expect((await handleNewsChatAuth(logout(origin), f.env, fetcher)).status).toBe(204);
      expect(revoke).toHaveBeenCalledExactlyOnceWith('access');
      expect((await handleSiteRequest(ask, f.env)).status).toBe(303);
      expect(f.reserveLogin).toHaveBeenCalledTimes(1);
    } finally { vi.unstubAllGlobals(); f.close(); }
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
