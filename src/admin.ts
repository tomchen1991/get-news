// Public static shell only. All news/configuration data still requires the admin bearer token.
const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>热点中台</title><link rel="stylesheet" href="/admin.css"><script src="/admin.js" defer></script></head>
<body><main><h1>热点中台</h1><p>查看采集与快讯。早报汇总尚未启用；搜索结果不等于已核实新闻。</p>
<form id="login"><label>管理 Token <input id="token" type="password" required minlength="32" autocomplete="off" spellcheck="false"></label><button>连接</button><button id="logout" type="button">断开</button></form>
<p>Token 仅保存在当前页面内存，不写入浏览器存储。请只在可信设备和 HTTPS / 本地开发地址使用。</p>
<nav id="tabs"><button data-view="status">运行状态</button><button data-view="articles">新闻</button><button data-view="decisions">判断</button><button data-view="outbox">推送</button><button data-view="search">搜索记录</button><button data-view="users">兴趣配置</button></nav>
<section><button id="refresh">刷新</button><button id="run">手动运行一轮（可能收费并推送）</button></section><p id="message" role="status">尚未连接</p><h2 id="heading">运行状态</h2><div id="content"></div>
</main></body></html>`;
const css = `:root{font-family:system-ui,sans-serif;color:#182333;background:#f4f6fa}main{max-width:1100px;margin:32px auto;padding:0 20px}h1{margin-bottom:8px}p{color:#526174;line-height:1.6}form,nav,section{display:flex;gap:10px;flex-wrap:wrap;margin:20px 0}input,button{font:inherit;padding:10px;border:1px solid #cbd5e1;border-radius:6px}input{max-width:70vw;width:340px}button{background:white;cursor:pointer}button:disabled{opacity:.5;cursor:wait}button[aria-current=true]{background:#dceaff}article,pre{background:white;border:1px solid #dce2eb;padding:18px;border-radius:8px;overflow-wrap:anywhere}article{margin:14px 0}pre{white-space:pre-wrap;max-height:650px;overflow:auto}a{color:#1756aa}h3{margin-top:0}#message{font-weight:600}`;
const js = `(() => {
'use strict';
const $ = id => document.getElementById(id);
let token = '', view = 'status', busy = false, generation = 0;
const labels = {status:'运行状态', articles:'新闻（最近 100 条）', decisions:'判断（最近 100 条）', outbox:'推送（最近 100 条）', search:'搜索记录', users:'兴趣配置（只读）'};
function node(tag, text) { const el = document.createElement(tag); el.textContent = text; return el; }
function reset() { generation++; token=''; $('token').value=''; $('content').replaceChildren(); $('message').textContent='已断开'; }
async function api(path, method='GET') {
 const response = await fetch('/api/' + path, {method, headers:{Authorization:'Bearer ' + token}, cache:'no-store', credentials:'omit', redirect:'error'});
 if(response.status===401 || response.status===403) {reset(); throw new Error('认证失败，请检查管理员 Token。');}
 if(!response.ok) throw new Error('请求失败（HTTP ' + response.status + '），请检查服务配置；不自动重试。');
 return response.json();
}
function render(data) {
 $('content').replaceChildren();
 if(view==='articles' && Array.isArray(data)) {
  if(!data.length) $('content').append(node('p','暂无新闻。请先配置用户兴趣并开启采集。'));
  for(const item of data) {
   const card=node('article','');
   card.append(node('h3',item.title || '无标题'),node('p',(item.published_at || '日期未知') + ' · ' + (item.source_id || '')),node('p',item.summary || '暂无摘要'));
   try {const url=new URL(item.url); if(url.protocol==='https:' && !url.username && !url.password) {const a=node('a','阅读原文'); a.href=url.href; a.target='_blank'; a.rel='noopener noreferrer'; card.append(a);}} catch {}
   $('content').append(card);
  }
 } else {
  $('content').append(node('pre',JSON.stringify(data,null,2)));
 }
}
async function load(run=false) {
 if(busy) return;
 if(!token) {$('message').textContent='请先输入管理 Token 并连接。';return;}
 if(run && !window.confirm('将执行真实流水线：开关开启时会消耗搜索/模型额度，并向配置的企业微信群发送符合条件的快讯。确认运行？')) return;
 busy=true; const current= generation;
 document.querySelectorAll('button').forEach(b=>{if(b.id!=='logout') b.disabled=true;});
 $('message').textContent=run?'正在运行，请勿重复操作…':'读取中…';
 try {
  if(run) await api('run','POST');
  if(current!==generation) return;
  const data=await api(view);
  if(current!==generation) return;
  render(data); $('message').textContent=run?'运行完成，状态已刷新。':'已更新（不自动轮询）';
 } catch(error) {if(current===generation) $('message').textContent=error.message;}
 finally {busy=false; document.querySelectorAll('button').forEach(b=>b.disabled=false);}
}
$('login').addEventListener('submit',event=>{event.preventDefault();if(busy)return;generation++;token=$('token').value.trim();$('token').value='';$('content').replaceChildren();void load();});
$('logout').addEventListener('click',reset);
$('refresh').addEventListener('click',()=>void load());
$('run').addEventListener('click',()=>void load(true));
$('tabs').addEventListener('click',event=>{const next=event.target.dataset.view;if(!Object.hasOwn(labels,next)||busy)return;view=next;$('heading').textContent=labels[view];$('content').replaceChildren();document.querySelectorAll('[data-view]').forEach(b=>b.setAttribute('aria-current',String(b.dataset.view===view)));void load();});
})();`;
export function adminAsset(path: string): Response | undefined {
 const assets: Record<string, [string, string]> = {
  '/admin': [html, 'text/html'], '/admin/': [html, 'text/html'], '/admin.js': [js, 'text/javascript'], '/admin.css': [css, 'text/css'],
 };
 if (!Object.hasOwn(assets, path)) return;
 const [body, type] = assets[path];
 return new Response(body, { headers: {
  'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-store',
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
  'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY',
 } });
}
