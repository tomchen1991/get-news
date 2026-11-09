import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { assertPublicHttpsUrl, fetchBounded } from '../http';
import type { NewsItem, SourceAdapter } from '../types';

type ObjectValue = Record<string, unknown>;
const object = (v: unknown): ObjectValue => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as ObjectValue : {};
const array = (v: unknown): unknown[] => v == null ? [] : Array.isArray(v) ? v : [v];
const scalar = (v: unknown): string => typeof v === 'string' || typeof v === 'number' ? String(v) : scalarLeaf(object(v)['#text']);
const scalarLeaf = (v: unknown): string => typeof v === 'string' || typeof v === 'number' ? String(v) : '';
function plain(v: unknown, limit: number): string {
  return scalar(v).replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ').replace(/<[^>]*>/g, ' ').replace(/&(?:amp|lt|gt|quot|apos|nbsp);|&#(?:x[\da-f]+|\d+);/gi, (entity) => {
    const named: Record<string,string> = { '&amp;':'&', '&lt;':'<', '&gt;':'>', '&quot;':'"', '&apos;':"'", '&nbsp;':' ' };
    if (named[entity.toLowerCase()]) return named[entity.toLowerCase()];
    const cp = entity.toLowerCase().startsWith('&#x') ? parseInt(entity.slice(3,-1),16) : parseInt(entity.slice(2,-1),10);
    return cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) ? String.fromCodePoint(cp) : '';
  }).replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ').replace(/<[^>]*>/g, ' ').replace(/\s+/g,' ').trim().slice(0,limit);
}
function link(value: unknown, base: string): string | null {
  const raw = scalar(value).trim();
  if (!raw) return null;
  try { return assertPublicHttpsUrl(new URL(raw, base).href).href; } catch { return null; }
}
function item(raw: unknown, kind: 'json'|'atom'|'rss', base: string): NewsItem | null {
  const row = object(raw);
  let candidate: unknown;
  if (kind === 'json') candidate = row.url || row.external_url;
  else if (kind === 'atom') {
    const links = array(row.link).map(object);
    candidate = links.find(l => !l['@_rel'] || l['@_rel'] === 'alternate')?.['@_href'];
  } else candidate = row.link || row.guid;
  const url = link(candidate, base), title = plain(row.title, 300);
  if (!url || !title) return null;
  const date = scalar(kind === 'json' ? row.date_published : row.pubDate || row.published || row.updated || row['dc:date']);
  const timestamp = Date.parse(date);
  return { externalId: (scalar(row.id || row.guid) || url).slice(0,1000), url, title,
    summary: plain(row.summary || row.description || row.content_text || row.content_html || row['content:encoded'] || row.content, 2000),
    publishedAt: Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null };
}
export function createRssAdapter(fetcher: typeof fetch = fetch): SourceAdapter {
  return { kind: 'rss', async fetch(url, state) {
    const headers = new Headers({ Accept: 'application/rss+xml, application/atom+xml, application/feed+json, application/xml, text/xml, application/json' });
    if (state.etag) headers.set('If-None-Match', state.etag);
    if (state.lastModified) headers.set('If-Modified-Since', state.lastModified);
    const { response, text } = await fetchBounded(url, { headers }, 1_000_000, 10_000, fetcher);
    const etag = response.headers.get('etag') || (response.status === 304 ? state.etag : null) || null;
    const lastModified = response.headers.get('last-modified') || (response.status === 304 ? state.lastModified : null) || null;
    if (response.status === 304) return { items: [], notModified: true, etag, lastModified };
    if (!response.ok) throw new Error(`Feed HTTP ${response.status}`);
    if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(text)) throw new Error('DTD and entity declarations are not allowed');
    const contentType = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
    if (contentType && !['application/rss+xml','application/atom+xml','application/xml','text/xml','application/feed+json','application/json','text/plain'].includes(contentType)) throw new Error('Unsupported feed content type');
    let rows: unknown[], kind: 'json'|'atom'|'rss';
    if (text.trimStart().startsWith('{')) {
      const feed = object(JSON.parse(text));
      if (!scalar(feed.version).startsWith('https://jsonfeed.org/version/') || !Array.isArray(feed.items)) throw new Error('Invalid JSON Feed');
      kind = 'json'; rows = feed.items;
    } else {
      if (XMLValidator.validate(text) !== true) throw new Error('Invalid feed XML');
      const feed = object(new XMLParser({ ignoreAttributes: false, parseTagValue: false, processEntities: true }).parse(text));
      if (feed.feed) { kind = 'atom'; rows = array(object(feed.feed).entry); }
      else if (feed.rss) { kind = 'rss'; rows = array(object(object(feed.rss).channel).item); }
      else throw new Error('Unsupported feed format');
    }
    // Normalize the entire byte-bounded feed before limiting: some publishers
    // emit oldest-first feeds. ES stable sort preserves input order for ties.
    const items = rows.map(row => item(row, kind, url)).filter((v): v is NewsItem => v !== null)
      .sort((a, b) => (b.publishedAt ? Date.parse(b.publishedAt) : -Infinity) - (a.publishedAt ? Date.parse(a.publishedAt) : -Infinity))
      .slice(0,100);
    return { items, notModified: false, etag, lastModified };
  }};
}
