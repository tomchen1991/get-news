import { fetchBounded } from '../http';

export interface AccessEnv {
  FEEDBACK_ENABLED?: string;
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  FEEDBACK_ALLOWED_EMAILS?: string;
}
const cache = new Map<string, { until: number; keys: JsonWebKey[] }>();
export function accessConfigured(env: AccessEnv): boolean {
  return env.FEEDBACK_ENABLED === 'true' && /^[a-z0-9-]+\.cloudflareaccess\.com$/.test(env.ACCESS_TEAM_DOMAIN ?? '') &&
    /^[a-f0-9]{64}$/i.test(env.ACCESS_AUD ?? '') && !!env.FEEDBACK_ALLOWED_EMAILS?.trim();
}
function decode(part: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(part)) throw new Error();
  return Uint8Array.from(atob(part.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
}
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
/** Verify signature, issuer, audience, lifetime and owner allowlist. Never trust identity headers alone. */
export async function accessUser(request: Request, env: AccessEnv, deps: { fetcher?: typeof fetch; now?: number } = {}): Promise<string | null> {
  if (!accessConfigured(env)) return null;
  try {
    const jwt = request.headers.get('Cf-Access-Jwt-Assertion') ?? '';
    if (!jwt || jwt.length > 16384) return null;
    const parts = jwt.split('.'); if (parts.length !== 3) return null;
    const header: unknown = JSON.parse(new TextDecoder().decode(decode(parts[0])));
    const payload: unknown = JSON.parse(new TextDecoder().decode(decode(parts[1])));
    if (!object(header) || header.alg !== 'RS256' || typeof header.kid !== 'string' || header.kid.length > 200 || !object(payload)) return null;
    const now = deps.now ?? Date.now(), seconds = Math.floor(now / 1000);
    const issuer = `https://${env.ACCESS_TEAM_DOMAIN}`;
    const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (payload.iss !== issuer || !audiences.includes(env.ACCESS_AUD) || payload.type !== 'app' ||
        typeof payload.exp !== 'number' || !Number.isFinite(payload.exp) || payload.exp <= seconds ||
        typeof payload.iat !== 'number' || !Number.isFinite(payload.iat) || payload.iat > seconds + 60 || payload.iat >= payload.exp ||
        (payload.nbf !== undefined && (typeof payload.nbf !== 'number' || !Number.isFinite(payload.nbf) || payload.nbf > seconds + 60)) ||
        typeof payload.sub !== 'string' || !payload.sub || payload.sub.length > 256 || typeof payload.email !== 'string') return null;
    const allowed = env.FEEDBACK_ALLOWED_EMAILS!.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    if (!allowed.includes(payload.email.toLowerCase())) return null;
    let keys = cache.get(issuer);
    // Tests use isolated transports; never serve another transport's cached keys.
    if (deps.fetcher || !keys || keys.until <= now) {
      const { response, text } = await fetchBounded(`${issuer}/cdn-cgi/access/certs`, { headers: { Accept: 'application/json' } }, 65536, 5000, deps.fetcher);
      if (!response.ok) return null;
      const raw: unknown = JSON.parse(text);
      if (!object(raw) || !Array.isArray(raw.keys) || raw.keys.length > 16) return null;
      keys = { until: now + 5 * 60000, keys: raw.keys as JsonWebKey[] };
      if (!deps.fetcher) { if (cache.size >= 8) cache.clear(); cache.set(issuer, keys); }
    }
    const key = keys.keys.find(k => (k as JsonWebKey & { kid?: string }).kid === header.kid && k.kty === 'RSA' && (!k.alg || k.alg === 'RS256') && (!k.use || k.use === 'sig'));
    if (!key || typeof key.n !== 'string' || decode(key.n).byteLength < 256) return null;
    const imported = await crypto.subtle.importKey('jwk', key, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    if (!await crypto.subtle.verify('RSASSA-PKCS1-v1_5', imported, decode(parts[2]), new TextEncoder().encode(parts.slice(0, 2).join('.')))) return null;
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${issuer}:${payload.sub}`));
    return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
  } catch { return null; }
}
