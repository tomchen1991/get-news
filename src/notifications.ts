import { assertPublicHttpsUrl, fetchBounded } from './http';
export type DeliveryResult = 'sent'|'uncertain'|'failed';
export interface Notifier { send(id:string,payload:unknown):Promise<DeliveryResult> }
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
