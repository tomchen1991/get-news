const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light dark"><title>问新闻 · 拾讯</title><link rel="stylesheet" href="/app.css"><script src="/news-chat.js" defer></script></head><body><a class="skip" href="#question">跳到提问</a><main><div class="masthead"><a class="brand" href="/">拾讯<span>每日值得一读</span></a><nav aria-label="主导航"><a href="/">即时</a><a href="/daily">日报</a><a href="/ask" aria-current="page">问新闻</a><button id="logout" type="button">退出登录</button></nav></div><header><p class="eyebrow">NEWS ON DEMAND</p><h1>今天想看什么新闻？</h1><p>直接用自然语言提问，我会提炼搜索词，帮你找可核对的新闻来源。</p></header><section id="conversation" class="chat-thread" role="log" aria-label="对话记录"></section><form id="ask-form" class="chat-form"><label for="question">你的问题</label><textarea id="question" maxlength="800" required placeholder="例如：昨天 TGA 年度游戏有哪些提名？"></textarea><button id="send" type="submit" disabled>搜索新闻</button><span id="chat-status" role="status"></span></form><noscript>请启用 JavaScript 使用新闻对话。</noscript><footer><span>拾讯</span><span>问题与最近三条提问会发送给主模型；搜索词会发送给 Tavily。</span></footer></main></body></html>`;

const js = `const thread=document.getElementById('conversation'),form=document.getElementById('ask-form'),box=document.getElementById('question'),send=document.getElementById('send'),status=document.getElementById('chat-status');
const history=[];let pending=false;
function el(tag,text){const node=document.createElement(tag);if(text!==undefined)node.textContent=text;return node;}
const errors={401:'登录已失效，请重新登录。',403:'当前会话无权搜索。',429:'搜索额度已用完，请稍后再试。',503:'认证、模型或搜索服务暂不可用，请稍后再试。'};
const logout=document.getElementById('logout');
logout.addEventListener('click',async()=>{
 if(pending)return;
 logout.disabled=true;send.disabled=true;
 try{
  const response=await fetch('/api/news-chat/logout',{method:'POST',credentials:'same-origin',referrerPolicy:'same-origin',cache:'no-store',redirect:'error'});
  if(response.ok){location.assign('/');return;}
 }catch{}
 status.textContent='未能确认退出状态，请刷新核对。';logout.disabled=false;send.disabled=false;
});
form.addEventListener('submit',async event=>{
 event.preventDefault();const message=box.value.trim();if(!message||pending)return;
 const turn=el('article');turn.className='chat-turn';turn.append(el('h2','你'),el('p',message));const reply=el('section');reply.append(el('h2','拾讯'));turn.append(reply);thread.append(turn);
 pending=true;send.disabled=true;box.value='';status.textContent='正在提炼关键词并搜索…';
 try{
  const response=await fetch('/api/news-chat',{method:'POST',credentials:'same-origin',referrerPolicy:'same-origin',cache:'no-store',redirect:'error',headers:{'Content-Type':'application/json'},body:JSON.stringify({message,history:history.slice(-3)})});
  if(!response.ok){
   reply.append(el('p',errors[response.status]||'这次搜索未完成。'));
   if(response.status===401){const login=el('a','重新登录');login.href='/ask';reply.append(login);}
   return;
  }
  const data=await response.json();history.push(message);if(history.length>3)history.shift();
  reply.append(el('p','搜索词：'+data.query+(data.from?' · '+data.from+(data.to!==data.from?' 至 '+data.to:''):' · 最近一天')));
  if(!data.items.length)reply.append(el('p','没有找到匹配的来源。你可以换个说法或放宽日期。'));
  for(const item of data.items){
   const row=el('article');row.className='source-card';const title=el('h3',item.title);
   try{const url=new URL(item.url);if(url.protocol==='https:'&&!url.username&&!url.password){const link=el('a',item.title+' ↗');link.href=url.href;link.target='_blank';link.rel='noopener noreferrer';title.replaceChildren(link);}}catch{}
   row.append(title);if(item.publishedAt)row.append(el('small','来源日期：'+item.publishedAt.slice(0,10)));if(item.summary)row.append(el('p',item.summary));reply.append(row);
  }
 }catch{reply.append(el('p','连接中断或登录已过期，请刷新后再试；未自动重试。'));}
 finally{pending=false;send.disabled=false;status.textContent='';box.focus();}
});
send.disabled=false;`;

export function newsChatAsset(path: string) {
  return new Response(path === '/ask' ? html : js, { headers: {
    'Content-Type': path === '/ask' ? 'text/html; charset=utf-8' : 'text/javascript; charset=utf-8',
    'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
  } });
}
