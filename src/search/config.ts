import type { Env } from '../types';
import type { SearchConfig } from './runner';
import { createTavilySearchProvider,createCloudflareSearchProvider } from './providers';
export function searchConfig(env:Env):SearchConfig|undefined {
 if(env.SEARCH_ENABLED!=='true') return undefined;
 const name=env.SEARCH_PROVIDER??'tavily';
 if(name!=='tavily' && name!=='cloudflare') throw new Error('invalid_search_provider');
 if(name==='tavily' && !env.TAVILY_API_KEY?.trim()) throw new Error('missing_search_credential');
 if(name==='cloudflare' && !env.CF_SEARCH_API_TOKEN?.trim()) throw new Error('missing_search_credential');
 const integer=(v:string|undefined,fallback:number,max:number)=>{const n=v===undefined?fallback:Number(v);if(!Number.isInteger(n)||n<0||n>max)throw new Error('invalid_search_budget');return n;};
 const timezone=env.SEARCH_TIMEZONE??'Asia/Shanghai';
 new Intl.DateTimeFormat('en-US',{timeZone:timezone});
 return {name,timezone,dailyLimit:integer(name==='tavily'?env.TAVILY_DAILY_CREDITS:env.CF_SEARCH_DAILY_REQUESTS,29,1000),monthlyLimit:integer(name==='tavily'?env.TAVILY_MONTHLY_CREDITS:env.CF_SEARCH_MONTHLY_REQUESTS,900,100000),provider:name==='tavily'?createTavilySearchProvider(env.TAVILY_API_KEY??''):createCloudflareSearchProvider({accountId:env.CF_ACCOUNT_ID??'',apiToken:env.CF_SEARCH_API_TOKEN??'',gatewayId:env.CF_SEARCH_GATEWAY_ID,provider:'ceramic'})};
}
