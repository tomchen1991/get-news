import { createTavilySearchProvider, SearchError, type SearchProvider } from './search/providers';
import type { NewsItem } from './types';
import { validatePlan, type SearchPlanner } from './search/planner';

// Feed and search text is untrusted, including terminal control sequences.
export function terminalText(value: string): string {
 return value.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
  .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
  .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, ' ');
}
export function renderItem(item: NewsItem, index: number): string {
 return `${index + 1}. ${terminalText(item.title)}\n   ${terminalText(item.publishedAt ?? '日期未知')}\n   ${terminalText(item.summary || '暂无摘要')}\n   ${terminalText(item.url)}`;
}
export interface Terminal { ask(prompt: string): Promise<string>; print(text: string): void }
/** Local preview only: no D1, judging, notification, background calls or retries. */
export async function runTui(terminal: Terminal, provider: SearchProvider, maxAttempts = 5, planner?: SearchPlanner): Promise<void> {
 terminal.print('热点搜索 · Tavily News\n输入关键词搜索最近一天的新闻；/help 帮助，/quit 退出。\n查询会发送给 Tavily，basic 搜索通常消耗 1 credit。\n本次会话最多 5 次请求（失败也计数）；重启会重置，不共享 D1 预算。');
 terminal.print('新增：/plan 你的需求 → 模型拟词 → 选择编号确认搜索。规划会外发需求并产生模型费用，每会话最多 3 次。');
 let attempts = 0, planningAttempts = 0;
 while (attempts < maxAttempts) {
  let query: string;
  try { query = (await terminal.ask(`\n搜索 [${attempts}/${maxAttempts}] > `)).trim(); } catch { return; }
  if (query === '/quit' || query === '/q') return;
  if (!query) continue;
  if (query === '/help') {
   terminal.print('直接输入关键词原样搜索；/plan 最近有什么值得关注的 AI 开发工具，让模型拟定 2–3 个查询。确认时输入编号（如 1,3）或 all；其他输入取消。无自动扩搜、无模型筛选、无推送。Ctrl+C 或 /quit 退出。');
   continue;
  }
  let queries = [query];
  if (query === '/plan' || query.startsWith('/plan ')) {
   const request = query.slice(5).trim();
   if (!request || request.length > 1024) { terminal.print('用法：/plan 你的需求（1–1024 字符）'); continue; }
   if (!planner) { terminal.print('未配置规划模型：请设置 LLM_BASE_URL、LLM_MODEL、LLM_API_KEY 后重启。'); continue; }
   if (planningAttempts >= 3) { terminal.print('已达到本会话 3 次规划上限，仍可原样搜索。'); continue; }
   planningAttempts++;
   terminal.print(`规划中… [${planningAttempts}/3]`);
   try {
    const plan = validatePlan({ queries: await planner.plan(request) });
    plan.forEach((item, index) => terminal.print(`${index + 1}. ${terminalText(item.query)}\n   理由：${terminalText(item.reason)}`));
    terminal.print(`每条选中的查询预计消耗 1 Tavily credit；剩余请求额度 ${maxAttempts - attempts}。未经确认不会搜索。`);
    let answer: string;
    try { answer = (await terminal.ask('执行编号（例如 1,3）或 all；回车取消 > ')).trim(); } catch { return; }
    if (answer === '/quit' || answer === '/q') return;
    const indexes = answer === 'all' ? plan.map((_, i) => i) : /^\d+(?:\s*,\s*\d+)*$/.test(answer) ? [...new Set(answer.split(',').map(n => Number(n.trim()) - 1))] : [];
    if (!indexes.length || indexes.some(i => i < 0 || i >= plan.length)) { terminal.print('已取消，未调用搜索。'); continue; }
    if (indexes.length > maxAttempts - attempts) { terminal.print('选择数量超过剩余额度，未执行。请减少选择或原样搜索。'); continue; }
    queries = indexes.map(i => plan[i].query);
   } catch { terminal.print('规划失败或返回格式不合法，未搜索、未自动重试。'); continue; }
  } else if (query.startsWith('/') || query.length > 1024) { terminal.print('请输入 1–1024 字符的搜索词，或 /help。'); continue; }
  for (const query of queries) {
  terminal.print(`查询：${terminalText(query)}`);
  attempts++;
  terminal.print('搜索中…');
  try {
   const result = await provider.search({ query, maxResults: 10 });
   terminal.print(`\n找到 ${result.items.length} 条 · 本次 ${result.credits} credit(s)\n搜索排名不代表热度，日期与摘要未经独立核验。`);
   result.items.forEach((item, index) => terminal.print(`\n${renderItem(item, index)}`));
   if (!result.items.length) terminal.print('暂无结果，可以换一个更宽泛的关键词。');
   if (result.credits > 1) { terminal.print('费用超出 basic 预期，已停止本次会话。'); return; }
  } catch (error) {
   const code = error instanceof SearchError ? error.code : 'unknown';
   terminal.print(`搜索失败（${code}），未自动重试；本次尝试仍计入上限。`);
   // Honor provider throttling by ending the session rather than allowing immediate retries.
   if (['unauthorized', 'configuration', 'quota', 'rate_limit', 'unavailable'].includes(code)) return;
  }
  }
 }
 terminal.print('已达到会话请求上限，退出。请在 Tavily 控制台检查账户用量。');
}
export { createTavilySearchProvider };
