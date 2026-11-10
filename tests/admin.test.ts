import { describe, expect, it } from 'vitest';
import { Script } from 'node:vm';
import { handleRequest } from '../src/index';
import { adminAsset } from '../src/admin';
import type { Env } from '../src/types';
describe('static admin shell',()=>{
 it.each(['/admin','/admin/','/admin.js','/admin.css'])('serves %s publicly without accessing D1 or secrets',async path=>{
  const response=await handleRequest(new Request('https://worker.example.com'+path),{ADMIN_TOKEN:'private-admin-secret',WECOM_WEBHOOK_URL:'private-webhook-secret'} as Env);
  expect(response.status).toBe(200);
  expect(response.headers.get('Content-Security-Policy')).toContain("frame-ancestors 'none'");
  expect(response.headers.get('Cache-Control')).toBe('no-store');
  const body=await response.text();
  expect(body).not.toContain('private-admin-secret');
  expect(body).not.toContain('private-webhook-secret');
 });
 it('keeps data and execution endpoints authenticated',async()=>{
  for(const path of ['/api/articles','/api/outbox','/api/status','/api/run']) {
   const response=await handleRequest(new Request('https://worker.example.com'+path,{method:path.endsWith('/run')?'POST':'GET'}),{} as Env);
   expect(response.status).toBe(401);
  }
 });
 it('uses syntactically valid script, text rendering, and no persistent credential storage',async()=>{
  const script=await adminAsset('/admin.js')!.text();
  expect(()=>new Script(script)).not.toThrow();
  expect(script).not.toMatch(/innerHTML|localStorage|sessionStorage|document\.cookie/);
  expect(script).toContain('textContent');
  expect(script).toContain('window.confirm');
  expect(script).toContain("credentials:'omit'");
 });
 it('does not turn unknown routes into an SPA auth bypass',()=>{
  expect(adminAsset('/api/articles')).toBeUndefined();
  expect(adminAsset('/toString')).toBeUndefined();
 });
});
