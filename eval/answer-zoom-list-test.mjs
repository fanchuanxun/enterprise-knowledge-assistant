#!/usr/bin/env node
/**
 * 回答展示测试：验证两处修复
 *   A. 生成式回答里的 Markdown 列表，项目符号与文本必须在同一行
 *      （原缺陷：.doc-md-list 的网格布局只作用于 .doc-view-body，
 *        生成式容器 .answer-generated 下标记与块级 <p> 各占一行）
 *   B. 生成式回答必须可点击放大，且放大视图里同时给出
 *      「模型生成的回答」与「来源原文（逐字摘录）」，便于核对是否与文档一致
 *      并提供「查看原文证据」一键切换到逐字原文模式
 *
 * 用法：node eval/answer-zoom-list-test.mjs
 * 环境变量：PLAYWRIGHT_CORE=<playwright-core 入口>  CHROME_PATH=<chrome.exe 路径>
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { launchBrowser } from './browser-harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const MIME = { '.html': 'text/html; charset=utf-8', '.md': 'text/markdown; charset=utf-8', '.json': 'application/json; charset=utf-8' };
const readBody = req => new Promise(resolve => { let data = ''; req.on('data', chunk => { data += chunk; }); req.on('end', () => resolve(data)); });

// 模型返回一段「分点作答」的结果，用来检验列表渲染
const MODEL_REPLY = [
  '差旅报销需要以下材料：',
  '- 经审批的出差申请 [1]',
  '- 合规票据及费用明细 [1]',
  '- 住宿费：住宿发票和订单或入住凭证 [1]',
  '- 交通费：对应的车票、行程凭证或电子客票凭证 [1]',
].join('\n');
const LIST_ITEM_COUNT = 4;

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  const url = new URL(req.url, 'http://127.0.0.1');

  if (url.pathname === '/v1/chat/completions' && req.method === 'POST') {
    let payload = {};
    try { payload = JSON.parse((await readBody(req)) || '{}'); } catch {}
    if (payload.stream) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      for (const piece of MODEL_REPLY.match(/[\s\S]{1,10}/g) || []) {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`);
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: MODEL_REPLY } }] }));
    return;
  }

  const file = path.join(ROOT, url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname));
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('not found');
    return;
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});

const { port } = await new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address())));
const BASE = `http://127.0.0.1:${port}`;

const results = [];
function check(name, pass, detail = '') { results.push({ name, pass, detail }); console.log(`${pass ? 'PASS' : 'FAIL'}: ${name}${pass || !detail ? '' : ` — ${detail}`}`); }

const browser = await launchBrowser();
const context = await browser.newContext({ viewport: { width: 1365, height: 1000 } });
const page = await context.newPage();
const browserErrors = [];
page.on('pageerror', error => browserErrors.push(error.message));
page.on('console', message => {
  if (message.type() !== 'error') return;
  const text = message.text();
  if (/Failed to load resource|ERR_CONNECTION_REFUSED/i.test(text)) return;
  browserErrors.push(text);
});

const gotoAsk = async () => { await page.locator('.nav button[data-page="ask"]').click(); await page.waitForTimeout(60); };
const gotoManage = async () => { await page.locator('.nav button[data-page="manage"]').click(); await page.waitForTimeout(60); };
const ask = async query => { await page.locator('#questionInput').fill(query); await page.locator('#askButton').click(); };
const closeZoom = async () => { await page.locator('#answerZoomDone').click(); await page.waitForTimeout(120); };

try {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.querySelector('#statDocs')?.textContent === '3');

  // 启用生成式回答
  await gotoManage();
  await page.locator('#llmBaseUrl').fill(`${BASE}/v1`);
  await page.locator('#llmModel').fill('mock-model');
  await page.locator('#llmSave').click();
  await page.waitForTimeout(100);

  await gotoAsk();
  await ask('差旅报销需要什么材料');
  await page.waitForFunction(() => (document.querySelector('#resultStatus')?.textContent || '').startsWith('已生成'));

  // ── A. 列表渲染 ─────────────────────────────────────────────────────────
  const listCount = await page.locator('#answerPane .answer-generated .doc-md-list').count();
  check('生成式回答中的列表被渲染为列表容器', listCount === 1, `实际 ${listCount} 个 .doc-md-list`);

  const itemCount = await page.locator('#answerPane .answer-generated .doc-md-list > div').count();
  check('列表条目数与模型返回一致', itemCount === LIST_ITEM_COUNT, `期望 ${LIST_ITEM_COUNT}，实际 ${itemCount}`);

  const display = await page.locator('#answerPane .answer-generated .doc-md-list').evaluate(node => getComputedStyle(node).display);
  check('列表容器使用网格布局（修复前 .answer-generated 下无此规则）', display === 'grid', `computed display = ${display}`);

  // 核心断言：同一列表项里，标记 <span> 与文本 <p> 必须落在同一行
  const rows = await page.locator('#answerPane .answer-generated .doc-md-list > div').evaluateAll(nodes => nodes.map(node => {
    const marker = node.querySelector('span');
    const text = node.querySelector('p');
    const a = marker?.getBoundingClientRect();
    const b = text?.getBoundingClientRect();
    return {
      marker: marker?.textContent?.trim() || '',
      text: text?.textContent?.trim() || '',
      deltaTop: a && b ? Math.abs(a.top - b.top) : -1,
      sameRow: a && b ? Math.abs(a.top - b.top) <= 3 : false,
    };
  }));
  const allSameRow = rows.length === LIST_ITEM_COUNT && rows.every(row => row.sameRow);
  check('项目符号与文本在同一行（原缺陷：符号独占一行）', allSameRow, rows.map(row => `${row.marker}|${row.text} Δ${row.deltaTop.toFixed(1)}px`).join(' ／ '));
  const markersOk = rows.every(row => row.marker === '•');
  check('列表标记为项目符号', markersOk, rows.map(row => row.marker).join(''));
  const textsOk = rows.some(row => row.text.includes('经审批的出差申请')) && rows.some(row => row.text.includes('合规票据及费用明细'));
  check('列表条目文本完整', textsOk, rows.map(row => row.text).join(' ／ '));

  // ── B. 生成式回答可放大 ────────────────────────────────────────────────
  const triggers = await page.locator('#answerPane .answer-zoom-trigger').count();
  check('生成式回答挂载了放大触发器', triggers === 1, `实际 ${triggers} 个`);

  await page.locator('#answerPane .answer-zoom-trigger').first().click();
  await page.waitForTimeout(180);
  const opened = await page.locator('#answerZoomBackdrop.open').count();
  check('点击生成式回答后放大弹窗打开', opened === 1, `open 数量 ${opened}`);

  const zoomBody = await page.locator('#answerZoomBody');
  const zoomText = await zoomBody.innerText();
  const zoomHtmlClass = await zoomBody.getAttribute('class');
  check('放大视图使用结构化渲染', /zoom-html/.test(zoomHtmlClass || ''), String(zoomHtmlClass));
  check('放大视图包含「模型生成的回答」区块', /模型生成的回答/.test(zoomText));
  check('放大视图包含生成回答正文', /经审批的出差申请/.test(zoomText) && /合规票据及费用明细/.test(zoomText));
  check('放大视图包含「来源原文」区块', /来源原文/.test(zoomText));
  // 原文是逐字摘录：这句在模型的分点回答里并不存在，只可能来自来源原文
  check('放大视图逐字附上来源原文', /员工办理差旅费用报销时，应提交经审批的出差申请/.test(zoomText), zoomText.replace(/\s+/g, ' ').slice(0, 120));
  check('放大视图标注来源文档标题', /差旅与费用报销指引（演示）/.test(zoomText));

  // 生成式回答在放大视图里也按列表渲染（不再出现符号独占一行）
  const zoomRows = await page.locator('#answerZoomBody .doc-md-list > div').evaluateAll(nodes => nodes.map(node => {
    const a = node.querySelector('span')?.getBoundingClientRect();
    const b = node.querySelector('p')?.getBoundingClientRect();
    return a && b ? Math.abs(a.top - b.top) <= 3 : false;
  }));
  check('放大视图中的列表同样不换行', zoomRows.length > 0 && zoomRows.every(Boolean), `检查 ${zoomRows.length} 项`);

  await closeZoom();
  check('放大弹窗可关闭', (await page.locator('#answerZoomBackdrop.open').count()) === 0);

  // ── C. 一键切换到逐字原文证据 ───────────────────────────────────────────
  const sourceButtons = await page.locator('#answerPane [data-action="show-source"]').count();
  check('提供「查看原文证据」入口', sourceButtons === 1, `实际 ${sourceButtons} 个`);

  await page.locator('#answerPane [data-action="show-source"]').click();
  await page.waitForTimeout(180);
  const evidenceTitles = await page.locator('#answerPane .answer-part-title').allInnerTexts();
  const evidenceText = await page.locator('#answerPane').innerText();
  check('切换后渲染逐字原文证据', evidenceTitles.length >= 1, `实际 ${evidenceTitles.length} 条`);
  check('切换后标签说明为原文证据', /按编号小节整理的原文证据/.test(evidenceText));
  check('原文证据为逐字摘录', /员工办理差旅费用报销时，应提交经审批的出差申请/.test(evidenceText));

  // 原文模式下放大仍可用（回归保护）
  await page.locator('#answerPane .answer-zoom-trigger').first().click();
  await page.waitForTimeout(180);
  const evidenceZoomOpen = await page.locator('#answerZoomBackdrop.open').count();
  const evidenceZoomText = await page.locator('#answerZoomBody').innerText();
  check('原文模式下放大仍可用', evidenceZoomOpen === 1 && /员工办理差旅费用报销时/.test(evidenceZoomText));
  await closeZoom();

  check('无浏览器控制台 / 运行时错误', browserErrors.length === 0, browserErrors.slice(0, 2).join(' | '));
} finally {
  await browser.close();
  server.close();
}

const passed = results.filter(item => item.pass).length;
console.log(`\n================ 回答展示测试结果 ================`);
console.log(`通过 ${passed}/${results.length}`);
if (passed !== results.length) process.exitCode = 1;
