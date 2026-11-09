import { describe, it, expect, vi } from 'vitest';
import { createRssAdapter } from '../src/sources/rss';
const source = (body: string, type='application/rss+xml') => createRssAdapter(vi.fn(async () => new Response(body,{headers:{'content-type':type,etag:'"v1"'}})) as unknown as typeof fetch);
const base = 'https://news.example.com/feed';
describe('RSS/Atom/JSON Feed adapter', () => {
  it('normalizes singleton RSS and HTML summary', async () => {
    const result = await source('<rss><channel><item><guid>id1</guid><link>https://news.example.com/a</link><title>Hello &amp; world</title><description><![CDATA[<p>A <b>story</b></p>]]></description><pubDate>Tue, 03 Nov 2026 10:00:00 GMT</pubDate></item></channel></rss>').fetch(base,{});
    expect(result.items[0]).toEqual({externalId:'id1',url:'https://news.example.com/a',title:'Hello & world',summary:'A story',publishedAt:'2026-11-03T10:00:00.000Z'});
    expect(result.etag).toBe('"v1"');
  });
  it('handles Atom alternate links, relative links and text attributes', async () => {
    const result = await source('<feed xmlns="http://www.w3.org/2005/Atom"><entry><id>tag:1</id><title type="text">Atom</title><link rel="self" href="/api"/><link rel="alternate" href="/story"/><summary type="html">&lt;b&gt;Summary&lt;/b&gt;</summary><updated>2026-11-01T01:00:00Z</updated></entry></feed>','application/atom+xml').fetch(base,{});
    expect(result.items[0]).toMatchObject({externalId:'tag:1',url:'https://news.example.com/story',summary:'Summary'});
  });
  it('handles JSON Feed and discards dangerous links', async () => {
    const result = await source(JSON.stringify({version:'https://jsonfeed.org/version/1.1',items:[{id:'a',title:'A',url:'/a',content_html:'<p>Text</p>'},{title:'Bad',url:'javascript:alert(1)'},{title:'Private',url:'https://10.0.0.1/'}]}),'application/feed+json').fetch(base,{});
    expect(result.items).toHaveLength(1); expect(result.items[0].summary).toBe('Text');
  });
  it('sends validators and preserves them on 304', async () => {
    const fetcher = vi.fn(async () => new Response(null,{status:304})) as unknown as typeof fetch;
    const result = await createRssAdapter(fetcher).fetch(base,{etag:'"old"',lastModified:'Yesterday'});
    expect(result).toEqual({items:[],notModified:true,etag:'"old"',lastModified:'Yesterday'});
    const headers = new Headers((vi.mocked(fetcher).mock.calls[0][1] as RequestInit).headers);
    expect(headers.get('if-none-match')).toBe('"old"'); expect(headers.get('if-modified-since')).toBe('Yesterday');
  });
  it('caps items and string lengths', async () => {
    const entry = `<item><title>${'x'.repeat(400)}</title><link>/a</link><description>${'s'.repeat(3000)}</description></item>`;
    const result = await source(`<rss><channel>${entry.repeat(105)}</channel></rss>`).fetch(base,{});
    expect(result.items).toHaveLength(100); expect(result.items[0].title).toHaveLength(300); expect(result.items[0].summary).toHaveLength(2000);
  });
  it('keeps newest 100 from an oldest-first feed and sorts missing dates last stably', async () => {
    const rows = Array.from({length: 105}, (_, n) => `<item><guid>id${n}</guid><title>Item ${n}</title><link>/article/${n}</link><pubDate>${new Date(Date.UTC(2026, 0, 1 + n)).toISOString()}</pubDate></item>`);
    const result = await source(`<rss><channel>${rows.join('')}</channel></rss>`).fetch(base,{});
    expect(result.items).toHaveLength(100);
    expect(result.items[0].externalId).toBe('id104');
    expect(result.items[99].externalId).toBe('id5');
    const stable = await source('<rss><channel><item><title>Missing 1</title><link>/a</link></item><item><title>Dated 1</title><link>/b</link><pubDate>2026-01-01T00:00:00Z</pubDate></item><item><title>Missing 2</title><link>/c</link></item><item><title>Dated 2</title><link>/d</link><pubDate>2026-01-01T00:00:00Z</pubDate></item></channel></rss>').fetch(base,{});
    expect(stable.items.map(item => item.title)).toEqual(['Dated 1','Dated 2','Missing 1','Missing 2']);
  });
  it('retains invalid date as null for engine filtering', async () => expect((await source('<rss><channel><item><title>T</title><link>/a</link><pubDate>wrong</pubDate></item></channel></rss>').fetch(base,{})).items[0].publishedAt).toBeNull());
  it.each(['<!DOCTYPE rss [<!ENTITY x "bad">]><rss><channel/></rss>','<rss><channel></rss>','<html>not a feed</html>'])('rejects unsafe/invalid XML', async body => await expect(source(body).fetch(base,{})).rejects.toThrow());
  it('rejects HTML content types', async () => await expect(source('<rss/>','text/html').fetch(base,{})).rejects.toThrow('content type'));
});
