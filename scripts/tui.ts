import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { createTavilySearchProvider, runTui } from '../src/tui';
import { createSearchPlanner, type SearchPlanner } from '../src/search/planner';

// Only load the explicitly selected local file; never log credentials.
if (process.argv.includes('--env-file')) {
 const path = process.argv[process.argv.indexOf('--env-file') + 1];
 if (!path || path.startsWith('--')) { console.error('用法：npm run tui -- --env-file .dev.vars'); process.exit(1); }
 try { process.loadEnvFile(path); } catch { console.error('无法读取环境变量文件。'); process.exit(1); }
}
const key = process.env.TAVILY_API_KEY;
if (!key?.trim()) {
 console.error('请设置 TAVILY_API_KEY，或在 .dev.vars 中填写后运行 npm run tui -- --env-file .dev.vars。');
 process.exit(1);
}
if (!stdin.isTTY || !stdout.isTTY) { console.error('请在交互式终端中运行。'); process.exit(1); }
let planner: SearchPlanner | undefined;
if (process.env.LLM_API_KEY || process.env.LLM_MODEL) {
 try {
  planner = createSearchPlanner({ baseUrl: process.env.LLM_BASE_URL ?? '', apiKey: process.env.LLM_API_KEY ?? '', model: process.env.LLM_MODEL ?? '' });
 } catch { console.error('规划模型配置无效，仍可原样搜索。请检查 LLM_BASE_URL、LLM_MODEL、LLM_API_KEY。'); }
}
const rl = createInterface({ input: stdin, output: stdout });
rl.on('SIGINT', () => { rl.close(); process.exit(130); });
try {
 await runTui({ ask: prompt => rl.question(prompt), print: text => console.log(text) }, createTavilySearchProvider(key), 5, planner);
} finally { rl.close(); }
