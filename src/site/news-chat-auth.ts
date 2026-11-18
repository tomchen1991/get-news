import { loginSourceBucket, loginSourceHeader } from './news-chat-login-limit';
import { newsChatLoginPage } from './news-chat-page';

export interface NewsChatAuthEnv {
  DB: D1Database;
  APP_ORIGIN?: string;
  OIDC_ISSUER?: string;
  OIDC_CLIENT_ID?: string;
  OIDC_CLIENT_SECRET?: string;
  NEWS_CHAT_LOGIN_LIMITER?: DurableObjectNamespace;
}

const issuer = 'https://auth.falsita.cn';
const totpGrant = 'urn:falsita:params:oauth:grant-type:totp';
const sessionCookie = '__Host-news-chat-session';
const sessionLifetime = 900;
const opaque = /^[A-Za-z0-9_-]{43}$/;
const headers = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' };

function settings(env: NewsChatAuthEnv) {
  if (env.OIDC_ISSUER !== issuer || !env.OIDC_CLIENT_ID?.trim() || !env.OIDC_CLIENT_SECRET?.trim()) return null;
  try {
    const origin = new URL(env.APP_ORIGIN ?? '');
    if (origin.protocol !== 'https:' || env.APP_ORIGIN !== origin.origin) return null;
    return { origin: origin.origin, id: env.OIDC_CLIENT_ID, secret: env.OIDC_CLIENT_SECRET };
  } catch { return null; }
}
export const newsChatAuthConfigured = (env: NewsChatAuthEnv) => !!settings(env);
export function sameOriginPost(request: Request) {
  return request.headers.get('Origin') === new URL(request.url).origin && request.headers.get('Sec-Fetch-Site') !== 'cross-site';
}
function readCookie(request: Request, name: string) {
  const matches = (request.headers.get('Cookie') ?? '').split(';').map(part => part.trim()).filter(part => part.startsWith(`${name}=`));
  const value = matches.length === 1 ? matches[0].slice(name.length + 1) : '';
  return opaque.test(value) ? value : null;
}
const cookie = (name: string, value: string, age: number) => `${name}=${value}; Path=/; Max-Age=${age}; HttpOnly; Secure; SameSite=Lax`;
export const clearNewsChatSession = () => cookie(sessionCookie, '', 0);
async function hash(value: string) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), byte => byte.toString(16).padStart(2, '0')).join('');
}
function randomSession() {
  return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}
export function newsChatAuthError(status: number, extra: HeadersInit = {}) {
  const errors: Record<number, string> = { 400: 'invalid_login', 401: 'unauthorized', 403: 'forbidden', 405: 'method_not_allowed', 429: 'login_rate_limit', 503: 'auth_unavailable' };
  return Response.json({ error: errors[status] }, { status, headers: { ...headers, ...extra } });
}

function authPost(endpoint: '/token' | '/token/revocation', config: { id: string; secret: string }, fields: Record<string, string>, fetcher: typeof fetch) {
  // Fixed endpoints from the Auth contract. Never forward credentials or codes to redirects.
  const encode = (value: string) => new URLSearchParams({ v: value }).toString().slice(2);
  return fetcher(issuer + endpoint, { method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(5000),
    headers: { Authorization: 'Basic ' + btoa(`${encode(config.id)}:${encode(config.secret)}`), Accept: 'application/json' },
    body: new URLSearchParams(fields),
  });
}

async function readCode(request: Request) {
  if (request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/x-www-form-urlencoded' || !request.body) return null;
  const reader = request.body.getReader(), decoder = new TextDecoder();
  let size = 0, input = '';
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 256) { await reader.cancel(); return null; }
      input += decoder.decode(part.value, { stream: true });
    }
    const form = new URLSearchParams(input + decoder.decode()), code = form.get('code')?.trim() ?? '';
    return form.size === 1 && /^[0-9]{6}$/.test(code) ? code : null;
  } catch { return null; }
  finally { reader.releaseLock(); }
}

type AuthStatus = 200 | 401 | 403 | 503;
async function checkOwner(token: string, fetcher: typeof fetch): Promise<AuthStatus> {
  try {
    const response = await fetcher(`${issuer}/me`, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }, redirect: 'manual', cache: 'no-store', signal: AbortSignal.timeout(5000) });
    if (response.status === 401) return 401;
    if (response.status !== 200) return 503;
    const user: unknown = await response.json();
    if (!user || typeof user !== 'object' || !('sub' in user) || typeof user.sub !== 'string' || !user.sub) return 503;
    return user.sub === 'owner' ? 200 : 403;
  } catch { return 503; }
}

