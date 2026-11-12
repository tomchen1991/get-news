import { assertPublicHttpsUrl, fetchBounded } from '../http';
import type { NewsItem } from '../types';

export interface SearchQuery { query: string; maxResults?: number; startDate?: string; endDate?: string }
export interface SearchResult { items: NewsItem[]; requestId?: string; /** Tavily credits only; CF bills separately, not free. */ credits: number }
export interface SearchProvider { search(request: SearchQuery): Promise<SearchResult> }
export type SearchErrorCode = 'configuration' | 'invalid_query' | 'unauthorized' | 'quota' | 'rate_limit' | 'unavailable' | 'http' | 'transport' | 'invalid_response';
export class SearchError extends Error {
  constructor(readonly code: SearchErrorCode, readonly status?: number, readonly retryAfterMs?: number) {
    super(`Search ${code}${status ? ` (HTTP ${status})` : ''}`); this.name = 'SearchError';
  }
}
type Row = Record<string, unknown>;
const object = (v: unknown): Row => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Row : {};
function plain(v: unknown, max: number): string {
  return typeof v === 'string' ? v.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ').replace(/<[^>]*>/g, ' ').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '';
}
function parameters(input: SearchQuery): { query: string; limit: number } {
  if (typeof input.query !== 'string' || !input.query.trim() || input.query.length > 1024) throw new SearchError('invalid_query');
  const limit = input.maxResults ?? 10;
  if (!Number.isInteger(limit) || limit < 1 || limit > 10) throw new SearchError('invalid_query');
  return { query: input.query.trim(), limit };
}
function normalize(rows: unknown[], summaryField: string, dateField?: string): NewsItem[] {
  const seen = new Set<string>();
  return rows.slice(0, 10).flatMap(raw => {
    const row = object(raw), title = plain(row.title, 300);
    if (!title || typeof row.url !== 'string' || row.url.length > 4096) return [];
    let url: URL;
    try { url = assertPublicHttpsUrl(row.url); } catch { return []; }
    url.hash = '';
    if (seen.has(url.href)) return [];
    seen.add(url.href);
    const date = dateField && typeof row[dateField] === 'string' ? Date.parse(row[dateField] as string) : NaN;
    return [{ externalId: url.href.slice(0, 1000), url: url.href, title, summary: plain(row[summaryField], 2000), publishedAt: Number.isFinite(date) ? new Date(date).toISOString() : null }];
  });
}
function retryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const numeric = /^\d+(?:\.\d+)?$/.test(value.trim());
  const ms = numeric ? Number(value) * 1000 : Date.parse(value) - Date.now();
  return Number.isFinite(ms) && ms >= 0 ? Math.min(ms, 86_400_000) : undefined;
}
async function request(url: string, key: string, body: Row, fetcher: typeof fetch): Promise<Row> {
  if (!key.trim() || /[\r\n]/.test(key)) throw new SearchError('configuration');
  let response: Response, text: string;
  try {
    ({ response, text } = await fetchBounded(url, { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body) }, 1_000_000, 15_000, fetcher));
  } catch { throw new SearchError('transport'); }
  if (!response.ok) {
    const status = response.status;
    const code: SearchErrorCode = status === 401 || status === 403 ? 'unauthorized' : status === 432 || status === 433 ? 'quota' : status === 429 ? 'rate_limit' : status === 434 || status >= 500 ? 'unavailable' : status === 400 || status === 422 ? 'configuration' : 'http';
    throw new SearchError(code, status, retryAfter(response.headers.get('retry-after')));
  }
  try {
    const data: unknown = JSON.parse(text);
    if (data === null || typeof data !== 'object' || Array.isArray(data)) throw new Error();
    return data as Row;
  } catch { throw new SearchError('invalid_response'); }
}

/** https://docs.tavily.com/documentation/api-reference/endpoint/search
 * No automatic retries, upgrades, extraction or answer generation. */
export function createTavilySearchProvider(apiKey: string, fetcher: typeof fetch = fetch): SearchProvider {
  return { async search(input) {
    const { query, limit } = parameters(input);
    for (const date of [input.startDate, input.endDate]) {
      if (date !== undefined && (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date)) throw new SearchError('invalid_query');
    }
    if (input.endDate && (!input.startDate || input.endDate < input.startDate)) throw new SearchError('invalid_query');
    const window = input.startDate ? { start_date: input.startDate, ...(input.endDate ? { end_date: input.endDate } : {}) } : { time_range: 'day' };
    const data = await request('https://api.tavily.com/search', apiKey, { query, topic: 'news', search_depth: 'basic', auto_parameters: false, ...window, max_results: limit, include_answer: false, include_raw_content: false, include_images: false, include_usage: true }, fetcher);
    if (!Array.isArray(data.results)) throw new SearchError('invalid_response');
    const reported = object(data.usage).credits;
    // Missing usage is conservatively charged one basic search. Never trust a
    // negative/zero usage value to replenish the caller's reservation.
    const credits = typeof reported === 'number' && Number.isFinite(reported) && reported >= 1 ? Math.ceil(reported) : 1;
    return { items: normalize(data.results.slice(0, limit), 'content', 'published_date'), requestId: plain(data.request_id, 200) || undefined, credits };
  }};
}
export interface CloudflareSearchOptions { accountId: string; apiToken: string; gatewayId?: string; provider?: 'ceramic' | 'exa' | 'linkup'; byokAlias?: string }
/** Official REST contract, checked 2026-11-09:
 * https://developers.cloudflare.com/web-search/how-to-use/
 * General web search, NOT a news/time-filtered API. Its documented normalized
 * results omit publication date, which must remain unknown. */
export function createCloudflareSearchProvider(options: CloudflareSearchOptions, fetcher: typeof fetch = fetch): SearchProvider {
  return { async search(input) {
    const { query, limit } = parameters(input);
    const provider = options.provider ?? 'ceramic', gatewayId = options.gatewayId ?? 'default';
    if (!/^[a-f\d]{32}$/i.test(options.accountId) || !/^[a-z\d_-]{1,64}$/i.test(gatewayId) || !['ceramic','exa','linkup'].includes(provider) || (options.byokAlias !== undefined && !/^[a-z\d_-]{1,64}$/i.test(options.byokAlias))) throw new SearchError('configuration');
    const data = await request(`https://api.cloudflare.com/client/v4/accounts/${options.accountId}/ai/websearch/`, options.apiToken, { query, provider, limit, options: { gateway: { id: gatewayId } }, ...(options.byokAlias ? { byokAlias: options.byokAlias } : {}) }, fetcher);
    if (!Array.isArray(data.items)) throw new SearchError('invalid_response');
    return { items: normalize(data.items.slice(0, limit), 'description'), requestId: plain(object(data.metadata).requestId, 200) || undefined, credits: 0 };
  }};
}
