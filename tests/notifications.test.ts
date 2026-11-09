import { describe,expect,it,vi } from 'vitest';
import { createWebhookNotifier } from '../src/notifications';
describe('generic webhook delivery',()=>{
 it('sends stable idempotency header and JSON with separate bearer secret',async()=>{const fetcher=vi.fn().mockResolvedValue(new Response('',{status:200}));const n=createWebhookNotifier('https://hooks.example.com/ingest','secret',fetcher);expect(await n.send('event-1',{hello:'world'})).toBe('sent');expect(fetcher.mock.calls[0][1].headers).toMatchObject({'Idempotency-Key':'event-1',Authorization:'Bearer secret'});expect(fetcher.mock.calls[0][1].body).toBe('{"hello":"world"}');});
 it.each([400,401,403,404,429])('marks rejection %s failed without retries',async(status)=>{const fetcher=vi.fn().mockResolvedValue(new Response('',{status}));const n=createWebhookNotifier('https://hooks.example.com','',fetcher);expect(await n.send('1',{})).toBe('failed');expect(fetcher).toHaveBeenCalledOnce();});
 it.each([301,302,500,503])('marks potentially accepted %s uncertain',async(status)=>{const fetcher=vi.fn().mockResolvedValue(new Response('',{status}));expect(await createWebhookNotifier('https://hooks.example.com','',fetcher).send('1',{})).toBe('uncertain');});
 it('handles network failure as uncertain and never includes provider error',async()=>{const fetcher=vi.fn().mockRejectedValue(new Error('secret'));expect(await createWebhookNotifier('https://hooks.example.com','',fetcher).send('1',{})).toBe('uncertain');});
});