type Session = { access_token: string; expires_at: number };
export async function authorizeNewsChat(request: Request, env: NewsChatAuthEnv, deps: { fetcher?: typeof fetch; now?: number } = {}): Promise<AuthStatus> {
  const config = settings(env);
  if (!config) return 503;
  if (new URL(request.url).origin !== config.origin) return 403;
  const session = readCookie(request, sessionCookie);
  if (!session) return 401;
  try {
    const id = await hash(session);
    const row = await env.DB.prepare('SELECT access_token,expires_at FROM site_news_chat_sessions WHERE session_hash=?').bind(id).first<Session>();
    if (!row) return 401;
    const status = row.expires_at <= (deps.now ?? Date.now()) ? 401 : await checkOwner(row.access_token, deps.fetcher ?? fetch);
    if (status === 401) await env.DB.prepare('DELETE FROM site_news_chat_sessions WHERE session_hash=?').bind(id).run();
    return status;
  } catch { return 503; }
}

export async function handleNewsChatAuth(request: Request, env: NewsChatAuthEnv, fetcher = fetch) {
  const config = settings(env), url = new URL(request.url), logout = url.pathname === '/api/news-chat/logout';
  if (!config) return newsChatAuthError(503);
  if (url.origin !== config.origin) return newsChatAuthError(403);
  if (!logout && request.method === 'GET') return newsChatLoginPage();
  if (request.method !== 'POST') return newsChatAuthError(405, { Allow: logout ? 'POST' : 'GET, POST' });
  if (!sameOriginPost(request)) return newsChatAuthError(403);
  const now = Date.now();
  try {
    if (logout) {
      const value = readCookie(request, sessionCookie);
      const row = value ? await env.DB.prepare('DELETE FROM site_news_chat_sessions WHERE session_hash=? RETURNING access_token').bind(await hash(value)).first<Session>() : null;
      if (row) {
        try {
          const result = await authPost('/token/revocation', config, { token: row.access_token, token_type_hint: 'access_token' }, fetcher);
          if (!result.ok) throw new Error('Token revocation failed');
        } catch { return newsChatAuthError(503, { 'Set-Cookie': clearNewsChatSession() }); }
      }
      return new Response(null, { status: 204, headers: { ...headers, 'Set-Cookie': clearNewsChatSession() } });
    }
    const code = await readCode(request);
    if (!code) return newsChatLoginPage(400);
    // Use Cloudflare's client address, not user-supplied forwarding headers.
    const source = loginSourceBucket(request.headers.get('CF-Connecting-IP'));
    const slot = await env.NEWS_CHAT_LOGIN_LIMITER?.getByName('login').fetch('https://news-chat-login-limit.internal/', {
      headers: { [loginSourceHeader]: await hash(source) },
    });
    if (slot?.status === 429) return newsChatLoginPage(429, slot.headers.get('Retry-After'));
    if (slot?.status !== 204) return newsChatLoginPage(503);
    const response = await authPost('/token', config, { grant_type: totpGrant, code, scope: 'openid profile' }, fetcher);
    const receivedAt = Date.now();
    if (response.status === 429) return newsChatLoginPage(429, response.headers.get('Retry-After'));
    if (response.status === 400 && (await response.json() as { error?: string } | null)?.error === 'invalid_grant') return newsChatLoginPage(401);
    if (response.status !== 200) return newsChatLoginPage(503);
    const token = await response.json() as { access_token?: unknown; token_type?: unknown; expires_in?: unknown } | null;
    if (!token || typeof token.access_token !== 'string' || !/^[A-Za-z0-9._~+/=-]{1,4096}$/.test(token.access_token) ||
        typeof token.token_type !== 'string' || token.token_type.toLowerCase() !== 'bearer' ||
        typeof token.expires_in !== 'number' || !Number.isSafeInteger(token.expires_in) || token.expires_in <= 0) return newsChatLoginPage(503);
    const status = await checkOwner(token.access_token, fetcher);
    if (status !== 200) return newsChatLoginPage(status);
    const expiresAt = receivedAt + Math.min(sessionLifetime, token.expires_in) * 1000;
    const age = Math.floor((expiresAt - Date.now()) / 1000);
    if (age <= 0) return newsChatLoginPage(401);
    const session = randomSession();
    await env.DB.batch([
      env.DB.prepare('DELETE FROM site_news_chat_sessions WHERE expires_at<=?').bind(Date.now()),
      env.DB.prepare('INSERT INTO site_news_chat_sessions(session_hash,access_token,expires_at) VALUES(?,?,?)').bind(await hash(session), token.access_token, expiresAt),
    ]);
    return new Response(null, { status: 303, headers: { ...headers, Location: '/ask', 'Set-Cookie': cookie(sessionCookie, session, age) } });
  } catch {
    return logout ? newsChatAuthError(503) : newsChatLoginPage(503);
  }
}
