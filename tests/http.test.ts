import { describe, it, expect, vi } from 'vitest';
import { assertPublicHttpsUrl, fetchBounded } from '../src/http';
const mock = (response: Response) => vi.fn(async () => response) as unknown as typeof fetch;
describe('public HTTPS safety', () => {
  it.each(['http://news.example.com','https://localhost','https://a.local','https://foo.internal','https://user:pass@news.example.com','https://news.example.com:8443','https://127.0.0.1','https://127.1','https://0x7f000001','https://2130706433','https://10.0.0.1','https://172.16.0.1','https://192.168.1.1','https://169.254.169.254','https://100.64.0.1','https://[::1]','https://[::ffff:127.0.0.1]','https://224.0.0.1','https://198.18.1.1'])('rejects %s', url => expect(() => assertPublicHttpsUrl(url)).toThrow());
  it('allows public HTTPS', () => expect(assertPublicHttpsUrl('https://news.example.com/rss').hostname).toBe('news.example.com'));
  it('rejects redirects', async () => await expect(fetchBounded('https://news.example.com', {}, 100, 1000, mock(new Response('', {status:302,headers:{location:'https://127.0.0.1'}})))).rejects.toThrow('redirect'));
  it('bounds actual UTF8 bytes, not characters', async () => await expect(fetchBounded('https://news.example.com', {}, 3, 1000, mock(new Response('你好')))).rejects.toThrow('byte limit'));
  it('rejects oversized advertised length', async () => await expect(fetchBounded('https://news.example.com', {}, 10, 1000, mock(new Response('x',{headers:{'content-length':'999'}})))).rejects.toThrow('byte limit'));
  it('times out even if the transport ignores abort', async () => {
    const hanging = (() => new Promise<Response>(() => {})) as typeof fetch;
    await expect(fetchBounded('https://news.example.com', {}, 100, 5, hanging)).rejects.toThrow('timeout');
  });
  it('sets manual redirect and a timeout signal', async () => {
    const fetcher = vi.fn(async (_url, init) => new Promise<Response>((_resolve,reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))))) as unknown as typeof fetch;
    await expect(fetchBounded('https://news.example.com', {}, 100, 5, fetcher)).rejects.toThrow('Fetch timeout');
    expect(fetcher).toHaveBeenCalledWith('https://news.example.com/', expect.objectContaining({redirect:'manual'}));
  });
});
