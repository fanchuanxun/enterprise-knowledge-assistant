#!/usr/bin/env node
/**
 * 使用者体验测试：验证「从用户角度」补齐的那批能力真的可用
 *   1. 首次上手引导（显示 / 关闭 / 关闭后不再出现）
 *   2. 搜索框：空输入禁用查询、清除按钮、/ 快捷键聚焦
 *   3. 拒答时给出可点的替代建议
 *   4. 提问历史：记录 / 点击重问 / 清空
 *   5. 复制答案（证据模式）写入剪贴板
 *   6. 文档预览「复制全文」
 *   7. 放大弹窗「复制内容」
 *   8. 审计页筛选
 *   9. 复制答案（生成式模式）写入剪贴板
 *  10. 窄屏无横向溢出
 *
 * 用法：node eval/ux-polish-test.mjs
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

const MODEL_REPLY = [
  '差旅报销需要以下材料：',
  '- 经审批的出差申请 [1]',
  '- 合规票据及费用明细 [1]',
].join('\n');

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
await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE });
const page = await context.newPage();
const browserErrors = [];
page.on('pageerror', error => browserErrors.push(error.message));
page.on('console', message => {
  if (message.type() !== 'error') return;
  const text = message.text();
  if (/Failed to load resource|ERR_CONNECTION_REFUSED/i.test(text)) return;
  browserErrors.push(text);
});

const goto = async name => { await page.locator(`.nav button[data-page="${name}"]`).click(); await page.waitForTimeout(80); };
const ask = async query => { await page.locator('#questionInput').fill(query); await page.locator('#askButton').click(); await page.waitForTimeout(220); };
const clipboard = async () => { await page.bringToFront(); return (await page.evaluate(() => navigator.clipboard.readText().catch(() => ''))).trim(); };

try {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.querySelector('#statDocs')?.textContent === '3');

  // ── 1. 首次上手引导 ─────────────────────────────────────────────────────
  check('首次进入显示上手引导', (await page.locator('#onboard:not(.hidden)').count()) === 1);
  const onboardSteps = await page.locator('#onboard li').count();
  check('引导包含分步说明', onboardSteps === 3, `实际 ${onboardSteps} 步`);
  await page.locator('#onboardClose').click();
  await page.waitForTimeout(80);
  check('点击关闭后引导隐藏', (await page.locator('#onboard.hidden').count()) === 1);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.querySelector('#statDocs')?.textContent === '3');
  check('关闭状态被记住，刷新后不再打扰', (await page.locator('#onboard.hidden').count()) === 1);

  // ── 2. 搜索框可用性 ────────────────────────────────────────────────────
  check('空输入时查询按钮禁用', await page.locator('#askButton').isDisabled());
  await page.locator('#questionInput').fill('年假');
  check('输入内容后查询按钮可用', !(await page.locator('#askButton').isDisabled()));
  check('有内容时出现清除按钮', (await page.locator('#questionClear.show').count()) === 1);
  await page.locator('#questionClear').click();
  await page.waitForTimeout(60);
  check('清除按钮清空输入并再次禁用查询', (await page.locator('#questionInput').inputValue()) === '' && (await page.locator('#askButton').isDisabled()));

  await page.locator('.hero h1').first().click();
  await page.keyboard.press('/');
  await page.waitForTimeout(60);
  const focusedId = await page.evaluate(() => document.activeElement?.id || '');
  check('按 / 快捷键聚焦搜索框', focusedId === 'questionInput', `activeElement = ${focusedId}`);

  // ── 3. 拒答时给出替代建议 ──────────────────────────────────────────────
  await ask('量子计算机的采购预算审批流程');
  const retryChips = await page.locator('#answerPane .retry-chip').count();
  check('拒答时给出可点的替代建议', retryChips >= 1, `实际 ${retryChips} 个`);
  check('拒答提示仍是「暂未找到足够依据」', /暂未找到足够依据/.test(await page.locator('#answerPane').innerText()));
  const firstChipText = (await page.locator('#answerPane .retry-chip').first().innerText()).trim();
  await page.locator('#answerPane .retry-chip').first().click();
  await page.waitForTimeout(260);
  check('点击替代建议会填入并重新查询', (await page.locator('#questionInput').inputValue()).trim() === firstChipText, `输入框 = ${await page.locator('#questionInput').inputValue()}`);

  // ── 4. 提问历史 ────────────────────────────────────────────────────────
  const historyCount = await page.locator('#historyRow .history-chip').count();
  check('提问历史被记录', historyCount >= 2, `实际 ${historyCount} 条`);
  const historyText = (await page.locator('#historyRow .history-chip').first().innerText()).trim();
  await page.locator('#historyRow .history-chip').first().click();
  await page.waitForTimeout(260);
  check('点击历史条目可重新提问', (await page.locator('#questionInput').inputValue()).trim() === historyText);
  await page.locator('#historyClear').click();
  await page.waitForTimeout(80);
  check('可清空提问历史', (await page.locator('#historyRow.hidden').count()) === 1);

  // ── 5. 复制答案（证据模式）─────────────────────────────────────────────
  await ask('年假怎么申请');
  await page.waitForFunction(() => !!document.querySelector('#answerPane .answer-result'));
  const copyBtn = page.locator('#answerPane [data-action="copy-answer"]');
  check('证据模式提供复制按钮', (await copyBtn.count()) === 1);
  check('复制按钮标注复制对象为证据原文', /证据原文/.test(await copyBtn.innerText()), await copyBtn.innerText());
  await copyBtn.click();
  await page.waitForTimeout(150);
  const evidenceClip = await clipboard();
  check('复制证据写入剪贴板', evidenceClip.length > 30 && evidenceClip.includes('来源：'), `${evidenceClip.length} 字 / ${evidenceClip.slice(0, 40)}`);

  // ── 6. 文档预览复制全文 ────────────────────────────────────────────────
  await goto('docs');
  await page.locator('.doc-card:not(.restricted) [data-action="source"]').first().click();
  await page.waitForTimeout(200);
  check('文档预览已打开', (await page.locator('#viewerBackdrop.open').count()) === 1);
  const viewerTitle = (await page.locator('#viewerTitle').innerText()).trim();
  await page.locator('#viewerCopy').click();
  await page.waitForTimeout(150);
  const docClip = await clipboard();
  check('预览「复制全文」写入完整正文', docClip.length > 60 && !/^</.test(docClip), `${viewerTitle} · ${docClip.length} 字`);
  await page.locator('#viewerDone').click();
  await page.waitForTimeout(120);

  // ── 7. 放大弹窗复制内容 ────────────────────────────────────────────────
  await goto('ask');
  await page.locator('#answerPane .answer-zoom-trigger').first().click();
  await page.waitForTimeout(200);
  await page.locator('#answerZoomCopy').click();
  await page.waitForTimeout(150);
  const zoomClip = await clipboard();
  check('放大弹窗「复制内容」写入剪贴板', zoomClip.length > 20, `${zoomClip.length} 字`);
  await page.locator('#answerZoomDone').click();
  await page.waitForTimeout(120);

  // ── 8. 审计页筛选 ──────────────────────────────────────────────────────
  await goto('audit');
  const auditRows = await page.locator('#auditList .audit-row').count();
  check('审计页已有记录', auditRows > 0, `实际 ${auditRows} 行`);
  await page.locator('#auditResultFilter').selectOption('denied');
  await page.waitForTimeout(120);
  const note = await page.locator('#auditFilterNote').innerText();
  check('筛选后给出条数说明', /筛选后/.test(note), note);
  const deniedRows = await page.locator('#auditList .audit-row').count();
  const allDenied = await page.locator('#auditList .audit-row').evaluateAll(nodes => nodes.every(node => node.classList.contains('denied')));
  check('「仅拒绝」筛选结果只包含被拒记录', deniedRows === 0 || allDenied, `${deniedRows} 行`);
  const actionOptions = await page.locator('#auditActionFilter option').count();
  check('操作类型筛选按实际动作生成', actionOptions >= 2, `${actionOptions} 个选项`);
  await page.locator('#auditResultFilter').selectOption('all');
  await page.waitForTimeout(100);

  // ── 9. 复制答案（生成式模式）───────────────────────────────────────────
  await goto('manage');
  await page.locator('#llmBaseUrl').fill(`${BASE}/v1`);
  await page.locator('#llmModel').fill('mock-model');
  await page.locator('#llmSave').click();
  await page.waitForTimeout(120);
  await goto('ask');
  await ask('差旅报销需要什么材料');
  await page.waitForFunction(() => (document.querySelector('#resultStatus')?.textContent || '').startsWith('已生成'));
  const genCopy = page.locator('#answerPane [data-action="copy-answer"]');
  check('生成式模式复制按钮标注为模型回答', /模型回答/.test(await genCopy.innerText()), await genCopy.innerText());
  await genCopy.click();
  await page.waitForTimeout(150);
  const genClip = await clipboard();
  check('复制模型回答写入剪贴板', /经审批的出差申请/.test(genClip), genClip.slice(0, 50));

  // ── 10. 窄屏 ───────────────────────────────────────────────────────────
  await page.setViewportSize({ width: 420, height: 900 });
  await page.waitForTimeout(220);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check('420px 窄屏无横向溢出', overflow <= 1, `溢出 ${overflow}px`);
  await page.setViewportSize({ width: 1365, height: 1000 });

  check('无浏览器控制台 / 运行时错误', browserErrors.length === 0, browserErrors.slice(0, 2).join(' | '));
} finally {
  await browser.close();
  server.close();
}

const passed = results.filter(item => item.pass).length;
console.log(`\n================ 使用者体验测试结果 ================`);
console.log(`通过 ${passed}/${results.length}`);
if (passed !== results.length) process.exitCode = 1;
