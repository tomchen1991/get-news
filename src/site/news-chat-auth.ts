import * as oidc from 'openid-client';
import { loginSourceBucket, loginSourceHeader } from './news-chat-login-limit';

export interface NewsChatAuthEnv {
  DB: D1Database;
  APP_ORIGIN?: string;
  OIDC_ISSUER?: string;
  OIDC_CLIENT_ID?: string;
  OIDC_CLIENT_SECRET?: string;
  NEWS_CHAT_LOGIN_LIMITER?: DurableObjectNamespace;
}

const issuer = 'https://auth.falsita.cn';
const callback = '/api/news-chat/callback';
const stateCookie = '__Host-news-chat-state', sessionCookie = '__Host-news-chat-session';
const loginLifetime = 300, sessionLifetime = 900;
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
const redirect = (location: string, cookies: string[] = []) => {
  const response = new Response(null, { status: 303, headers: { ...headers, Location: location } });
  for (const value of cookies) response.headers.append('Set-Cookie', value);
  return response;
};
export function newsChatAuthError(status: number, extra: HeadersInit = {}) {
  const errors: Record<number, string> = { 400: 'invalid_login', 401: 'unauthorized', 403: 'forbidden', 405: 'method_not_allowed', 429: 'login_rate_limit', 503: 'auth_unavailable' };
  return Response.json({ error: errors[status] }, { status, headers: { ...headers, ...extra } });
}

async function configuration(env: NewsChatAuthEnv, fetcher: typeof fetch) {
  const config = settings(env);
  if (!config) throw new Error('Missing OIDC configuration');
  const client = await oidc.discovery(new URL(issuer), config.id, { id_token_signed_response_alg: 'RS256' }, oidc.ClientSecretBasic(config.secret), {
    [oidc.customFetch]: (url, init) => {
      if (new URL(url).origin !== issuer) throw new Error('Unexpected OIDC origin');
      return fetcher(url, { ...init, redirect: 'error' });
    }, timeout: 5,
  });
  const metadata = client.serverMetadata();
  for (const key of ['authorization_endpoint', 'token_endpoint', 'userinfo_endpoint', 'jwks_uri', 'revocation_endpoint'] as const) {
    const endpoint = metadata[key];
    if (!endpoint || new URL(endpoint).origin !== issuer) throw new Error('Unexpected OIDC endpoint');
  }
  if (metadata.userinfo_endpoint !== `${issuer}/me`) throw new Error('Unexpected userinfo endpoint');
  oidc.enableNonRepudiationChecks(client);
  return client;
}

type AuthStatus = 200 | 401 | 403 | 503;
async function checkOwner(token: string, fetcher: typeof fetch): Promise<AuthStatus> {
  try {
    const response = await fetcher(`${issuer}/me`, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }, redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(5000) });
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
  const method = logout ? 'POST' : 'GET';
  if (request.method !== method) return newsChatAuthError(405, { Allow: method });
  if (logout && !sameOriginPost(request)) return newsChatAuthError(403);
  const clearState = cookie(stateCookie, '', 0), now = Date.now();
  try {
    if (logout) {
      const value = readCookie(request, sessionCookie);
      const row = value ? await env.DB.prepare('DELETE FROM site_news_chat_sessions WHERE session_hash=? RETURNING access_token').bind(await hash(value)).first<Session>() : null;
      if (row) {
        try { await oidc.tokenRevocation(await configuration(env, fetcher), row.access_token, { token_type_hint: 'access_token' }); }
        catch { return newsChatAuthError(503, { 'Set-Cookie': clearNewsChatSession() }); }
      }
      return new Response(null, { status: 204, headers: { ...headers, 'Set-Cookie': clearNewsChatSession() } });
    }
    if (url.pathname === '/api/news-chat/login') {
      // Use Cloudflare's client address, not user-supplied forwarding headers.
      const source = loginSourceBucket(request.headers.get('CF-Connecting-IP'));
      const slot = await env.NEWS_CHAT_LOGIN_LIMITER?.getByName('login').fetch('https://news-chat-login-limit.internal/', {
        headers: { [loginSourceHeader]: await hash(source) },
      });
      if (slot?.status === 429) {
        const retryAfter = slot.headers.get('Retry-After');
        return newsChatAuthError(429, retryAfter ? { 'Retry-After': retryAfter } : {});
      }
      if (slot?.status !== 204) return newsChatAuthError(503);
      const client = await configuration(env, fetcher);
      const state = oidc.randomState(), nonce = oidc.randomNonce(), verifier = oidc.randomPKCECodeVerifier();
      const target = oidc.buildAuthorizationUrl(client, { redirect_uri: config.origin + callback, response_type: 'code', scope: 'openid profile', state, nonce,
        code_challenge_method: 'S256', code_challenge: await oidc.calculatePKCECodeChallenge(verifier) });
      await env.DB.batch([
        env.DB.prepare('DELETE FROM site_news_chat_logins WHERE expires_at<=?').bind(now),
        env.DB.prepare('DELETE FROM site_news_chat_sessions WHERE expires_at<=?').bind(now),
        env.DB.prepare('INSERT INTO site_news_chat_logins(state_hash,nonce,verifier,expires_at) VALUES(?,?,?,?)').bind(await hash(state), nonce, verifier, now + loginLifetime * 1000),
      ]);
      return redirect(target.href, [cookie(stateCookie, state, loginLifetime)]);
    }
    const state = readCookie(request, stateCookie);
    if (!state || url.searchParams.get('state') !== state) return newsChatAuthError(400);
    const pending = await env.DB.prepare('DELETE FROM site_news_chat_logins WHERE state_hash=? AND expires_at>? RETURNING nonce,verifier').bind(await hash(state), now).first<{ nonce: string; verifier: string }>();
    if (!pending || !url.searchParams.has('code') || url.searchParams.has('error')) return newsChatAuthError(400, { 'Set-Cookie': clearState });
    const client = await configuration(env, fetcher);
    const tokens = await oidc.authorizationCodeGrant(client, url, { expectedState: state, expectedNonce: pending.nonce, pkceCodeVerifier: pending.verifier, idTokenExpected: true });
    if (tokens.claims()?.sub !== 'owner') return newsChatAuthError(403, { 'Set-Cookie': clearState });
    const status = await checkOwner(tokens.access_token, fetcher);
    if (status !== 200) return newsChatAuthError(status, { 'Set-Cookie': clearState });
    const age = Math.min(sessionLifetime, tokens.expiresIn() ?? sessionLifetime);
    if (!Number.isSafeInteger(age) || age <= 0) return newsChatAuthError(401, { 'Set-Cookie': clearState });
    const session = oidc.randomState();
    await env.DB.prepare('INSERT INTO site_news_chat_sessions(session_hash,access_token,expires_at) VALUES(?,?,?)').bind(await hash(session), tokens.access_token, Date.now() + age * 1000).run();
    return redirect('/ask', [clearState, cookie(sessionCookie, session, age)]);
  } catch (error) {
    if (error instanceof oidc.ResponseBodyError && error.error === 'invalid_grant') return newsChatAuthError(401, { 'Set-Cookie': clearState });
    return newsChatAuthError(503, { 'Set-Cookie': clearState });
  }
}
