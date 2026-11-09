import { describe, expect, it, vi } from 'vitest';
import { createCloudflareSearchProvider, createTavilySearchProvider, SearchError } from '../src/search/providers';
const mock = (body: unknown, status = 200, headers = {}) => vi.fn(async () => new Response(JSON.stringify(body), { status, headers })) as unknown as typeof fetch;
const article = { url: 'https://news.example.com/story', title: '<b>News</b>', content: 'Summary', published_date: '2026-11-09T08:00:00Z' };
describe('Tavily news provider', () => {
  it('pins basic news and disables extra generation, puts secret only in header', async () => {
    const fetcher = mock({ results: [article], request_id: 'request-1', usage: { credits: 1 } });
    const result = await createTavilySearchProvider('secret', fetcher).search({ query: 'AI release' });
    const [url, init] = vi.mocked(fetcher).mock.calls[0];
    expect(url).toBe('https://api.tavily.com/search');
    expect(init?.headers).toMatchObject({ Authorization: 'Bearer secret' });
    expect(init?.redirect).toBe('manual');
    expect(JSON.parse(init?.body as string)).toEqual({ query: 'AI release', topic: 'news', search_depth: 'basic', auto_parameters: false, time_range: 'day', max_results: 10, include_answer: false, include_raw_content: false, include_images: false, include_usage: true });
    expect(result).toMatchObject({ credits: 1, requestId: 'request-1', items: [{ title: 'News', publishedAt: '2026-11-09T08:00:00.000Z' }] });
  });
  it('keeps unknown dates null, drops unsafe links, bounds text and removes duplicates', async () => {
    const fetcher = mock({ results: [{ ...article, published_date: 'nonsense', content: 'x'.repeat(3000) }, article, { ...article, url: 'https://127.0.0.1/secret' }, { ...article, url: 'http://news.example.com/old' }, { ...article, url: 'javascript:alert(1)' }] });
    const { items, credits } = await createTavilySearchProvider('key', fetcher).search({ query: 'AI' });
    expect(items).toHaveLength(1); expect(items[0].publishedAt).toBeNull(); expect(items[0].summary).toHaveLength(2000); expect(credits).toBe(1);
  });
  it.each([0, 11, 1.5, NaN])('rejects invalid result limit %s before network', async limit => {
    const fetcher = mock({ results: [] });
    await expect(createTavilySearchProvider('key', fetcher).search({ query: 'AI', maxResults: limit })).rejects.toMatchObject({ code: 'invalid_query' });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each(['', ' ', 'x'.repeat(1025)])('rejects invalid query locally', async query => {
    const fetcher = mock({ results: [] });
    await expect(createTavilySearchProvider('key', fetcher).search({ query })).rejects.toBeInstanceOf(SearchError); expect(fetcher).not.toHaveBeenCalled();
  });
  it.each([[401,'unauthorized'],[432,'quota'],[433,'quota'],[429,'rate_limit'],[434,'unavailable'],[500,'unavailable'],[422,'configuration']])('classifies HTTP %s without leaking body or retrying', async (status, code) => {
    const fetcher = mock({ detail: 'secret key / private user query' }, status as number, { 'Retry-After': '60' });
    await expect(createTavilySearchProvider('key', fetcher).search({ query: 'AI' })).rejects.toMatchObject({ code, status, retryAfterMs: 60000 });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('sanitizes transport failures and rejects malformed responses', async () => {
    const failing = vi.fn(async () => { throw new Error('leaked key'); }) as unknown as typeof fetch;
    await expect(createTavilySearchProvider('key', failing).search({ query: 'AI' })).rejects.toMatchObject({ message: 'Search transport' });
    await expect(createTavilySearchProvider('key', mock({})).search({ query: 'AI' })).rejects.toMatchObject({ code: 'invalid_response' });
    await expect(createTavilySearchProvider('key', mock({ results: [] }, 302, { Location: 'https://elsewhere.com' })).search({ query: 'AI' })).rejects.toMatchObject({ code: 'transport' });
  });
  it('rejects an oversized response and charges unexpected usage conservatively', async () => {
    await expect(createTavilySearchProvider('key', mock({ results: [] }, 200, { 'Content-Length': '1000001' })).search({ query: 'AI' })).rejects.toMatchObject({ code: 'transport' });
    expect((await createTavilySearchProvider('key', mock({ results: [], usage: { credits: 2 } })).search({ query: 'AI' })).credits).toBe(2);
  });
});
describe('Cloudflare Web Search provider', () => {
  const options = { accountId: 'a'.repeat(32), apiToken: 'cf-secret' };
  it('uses documented REST envelope and does not invent news filters or publication dates', async () => {
    const fetcher = mock({ items: [{ url: article.url, title: 'CF news', description: 'Snippet', published_date: article.published_date }], metadata: { requestId: 'cf-1' } });
    const result = await createCloudflareSearchProvider(options, fetcher).search({ query: 'AI', maxResults: 5 });
    const [url, init] = vi.mocked(fetcher).mock.calls[0];
    expect(url).toBe(`https://api.cloudflare.com/client/v4/accounts/${options.accountId}/ai/websearch/`);
    expect(JSON.parse(init?.body as string)).toEqual({ query: 'AI', limit: 5, provider: 'ceramic', options: { gateway: { id: 'default' } } });
    expect(result).toMatchObject({ credits: 0, requestId: 'cf-1', items: [{ summary: 'Snippet', publishedAt: null }] });
  });
  it('supports explicit BYOK without silently switching providers', async () => {
    const fetcher = mock({ items: [] });
    await createCloudflareSearchProvider({ ...options, provider: 'exa', gatewayId: 'news', byokAlias: 'news-key' }, fetcher).search({ query: 'AI' });
    expect(JSON.parse(vi.mocked(fetcher).mock.calls[0][1]?.body as string)).toMatchObject({ provider: 'exa', byokAlias: 'news-key', options: { gateway: { id: 'news' } } });
  });
  it('rejects account path injection locally and malformed payloads', async () => {
    const fetcher = mock({ results: [] });
    await expect(createCloudflareSearchProvider({ ...options, accountId: '../bad' }, fetcher).search({ query: 'AI' })).rejects.toMatchObject({ code: 'configuration' });
    expect(fetcher).not.toHaveBeenCalled();
    await expect(createCloudflareSearchProvider(options, fetcher).search({ query: 'AI' })).rejects.toMatchObject({ code: 'invalid_response' });
  });
});
