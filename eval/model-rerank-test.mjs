#!/usr/bin/env node
/**
 * 模型列表拉取 + 检索重排测试。
 * 内置 mock 模型服务（OpenAI 兼容 /models 与 /chat/completions，带 CORS）。
 *
 * 用法：node eval/model-rerank-test.mjs
 * 依赖 playwright-core（本机隔离工作区已安装），可用环境变量覆盖：
 *   PLAYWRIGHT_CORE=<playwright-core 入口路径>  CHROME_PATH=<chrome.exe 路径>
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { launchBrowser } from './browser-harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const MIME = { '.html': 'text/html; charset=utf-8', '.md': 'text/markdown; charset=utf-8', '.json': 'application/json; charset=utf-8' };

const OPENAI_MODELS = {
  object: 'list',
  data: [
    { id: 'gpt-4o-mini', object: 'model', created: 1715367049, owned_by: 'system' },
    { id: 'qwen-plus', object: 'model', created: 1717000000, owned_by: 'alibaba', context_length: 131072 },
    { id: 'deepseek-chat', object: 'model', created: 1720000000, owned_by: 'deepseek', max_tokens: 8192 },
  ],
};
const OLLAMA_MODELS = {
  models: [
    { name: 'llama3:8b', model: 'llama3:8b', size: 4661224676, details: { family: 'llama', parameter_size: '8.0B', format: 'gguf' } },
  ],
};

function startMockModelServer() {
  const state = { modelStatus: 200, modelPayload: OPENAI_MODELS, rerankStatus: 200, rerankOrder: '[2,1]', authHeader: null, modelCalls: 0, rerankCalls: 0, chatCalls: 0 };
  const server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    const url = new URL(req.url, 'http://127.0.0.1');
    if (req.method === 'GET' && url.pathname.endsWith('/models')) {
      state.modelCalls++;
      state.authHeader = req.headers.authorization || '';
      res.writeHead(state.modelStatus, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(state.modelPayload));
      return;
    }
    if (req.method === 'POST' && url.pathname.endsWith('/chat/completions')) {
      let raw = '';
      req.on('data', chunk => { raw += chunk; });
      req.on('end', () => {
        let body = {};
        try { body = JSON.parse(raw || '{}'); } catch {}
        const system = String(body.messages?.[0]?.content || '');
        if (system.includes('重排器')) {
          state.rerankCalls++;
          if (state.rerankStatus !== 200) { res.writeHead(state.rerankStatus, { 'Content-Type': 'application/json' }); res.end('{"error":"rerank unavailable"}'); return; }
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ choices: [{ message: { content: state.rerankOrder } }] }));
          return;
        }
        state.chatCalls++;
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ choices: [{ message: { content: '根据资料，申请年假需提前办理。[1]' } }] }));
      });
      return;
    }
    res.writeHead(404); res.end();
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, state })));
}

function startStaticServer() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const relative = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname);
    const file = path.join(ROOT, relative);
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port })));
}

const results = [];
function check(name, pass, detail = '') { results.push({ name, pass, detail }); console.log(`${pass ? 'PASS' : 'FAIL'}: ${name}${pass || !detail ? '' : ` — ${detail}`}`); }

const { server: staticServer, port: staticPort } = await startStaticServer();
const { server: mockServer, port: mockPort, state } = await startMockModelServer();
const mockBase = `http://127.0.0.1:${mockPort}/v1`;

const browser = await launchBrowser();
const context = await browser.newContext({ viewport: { width: 1365, height: 1000 } });
const page = await context.newPage();
const browserErrors = [];
page.on('pageerror', error => browserErrors.push(error.message));
// 测试会故意制造 401 / 500 响应，浏览器会把它们打成 console error（"Failed to load resource"）。
// 这属于预期噪声而非页面脚本缺陷，故只统计真正的运行时错误。
page.on('console', message => {
  if (message.type() !== 'error') return;
  const text = message.text();
  if (/Failed to load resource/i.test(text)) return;
  browserErrors.push(text);
});

// 生成式模式渲染 .answer-generated（无 .answer-part-title），
// 证据摘录模式渲染 .answer-part-title。两种模式的来源列表都按最终排序渲染，取其一即可。
const answerTitles = async () => {
  const parts = (await page.locator('#answerPane .answer-part-title').allInnerTexts()).map(text => text.trim()).filter(Boolean);
  if (parts.length) return parts;
  const metas = await page.locator('#answerPane .sources .source-item .source-meta').allInnerTexts();
  return metas.map(text => text.split(' · ')[1]?.trim() || text.trim());
};

try {
  await page.goto(`http://127.0.0.1:${staticPort}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.querySelector('#statDocs')?.textContent === '3');
  await page.locator('.nav button[data-page="manage"]').click();
  await page.waitForTimeout(120);

  // ① 未填 Base URL 时提示
  await page.locator('#llmFetchModels').click();
  await page.waitForTimeout(150);
  let toast = (await page.locator('#toast').innerText()).trim();
  check('未填接口地址时提示先填写', /请先填写接口地址/.test(toast), toast);

  // ② 拉取标准 OpenAI 格式模型列表
  await page.locator('#llmBaseUrl').fill(mockBase);
  await page.locator('#llmApiKey').fill('test-key-123');
  await page.locator('#llmFetchModels').click();
  await page.waitForSelector('#llmModelList .model-item', { timeout: 5000 });
  const items = await page.locator('#llmModelList .model-item').count();
  const firstName = await page.locator('#llmModelList .model-item .model-name').first().innerText();
  const firstMeta = await page.locator('#llmModelList .model-item .model-meta').first().innerText();
  check('拉取到 3 个模型', items === 3, `实际 ${items}`);
  check('展示模型名称', firstName.trim() === 'gpt-4o-mini', firstName);
  check('展示归属与创建时间', /归属 system/.test(firstMeta) && /创建于 \d{4}\/\d{2}\/\d{2}/.test(firstMeta), firstMeta);
  const qwenMeta = await page.locator('#llmModelList .model-item .model-meta').nth(1).innerText();
  check('展示关键属性（上下文长度）', /上下文 131,072 tokens/.test(qwenMeta), qwenMeta);
  const deepseekMeta = await page.locator('#llmModelList .model-item .model-meta').nth(2).innerText();
  check('展示关键属性（最大输出）', /最大输出 8,192/.test(deepseekMeta), deepseekMeta);
  check('请求携带 Authorization 头', state.authHeader === 'Bearer test-key-123', String(state.authHeader));

  // ③ 点击列表项填入模型名
  await page.locator('#llmModelList .model-item').nth(1).click();
  await page.waitForTimeout(120);
  check('点击列表项填入模型名称', (await page.locator('#llmModel').inputValue()) === 'qwen-plus', await page.locator('#llmModel').inputValue());
  check('被选中的模型项被标记', (await page.locator('#llmModelList .model-item.picked').count()) === 1);

  // ④ 非标准（Ollama）响应格式
  state.modelPayload = OLLAMA_MODELS;
  await page.locator('#llmFetchModels').click();
  await page.waitForTimeout(300);
  const ollamaCount = await page.locator('#llmModelList .model-item').count();
  const ollamaName = await page.locator('#llmModelList .model-item .model-name').first().innerText();
  const ollamaMeta = await page.locator('#llmModelList .model-item .model-meta').first().innerText();
  check('非标准格式（Ollama）也能解析', ollamaCount === 1 && ollamaName.trim() === 'llama3:8b', `${ollamaCount} / ${ollamaName}`);
  check('Ollama 参数规模与量化格式被展示', /8\.0B/.test(ollamaMeta) && /gguf/i.test(ollamaMeta) && /GB/.test(ollamaMeta), ollamaMeta);

  // ⑤ 鉴权失败给出提示且不破坏已有功能
  state.modelStatus = 401;
  state.modelPayload = { error: 'invalid api key' };
  await page.locator('#llmFetchModels').click();
  await page.waitForTimeout(300);
  toast = (await page.locator('#toast').innerText()).trim();
  const hint = await page.locator('#llmModelHint').innerText();
  check('鉴权失败时给出可读提示', /拉取失败/.test(toast) && /401/.test(hint), `${toast} | ${hint}`);
  check('失败后模型列表被收起', (await page.locator('#llmModelList .model-item').count()) === 0);

  // ⑥ 恢复标准响应并保存启用（不开启重排）
  state.modelStatus = 200;
  state.modelPayload = OPENAI_MODELS;
  await page.locator('#llmFetchModels').click();
  await page.waitForSelector('#llmModelList .model-item', { timeout: 5000 });
  await page.locator('#llmModelList .model-item').first().click();
  await page.locator('#llmSave').click();
  await page.waitForTimeout(200);
  check('保存并启用后进入生成式模式', /gpt-4o-mini/.test(await page.locator('#llmMode').innerText()), await page.locator('#llmMode').innerText());

  // ⑦ 未开启重排时不应发起重排调用
  await page.locator('.nav button[data-page="ask"]').click();
  await page.locator('#questionInput').fill('年假');
  await page.locator('#askButton').click();
  await page.waitForTimeout(400);
  const beforeTitles = (await answerTitles()).map(text => text.trim());
  const rerankBefore = state.rerankCalls;
  check('未开启重排时不调用重排接口', rerankBefore === 0, `重排调用 ${rerankBefore} 次`);
  check('生成式回答正常返回并标注来源', (await page.locator('#answerPane').innerText()).includes('[1]'));
  check('检索结果多于一条（用于验证重排）', beforeTitles.length >= 2, `实际 ${beforeTitles.length} 条`);

  // ⑧ 开启重排后按模型返回顺序渲染
  await page.locator('.nav button[data-page="manage"]').click();
  await page.locator('#llmRerank').check();
  await page.locator('#llmSave').click();
  await page.waitForTimeout(200);
  check('重排开关状态写入配置面板', /已开启重排/.test(await page.locator('#llmMode').innerText()), await page.locator('#llmMode').innerText());

  await page.locator('.nav button[data-page="ask"]').click();
  await page.locator('#questionInput').fill('年假');
  await page.locator('#askButton').click();
  await page.waitForTimeout(500);
  const afterTitles = (await answerTitles()).map(text => text.trim());
  check('开启重排后确实调用了重排接口', state.rerankCalls > rerankBefore, `重排调用 ${state.rerankCalls} 次`);
  check('重排结果按模型返回的顺序渲染', afterTitles[0] === beforeTitles[1], `重排前首条「${beforeTitles[0]}」→ 重排后首条「${afterTitles[0]}」`);

  // ⑨ 重排服务不可用时静默回退
  state.rerankStatus = 500;
  await page.locator('#questionInput').fill('年假');
  await page.locator('#askButton').click();
  await page.waitForTimeout(500);
  const fallbackTitles = (await answerTitles()).map(text => text.trim());
  check('重排接口失败时回退为原始排序', fallbackTitles[0] === beforeTitles[0], `回退后首条「${fallbackTitles[0]}」`);
  check('重排失败不影响正常作答', (await page.locator('#answerPane').innerText()).includes('[1]'));

  // ⑩ 拉取模型列表写入审计
  await page.locator('.nav button[data-page="audit"]').click();
  await page.waitForTimeout(150);
  const auditText = await page.locator('#auditList').innerText();
  check('拉取模型列表写入操作审计', /拉取模型列表/.test(auditText), auditText.replace(/\s+/g, ' ').slice(0, 160));

  check('无浏览器控制台 / 运行时错误', browserErrors.length === 0, browserErrors.slice(0, 2).join(' | '));
} finally {
  await browser.close();
  staticServer.close();
  mockServer.close();
}

const passed = results.filter(item => item.pass).length;
console.log(`\n================ 模型列表与重排测试结果 ================`);
console.log(`通过 ${passed}/${results.length}`);
if (passed !== results.length) process.exitCode = 1;
