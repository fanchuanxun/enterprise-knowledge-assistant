#!/usr/bin/env node
/**
 * 文档管理 / 权限演示 / 响应式 回归测试。
 * 覆盖此前所有测试都没触及的路径：文档页搜索与筛选、TXT 导入、启停影响检索、
 * 移除、备份导出、越权打开被拒、审计页统计、窄屏横向溢出。
 *
 * 用法：node eval/doc-manage-test.mjs
 * 环境变量：PLAYWRIGHT_CORE=<playwright-core 入口>  CHROME_PATH=<chrome.exe 路径>
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { launchBrowser } from './browser-harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const MIME = { '.html': 'text/html; charset=utf-8', '.md': 'text/markdown; charset=utf-8', '.json': 'application/json; charset=utf-8' };
function startStaticServer() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const file = path.join(ROOT, url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname));
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port })));
}

const results = [];
function check(name, pass, detail = '') { results.push({ name, pass, detail }); console.log(`${pass ? 'PASS' : 'FAIL'}: ${name}${pass || !detail ? '' : ` — ${detail}`}`); }

const { server, port } = await startStaticServer();
const BASE = `http://127.0.0.1:${port}`;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'zhigui-doc-'));
const SAMPLE = path.join(TMP, '测试制度.txt');
fs.writeFileSync(SAMPLE, '报销时限\n员工应在费用发生后 30 个自然日内提交报销申请。\n\n超期处理\n超过时限的报销需部门负责人书面说明原因。', 'utf8');

const browser = await launchBrowser();
const context = await browser.newContext({ viewport: { width: 1365, height: 1000 }, acceptDownloads: true });
const page = await context.newPage();
const browserErrors = [];
page.on('pageerror', error => browserErrors.push(error.message));
page.on('console', message => { if (message.type() === 'error' && !/Failed to load resource/i.test(message.text())) browserErrors.push(message.text()); });
// 移除文档会走原生 confirm，这里统一确认
page.on('dialog', dialog => dialog.accept());

const goto = async pageName => { await page.locator(`.nav button[data-page="${pageName}"]`).click(); await page.waitForTimeout(160); };
const ask = async query => { await goto('ask'); await page.locator('#questionInput').fill(query); await page.locator('#askButton').click(); await page.waitForTimeout(320); };
const cardCount = () => page.locator('#docGrid .doc-card').count();
const countText = () => page.locator('#docCount').innerText();
const findByText = text => page.locator('#docGrid .doc-card', { hasText: text }).first();

try {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.querySelector('#statDocs')?.textContent === '3');

  // ── ① 文档页搜索与筛选 ────────────────────────────────────────────────
  await goto('docs');
  check('文档页列出全部种子文档', (await cardCount()) === 5, `实际 ${await cardCount()} 张卡片`);
  check('文档数统计区分总数与当前身份可见数', /共 5 份文档 · 当前身份可见 3 份/.test(await countText()), await countText());

  await page.locator('#docSearch').fill('报销');
  await page.waitForTimeout(140);
  check('按内容搜索命中文档', (await cardCount()) === 1, `实际 ${await cardCount()}`);

  await page.locator('#docSearch').fill('zzz不存在zzz');
  await page.waitForTimeout(140);
  check('搜索无结果时显示空状态', (await page.locator('#docGrid .empty-docs').count()) === 1);
  check('搜索不改变「可见份数」口径', /当前身份可见 3 份/.test(await countText()), await countText());

  await page.locator('#docSearch').fill('');
  await page.locator('#categoryFilter').selectOption('人事制度');
  await page.waitForTimeout(140);
  check('按分类筛选生效', (await cardCount()) === 2, `实际 ${await cardCount()}`);
  await page.locator('#categoryFilter').selectOption('all');
  await page.waitForTimeout(140);

  await page.locator('#statusFilter').selectOption('inactive');
  await page.waitForTimeout(140);
  check('按状态筛选（无停用文档时为空）', (await cardCount()) === 0, `实际 ${await cardCount()}`);
  await page.locator('#statusFilter').selectOption('all');
  await page.waitForTimeout(140);

  // ── ② 导入 TXT 并回填 ────────────────────────────────────────────────
  await page.locator('#addDoc').click();
  await page.waitForTimeout(180);
  await page.locator('#fileInput').setInputFiles(SAMPLE);
  await page.waitForTimeout(320);
  check('导入 TXT 后回填文档标题（取文件名）', (await page.locator('#docTitle').inputValue()) === '测试制度', await page.locator('#docTitle').inputValue());
  check('导入 TXT 后回填正文', (await page.locator('#docBody').inputValue()).includes('30 个自然日'));
  await page.locator('#docCategory').selectOption('财务报销');
  await page.locator('#saveDoc').click();
  await page.waitForTimeout(320);
  check('保存后文档进入知识库', /共 6 份文档/.test(await countText()), await countText());

  // ── ③ 新文档可被检索 ─────────────────────────────────────────────────
  await ask('报销要在多少天内提交');
  check('新导入文档可被检索命中', (await page.locator('#answerPane').innerText()).includes('30 个自然日'), await page.locator('#resultStatus').innerText());

  // ── ④ 停用后不再被检索 ───────────────────────────────────────────────
  await goto('docs');
  check('新文档出现在列表', (await findByText('测试制度').count()) === 1);
  await findByText('测试制度').locator('[data-action="toggle"]').click();
  await page.waitForTimeout(260);
  check('停用后卡片状态标记更新', /已停用/.test(await findByText('测试制度').innerText()));
  await ask('报销要在多少天内提交');
  check('停用文档不再被检索命中', !(await page.locator('#answerPane').innerText()).includes('30 个自然日'));

  // ── ⑤ 重新启用后恢复可检索 ───────────────────────────────────────────
  await goto('docs');
  await findByText('测试制度').locator('[data-action="toggle"]').click();
  await page.waitForTimeout(260);
  await ask('报销要在多少天内提交');
  check('重新启用后恢复可检索', (await page.locator('#answerPane').innerText()).includes('30 个自然日'));

  // ── ⑥ 移除文档 ───────────────────────────────────────────────────────
  await goto('docs');
  await findByText('测试制度').locator('[data-action="delete"]').click();
  await page.waitForTimeout(320);
  check('移除后文档从列表消失', (await findByText('测试制度').count()) === 0);
  check('移除后文档数回落', /共 5 份文档/.test(await countText()), await countText());
  await ask('报销要在多少天内提交');
  check('移除后不再被检索命中', !(await page.locator('#answerPane').innerText()).includes('30 个自然日'));

  // ── ⑦ 备份导出 ───────────────────────────────────────────────────────
  await goto('manage');
  const download = await Promise.all([
    page.waitForEvent('download', { timeout: 6000 }).catch(() => null),
    page.locator('#exportData').click(),
  ]).then(list => list[0]);
  check('导出备份触发下载且文件名带日期', !!download && /^zhigui-knowledge-backup-\d{4}-\d{2}-\d{2}\.json$/.test(download.suggestedFilename()), download ? download.suggestedFilename() : '未触发下载');
  if (download) {
    const saved = path.join(TMP, download.suggestedFilename());
    await download.saveAs(saved);
    const payload = JSON.parse(fs.readFileSync(saved, 'utf8'));
    check('备份内容为知识库文档全文', payload.format === 'zhigui-local-backup-v1' && Array.isArray(payload.documents) && payload.documents.length === 5, `documents=${payload.documents?.length}`);
    check('备份不含模型密钥', !JSON.stringify(payload).includes('apiKey'));
  }

  // ── ⑧ 越权打开被拒并留痕 ─────────────────────────────────────────────
  await page.locator('#roleSelect').selectOption('employee');
  await page.waitForTimeout(220);
  await goto('docs');
  const restricted = await page.locator('#docGrid .doc-card.restricted').count();
  check('无权文档在列表中被标记', restricted === 2, `实际 ${restricted} 张`);
  await page.locator('#docGrid .doc-card.restricted').first().locator('[data-action="source"]').click();
  await page.waitForTimeout(260);
  check('越权打开给出可读提示', /无权查看/.test(await page.locator('#toast').innerText()), await page.locator('#toast').innerText());
  check('越权时文档预览不打开', (await page.locator('#viewerBackdrop.open').count()) === 0);

  await page.locator('#roleSelect').selectOption('hr');
  await page.waitForTimeout(220);
  await goto('docs');
  // 人事可见「所有员工 + 人事专属」，仍看不到主管专属文档
  check('人事身份仍看不到主管专属文档', (await page.locator('#docGrid .doc-card.restricted').count()) === 1, `实际 ${await page.locator('#docGrid .doc-card.restricted').count()} 张`);
  await findByText('入职手续办理清单').locator('[data-action="source"]').click();
  await page.waitForTimeout(260);
  check('切换身份后原本被拒的文档可正常打开', (await page.locator('#viewerBackdrop.open').count()) === 1);
  check('预览显示文档正文', (await page.locator('#viewerBody').innerText()).includes('入职'), (await page.locator('#viewerBody').innerText()).slice(0, 40));
  await page.locator('#viewerClose').click();
  await page.waitForTimeout(180);

  await page.locator('#roleSelect').selectOption('admin');
  await page.waitForTimeout(220);
  await goto('docs');
  check('管理员身份可见全部文档', (await page.locator('#docGrid .doc-card.restricted').count()) === 0);
  check('管理员可见份数等于总数', /当前身份可见 5 份/.test(await countText()), await countText());

  // ── ⑨ 审计页统计与拒绝计数 ───────────────────────────────────────────
  await goto('audit');
  const total = Number(await page.locator('#auditTotal').innerText());
  const denied = Number(await page.locator('#auditDenied').innerText());
  check('审计页记录到本轮操作', total >= 10, `记录总数 ${total}`);
  check('审计页统计出被拒绝操作', denied >= 1, `被拒绝 ${denied}`);
  check('审计列表渲染出行', (await page.locator('#auditList .audit-row').count()) >= 1);
  check('审计页显示当前身份', (await page.locator('#auditRole').innerText()) === '管理员', await page.locator('#auditRole').innerText());

  // ── ⑩ 窄屏无横向溢出 ─────────────────────────────────────────────────
  await page.setViewportSize({ width: 420, height: 900 });
  await ask('年假怎么申请');
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check('窄屏（420px）无横向溢出', overflow <= 1, `溢出 ${overflow}px`);
  await page.setViewportSize({ width: 1365, height: 1000 });

  check('无浏览器控制台 / 运行时错误', browserErrors.length === 0, browserErrors.slice(0, 2).join(' | '));
} finally {
  await browser.close();
  server.close();
  fs.rmSync(TMP, { recursive: true, force: true });
}

const passed = results.filter(item => item.pass).length;
console.log(`\n================ 文档管理测试结果 ================`);
console.log(`通过 ${passed}/${results.length}`);
if (passed !== results.length) process.exitCode = 1;
