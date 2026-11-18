import { parseArgs } from 'node:util';
import { fetchNews } from '../src/search/news-fetch';
import { createTavilySearchProvider, SearchError } from '../src/search/providers';

const usage = '用法：npm run --silent news:fetch -- [--env-file 文件] [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--domain 域名] [--limit 1-10] "搜索词"';

async function main() {
  let args;
  try {
    args = parseArgs({ allowPositionals: true, options: {
      'env-file': { type: 'string' }, from: { type: 'string' }, to: { type: 'string' },
      domain: { type: 'string', multiple: true }, limit: { type: 'string' }, help: { type: 'boolean' },
    } });
  } catch { throw new Error(usage); }
  const { values, positionals } = args;
  if (values.help) { console.log(usage); return; }
  if (positionals.length !== 1 || (values.limit !== undefined && !/^(?:[1-9]|10)$/.test(values.limit))) throw new Error(usage);
  if (values['env-file'] !== undefined) {
    try { process.loadEnvFile(values['env-file']); } catch { throw new Error('无法读取环境变量文件。'); }
  }
  const key = process.env.TAVILY_API_KEY;
  if (!key?.trim()) throw new Error('请设置 TAVILY_API_KEY，或通过 --env-file 指定配置文件。');
  const result = await fetchNews(createTavilySearchProvider(key), {
    query: positionals[0], startDate: values.from, endDate: values.to, includeDomains: values.domain,
    maxResults: values.limit === undefined ? undefined : Number(values.limit),
  });
  console.log(JSON.stringify(result, null, 2));
}

main().catch(error => {
  console.error(error instanceof SearchError ? `新闻获取失败（${error.code}）；未自动重试。` : error instanceof Error ? error.message : '新闻获取失败。');
  process.exitCode = 1;
});
