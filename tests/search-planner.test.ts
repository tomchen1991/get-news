import { describe, it, expect, vi } from 'vitest';
import { createSearchPlanner, validatePlan } from '../src/search/planner';
const queries = [{ query: 'AI coding tools release', reason: '具体工具变化' }, { query: '开源模型 发布', reason: '覆盖中文开源动态' }];
const config = { baseUrl: 'https://model.example.com/v1', apiKey: 'secret', model: 'test-model' };
const envelope = (content: unknown) => ({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(content) } }] });
describe('bounded search planner', () => {
 it('makes one bounded tool-free request and validates the plan', async () => {
  const fetcher = vi.fn(async () => Response.json(envelope({ queries })));
  expect(await createSearchPlanner(config, fetcher).plan('AI新闻')).toEqual(queries);
  const [url, init] = (fetcher.mock.calls as unknown as [string, RequestInit][])[0];
  expect(url).toBe('https://model.example.com/v1/chat/completions');
  const body = JSON.parse(init.body as string);
  expect(body.tools).toBeUndefined();
  expect(body.max_tokens).toBe(900);
  expect(JSON.parse(body.messages[1].content)).toEqual({ request: 'AI新闻' });
  expect(fetcher).toHaveBeenCalledTimes(1);
 });
 it.each([{}, { queries: [] }, { queries: [queries[0]] }, { queries: [...queries, ...queries] }, { queries: [queries[0], queries[0]] }, { queries, execute: true }, { queries: [{ ...queries[0], tool: 'fetch' }, queries[1]] }, { queries: [{ query: '\x1b[2J', reason: 'x' }, queries[1]] }])('fails closed for malformed plans', value => {
  expect(() => validatePlan(value)).toThrow();
 });
 it('sanitizes provider errors without retries', async () => {
  const fetcher = vi.fn(async () => { throw new Error('secret'); });
  await expect(createSearchPlanner(config, fetcher).plan('AI')).rejects.toThrow('planner_failed');
  expect(fetcher).toHaveBeenCalledTimes(1);
 });
 it('rejects tool calls', async () => {
  const data = envelope({ queries });
  Object.assign(data.choices[0].message, { tool_calls: [{ name: 'search' }] });
  await expect(createSearchPlanner(config, async () => Response.json(data)).plan('AI')).rejects.toThrow('planner_failed');
 });
 it('rejects private endpoints and invalid input before I/O', async () => {
  expect(() => createSearchPlanner({ ...config, baseUrl: 'https://127.0.0.1' })).toThrow();
  const fetcher = vi.fn();
  await expect(createSearchPlanner(config, fetcher).plan('x'.repeat(1025))).rejects.toThrow();
  expect(fetcher).not.toHaveBeenCalled();
 });
});
