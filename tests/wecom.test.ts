import { describe, expect, it, vi } from 'vitest';
import { createWecomNotifier } from '../src/notifications';
import { dependencies } from '../src/index';
import type { Env } from '../src/types';
const url='https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=test-key';
const payload={type:'news.alert',article:{title:'新模型 <script>@all</script>',url:'https://news.example.com/release'},decision:{summary:'摘要',reason:'关注的领域'}};
describe('WeCom group robot',()=>{
 it('sends bounded plain text without mentions and requires business acknowledgement',async()=>{
  const fetcher=vi.fn(async()=>Response.json({errcode:0,errmsg:'ok'}));
  expect(await createWecomNotifier(url,fetcher).send('stable-id',payload)).toBe('sent');
  const calls=fetcher.mock.calls as unknown as [string,RequestInit][];
  expect(calls[0][0]).toBe(url);
  expect(calls[0][1].headers).toMatchObject({'Idempotency-Key':'stable-id'});
  const body=JSON.parse(calls[0][1].body as string);
  expect(body.msgtype).toBe('text');
  expect(body.text.mentioned_list).toBeUndefined();
  expect(body.text.content).toContain(payload.article.url);
  expect(body.text.content).not.toContain('test-key');
 });
 it.each([[{errcode:93000},'failed'],[{errcode:'0'},'uncertain'],[{},'uncertain'],[null,'uncertain']])('classifies business response %j',async(data,result)=>{
  const fetcher=vi.fn(async()=>Response.json(data));
  expect(await createWecomNotifier(url,fetcher).send('id',payload)).toBe(result);
  expect(fetcher).toHaveBeenCalledTimes(1);
 });
 it.each([[400,'failed'],[429,'failed'],[500,'uncertain'],[302,'uncertain']])('classifies HTTP %s',async(status,result)=>{
  expect(await createWecomNotifier(url,async()=>new Response('',{status:Number(status)})).send('id',payload)).toBe(result);
 });
 it('treats malformed acknowledgement and network errors as uncertain without retries',async()=>{
  expect(await createWecomNotifier(url,async()=>new Response('not json')).send('id',payload)).toBe('uncertain');
  const fetcher=vi.fn(async()=>{throw new Error('secret');});
  expect(await createWecomNotifier(url,fetcher).send('id',payload)).toBe('uncertain');
  expect(fetcher).toHaveBeenCalledTimes(1);
 });
 it('bounds UTF-8 bytes while preserving source URL',async()=>{
  const fetcher=vi.fn(async()=>Response.json({errcode:0}));
  await createWecomNotifier(url,fetcher).send('id',{...payload,decision:{summary:'中文😀'.repeat(2000),reason:'理由'}});
  const calls=fetcher.mock.calls as unknown as [string,RequestInit][];
  const content=JSON.parse(calls[0][1].body as string).text.content;
  expect(new TextEncoder().encode(content).length).toBeLessThanOrEqual(2048);
  expect(content.endsWith(payload.article.url)).toBe(true);
 });
 it.each(['https://other.example.com/cgi-bin/webhook/send?key=x','https://qyapi.weixin.qq.com/other?key=x','https://qyapi.weixin.qq.com/cgi-bin/webhook/send','https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=x&key=y'])('rejects invalid targets without exposing secret',target=>{
  expect(()=>createWecomNotifier(target)).toThrow('Invalid WeCom configuration');
 });
 it('fails malformed payload before network I/O',async()=>{
  const fetcher=vi.fn();
  expect(await createWecomNotifier(url,fetcher).send('id',{})).toBe('failed');
  expect(fetcher).not.toHaveBeenCalled();
 });
 it('selects WeCom only when push is enabled',()=>{
  expect(dependencies({PUSH_ENABLED:'false',PUSH_PROVIDER:'wecom'} as Env).notifier).toBeUndefined();
  expect(dependencies({PUSH_ENABLED:'true',PUSH_PROVIDER:'wecom',WECOM_WEBHOOK_URL:url} as Env).notifier).toBeDefined();
  expect(()=>dependencies({PUSH_ENABLED:'true',PUSH_PROVIDER:'wecom'} as Env)).toThrow('Invalid WeCom configuration');
 });
});
