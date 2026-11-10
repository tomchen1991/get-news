import { assertPublicHttpsUrl, fetchBounded } from './http';
export type DeliveryResult = 'sent'|'uncertain'|'failed';
export interface Notifier { send(id:string,payload:unknown):Promise<DeliveryResult> }
/** WeCom group robot: plain text prevents untrusted news from injecting markdown/mentions. */
export function createWecomNotifier(url:string,fetcher:typeof fetch=fetch):Notifier {
 let target:string;
 try {
  const parsed=assertPublicHttpsUrl(url);
  if(parsed.hostname!=='qyapi.weixin.qq.com' || parsed.pathname!=='/cgi-bin/webhook/send' || parsed.hash || !parsed.searchParams.get('key')?.trim() || [...parsed.searchParams.keys()].some(k=>k!=='key') || parsed.searchParams.getAll('key').length!==1) throw new Error();
  target=parsed.href;
 } catch {throw new Error('Invalid WeCom configuration');}
 return {async send(id,payload) {
  let content:string;
  try {
   const p=payload as {type?:string;article?:{title?:unknown;url?:unknown};decision?:{summary?:unknown;reason?:unknown}};
   if(p?.type!=='news.alert' || typeof p.article?.title!=='string' || typeof p.article.url!=='string' || typeof p.decision?.summary!=='string' || typeof p.decision.reason!=='string') return 'failed';
   const link=assertPublicHttpsUrl(p.article.url).href;
   const clean=(s:string)=>s.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g,' ');
   // WeCom text content is limited in UTF-8 bytes, not JavaScript characters.
   const suffix=`\n${link}`;
   if(new TextEncoder().encode(suffix).length>1000) return 'failed';
   const budget=2048-new TextEncoder().encode(suffix).length;
   let prefix='',bytes=0;
   for(const char of `热点快讯\n${clean(p.article.title)}\n${clean(p.decision.summary)}\n推荐理由：${clean(p.decision.reason)}`) {
    const size=new TextEncoder().encode(char).length;
    if(bytes+size>budget) break;
    prefix+=char; bytes+=size;
   }
   content=prefix+suffix;
  } catch {return 'failed';}
  try {
   const {response,text}=await fetchBounded(target,{method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':id},body:JSON.stringify({msgtype:'text',text:{content}})},16_384,10_000,fetcher);
   if(!response.ok) return response.status>=400 && response.status<500?'failed':'uncertain';
   const result:unknown=JSON.parse(text);
   if(!result || typeof result!=='object' || !('errcode' in result) || !Number.isInteger(result.errcode)) return 'uncertain';
   return result.errcode===0?'sent':'failed';
  } catch {return 'uncertain';}
 }};
}
export function createWebhookNotifier(url:string,token:string,fetcher:typeof fetch=fetch):Notifier {
 const target=assertPublicHttpsUrl(url).toString();
 return {async send(id,payload) {
  try {
   const {response}=await fetchBounded(target,{method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':id,...(token?{Authorization:`Bearer ${token}`}:{})},body:JSON.stringify(payload)},16_384,10_000,fetcher);
   if(response.ok) return 'sent';
   // A timeout, 5xx or redirect may happen AFTER the receiver accepted the request.
   return response.status>=400 && response.status<500 ? 'failed':'uncertain';
  } catch { return 'uncertain'; }
 }};
}
