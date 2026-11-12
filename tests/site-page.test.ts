import { describe, expect, it } from 'vitest';
import { Script } from 'node:vm';
import { siteAsset } from '../src/site/page';

describe('reading-focused site assets', () => {
  it.each(['/', '/daily', '/daily/2026-11-11', '/feedback'])('serves accessible navigation on %s', async path => {
    const response = siteAsset(path)!;
    const html = await response.text();
    expect(html).toContain('lang="zh-CN"');
    expect(html).toContain('href="#news"');
    expect(html).toContain('aria-label="主导航"');
    expect(html).toContain('id="login" hidden');
    expect(html).not.toContain('Jev');
    expect(html).not.toContain('弱参考');
    expect(response.headers.get('Content-Security-Policy')).toContain("script-src 'self'");
    expect(response.headers.get('Content-Security-Policy')).not.toContain('unsafe-inline');
  });
  it('serves syntactically valid JavaScript with text-only rendering and safe external links', async () => {
    const js = await siteAsset('/app.js')!.text();
    expect(() => new Script(js)).not.toThrow();
    expect(js).not.toContain('innerHTML');
    expect(js).toContain("url.protocol!=='https:'");
    expect(js).toContain("link.rel='noopener noreferrer'");
    expect(js).toContain("replace(/^www\\./,'')");
    expect(js).toContain("setAttribute('aria-current','page')");
  });
  it('supports mobile, dark mode, keyboard focus and hidden controls', async () => {
    const response = siteAsset('/app.css')!;
    const css = await response.text();
    expect(response.headers.get('Content-Type')).toContain('text/css');
    for (const rule of ['@media(max-width:600px)', 'prefers-color-scheme:dark', ':focus-visible', '[hidden]', '.digest-body', '.archive-item']) expect(css).toContain(rule);
    expect(css).not.toContain('@import');
  });
});
