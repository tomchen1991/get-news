import { describe, expect, it, vi } from 'vitest';
import { fetchNews } from '../src/search/news-fetch';
import { createTavilySearchProvider } from '../src/search/providers';

function setup() {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({
    request_id: 'search-123', usage: { credits: 1 }, results: [
      { url: 'https://www.thegameawards.com/nominees', title: 'Nominees', content: '<b>Full list</b>' },
      { url: 'https://thegameawards.com.example.net/list', title: 'Unrelated source' },
    ],
  }));
  return { fetcher, provider: createTavilySearchProvider('fixture', fetcher) };
}

describe('on-demand news retrieval', () => {
  it('executes one targeted search and returns traceable, source-filtered results', async () => {
    const { fetcher, provider } = setup();
    const result = await fetchNews(provider, { query: ' The Game Awards nominations ', startDate: '2026-11-16', endDate: '2026-11-18', includeDomains: ['TheGameAwards.com'], maxResults: 5 });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toMatchObject({
      query: 'The Game Awards nominations', start_date: '2026-11-16', end_date: '2026-11-18',
      include_domains: ['thegameawards.com'], max_results: 5, search_depth: 'basic', topic: 'news',
    });
    expect(result).toEqual({ query: 'The Game Awards nominations', credits: 1, requestId: 'search-123', items: [
      { title: 'Nominees', summary: 'Full list', url: 'https://www.thegameawards.com/nominees', publishedAt: null },
    ] });
  });

  it.each([
    { query: '' }, { query: 'TGA', startDate: '2026-02-30' }, { query: 'TGA', endDate: '2026-11-18' },
    { query: 'TGA', includeDomains: ['https://thegameawards.com/nominees'] }, { query: 'TGA', maxResults: 11 },
  ])('rejects invalid input before sending a request: %o', async request => {
    const { fetcher, provider } = setup();
    await expect(fetchNews(provider, request)).rejects.toMatchObject({ code: 'invalid_query' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('surfaces provider throttling without retrying', async () => {
    const { fetcher, provider } = setup();
    fetcher.mockResolvedValue(new Response(null, { status: 429 }));
    await expect(fetchNews(provider, { query: 'TGA' })).rejects.toMatchObject({ code: 'rate_limit' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
