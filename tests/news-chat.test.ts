import { beforeAll, describe, expect, it, vi } from 'vitest';
import { handleNewsChat } from '../src/site/news-chat';
import { handleSiteRequest } from '../src/site/index';
import type { SiteEnv } from '../src/site/pipeline';
import { createDatabase } from './d1';

const now = Date.parse('2026-11-18T01:00:00Z');
const issuer = 'https://fixture.cloudflareaccess.com', aud = 'a'.repeat(64), origin = 'https://news.example';
let jwt: string, jwk: JsonWebKey & { kid: string };
beforeAll(async () => {
  const alg = { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1,0,1]), hash: 'SHA-256' };
  const keys = await crypto.subtle.generateKey(alg, true, ['sign', 'verify']) as CryptoKeyPair;
  jwk = { ...(await crypto.subtle.exportKey('jwk', keys.publicKey) as JsonWebKey), kid: 'test' };
  const b64 = (data: object) => Buffer.from(JSON.stringify(data)).toString('base64url');
  const token = `${b64({ alg: 'RS256', kid: 'test' })}.${b64({ iss: issuer, aud: [aud], type: 'app', iat: now/1000-30, exp: now/1000+300, sub: 'owner', email: 'owner@example.com' })}`;
  const sig = await crypto.subtle.sign(alg.name, keys.privateKey, new TextEncoder().encode(token));
  jwt = `${token}.${Buffer.from(sig).toString('base64url')}`;
});
function fixture() {
  const { db, close } = createDatabase();
  const run = vi.fn().mockResolvedValue({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: '{"query":"The Game Awards nominations","from":"2026-11-17","to":"2026-11-17"}' } }] });
  const search = vi.fn().mockResolvedValue({ items: [{ title: 'TGA nominees', summary: 'Full list', url: 'https://thegameawards.com/nominees', publishedAt: null }], credits: 1 });
  const env: SiteEnv = { DB: db, NEWS_CHAT_ENABLED: 'true', FEEDBACK_ENABLED: 'false', ACCESS_TEAM_DOMAIN: new URL(issuer).hostname, ACCESS_AUD: aud,
    FEEDBACK_ALLOWED_EMAILS: 'owner@example.com', DIGEST_MODEL: 'test/model', AI_GATEWAY_ID: 'test', TAVILY_API_KEY: 'test', AI: { run } };
  const deps = { now, fetcher: vi.fn<typeof fetch>().mockImplementation(async () => Response.json({ keys: [jwk] })), search: { search } };
  const request = (token = jwt, source = origin, message = '阵容公布了吗？') => new Request(origin + '/api/news-chat', { method: 'POST', headers: {
    Origin: source, 'Cf-Access-Jwt-Assertion': token, 'Content-Type': 'application/json',
  }, body: JSON.stringify({ message, history: ['昨天 TGA 有什么新闻？'] }) });
  return { env, deps, run, search, request, close };
}

describe('news chat', () => {
  it('renders the browser conversation and only exposes the navigation when configured', async () => {
    const f = fixture();
    try {
      expect(await (await handleSiteRequest(new Request(origin + '/ask'), f.env)).text()).toContain('昨天 TGA 年度游戏有哪些提名');
      expect(await (await handleSiteRequest(new Request(origin + '/'), f.env)).text()).toContain('href="/ask"');
      const script = await (await handleSiteRequest(new Request(origin + '/news-chat.js'), f.env)).text();
      expect(() => new Function(script)).not.toThrow();
      expect(script).toContain("fetch('/api/news-chat'");
      expect((await handleSiteRequest(new Request(origin + '/ask'), { ...f.env, NEWS_CHAT_ENABLED: 'false' })).status).toBe(404);
    } finally { f.close(); }
  });

  it('uses the main model to resolve a follow-up, executes one search and returns sources', async () => {
    const f = fixture();
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
    const f = fixture();
    try {
      expect((await handleNewsChat(f.request(jwt, 'https://other.example'), f.env, f.deps)).status).toBe(403);
      expect((await handleNewsChat(f.request(''), f.env, f.deps)).status).toBe(401);
      expect((await handleNewsChat(f.request(jwt, origin, 'x'.repeat(801)), f.env, f.deps)).status).toBe(400);
      expect(f.run).not.toHaveBeenCalled();
      expect(f.search).not.toHaveBeenCalled();
    } finally { f.close(); }
  });

  it('does not search on an invalid plan, and caps concurrent failed turns', async () => {
    const f = fixture();
    f.run.mockResolvedValue({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: '{"query":"TGA","from":"2026-02-31","to":"2026-11-17"}' } }] });
    try {
      const results = await Promise.all(Array.from({ length: 6 }, () => handleNewsChat(f.request(), f.env, f.deps)));
      expect(results.map(r => r.status).sort()).toEqual([429, 503, 503, 503, 503, 503]);
      expect(f.run).toHaveBeenCalledTimes(5);
      expect(f.search).not.toHaveBeenCalled();
    } finally { f.close(); }
  });
});
