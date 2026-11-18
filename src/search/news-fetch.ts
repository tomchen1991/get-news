import { SearchError, type SearchQuery, type TavilySearchProvider } from './providers';

export interface NewsFetchRequest extends SearchQuery {
  /** Optional hostnames (not URLs) to restrict the search to. */
  includeDomains?: readonly string[];
}

/** One explicit search for a trusted caller. No model, retries, persistence or publication. */
export async function fetchNews(provider: TavilySearchProvider, request: NewsFetchRequest) {
  const query = request.query.trim();
  if (!query || query.length > 1024 || /[\u0000-\u001f\u007f-\u009f]/.test(query)) throw new SearchError('invalid_query');
  const { items, credits, requestId } = await provider.search({ ...request, query });
  return {
    query, credits, requestId,
    items: items.map(({ title, summary, url, publishedAt }) => ({ title, summary, url, publishedAt })),
  };
}
