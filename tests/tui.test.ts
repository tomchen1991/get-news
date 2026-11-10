import { describe, it, expect, vi } from 'vitest';
import { runTui, terminalText } from '../src/tui';
import { SearchError } from '../src/search/providers';
function terminal(inputs: string[]) {
 const output: string[] = [];
 return { output, ask: vi.fn(async () => inputs.shift() ?? '/quit'), print: (text: string) => { output.push(text); } };
}
describe('local Tavily TUI', () => {
 const queries = [{ query: 'AI tools release', reason: '工具' }, { query: '开源模型 发布', reason: '模型' }];
 it('only executes selected planned queries after confirmation', async () => {
  const plan = vi.fn(async () => queries);
  const search = vi.fn(async () => ({ credits: 1, items: [] }));
  await runTui(terminal(['/plan AI新闻', '2', '/quit']), { search }, 5, { plan });
  expect(plan).toHaveBeenCalledExactlyOnceWith('AI新闻');
  expect(search).toHaveBeenCalledExactlyOnceWith({ query: queries[1].query, maxResults: 10 });
 });
 it.each(['', 'yes', '0', '3', '1,3'])('does not search unconfirmed or invalid selection %s', async answer => {
  const search = vi.fn();
  await runTui(terminal(['/plan AI', answer, '/quit']), { search }, 5, { plan: async () => queries });
  expect(search).not.toHaveBeenCalled();
 });
 it('does not partially execute plans over budget', async () => {
  const search = vi.fn();
  await runTui(terminal(['/plan AI', 'all', '/quit']), { search }, 1, { plan: async () => queries });
  expect(search).not.toHaveBeenCalled();
 });
 it('bounds failed planning attempts independently', async () => {
  const plan = vi.fn(async () => { throw new Error('secret'); });
  const search = vi.fn();
  const t = terminal(Array(5).fill('/plan AI'));
  await runTui(t, { search }, 5, { plan });
  expect(plan).toHaveBeenCalledTimes(3);
  expect(search).not.toHaveBeenCalled();
  expect(t.output.join('')).not.toContain('secret');
 });
 it('does not search malformed plans or missing model configuration', async () => {
  const search = vi.fn();
  await runTui(terminal(['/plan AI', '/quit']), { search });
  await runTui(terminal(['/plan AI', '/quit']), { search }, 5, { plan: async () => [] });
  expect(search).not.toHaveBeenCalled();
 });
 it('only searches explicit queries and renders results', async () => {
  const t = terminal(['', '/help', '/unknown', 'AI tools', '/quit']);
  const search = vi.fn(async () => ({ credits: 1, items: [{ externalId: '1', title: 'News', summary: 'Summary', url: 'https://example.com', publishedAt: null }] }));
  await runTui(t, { search });
  expect(search).toHaveBeenCalledExactlyOnceWith({ query: 'AI tools', maxResults: 10 });
  expect(t.output.join('\n')).toContain('日期未知');
  expect(t.output.join('\n')).toContain('https://example.com');
 });
 it('bounds requests including errors and hides raw errors', async () => {
  const t = terminal(Array(10).fill('AI'));
  const search = vi.fn(async () => { throw new Error('secret'); });
  await runTui(t, { search });
  expect(search).toHaveBeenCalledTimes(5);
  expect(t.output.join('\n')).not.toContain('secret');
 });
 it.each(['unauthorized', 'quota', 'rate_limit', 'configuration', 'unavailable'] as const)('stops on %s', async code => {
  const t = terminal(['AI', 'AI']);
  const search = vi.fn(async () => { throw new SearchError(code); });
  await runTui(t, { search });
  expect(search).toHaveBeenCalledTimes(1);
 });
 it('stops on unexpected credits', async () => {
  const search = vi.fn(async () => ({ credits: 2, items: [] }));
  await runTui(terminal(['AI', 'AI']), { search });
  expect(search).toHaveBeenCalledTimes(1);
 });
 it('removes terminal escapes and direction controls', () => {
  const text = terminalText('\x1b[2JTitle\x1b]52;c;payload\x07\u009b\u202e');
  expect(text).not.toMatch(/[\x00-\x1f\x7f-\x9f\u202e]/);
  expect(text).not.toContain('payload');
 });
 it('handles closed input without requests', async () => {
  const search = vi.fn();
  await runTui({ ask: async () => { throw new Error('closed'); }, print: () => {} }, { search });
  expect(search).not.toHaveBeenCalled();
 });
});
