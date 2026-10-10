#!/usr/bin/env node
/**
 * 离线评测：在真实页面链路上逐条提问，判定命中 / 拒答 / 权限隔离是否正确。
 *
 * 用法：
 *   node eval/run-eval.mjs                 # 跑全量，写 eval/report/latest.json + latest.md
 *   node eval/run-eval.mjs --label baseline  # 同时另存一份 report/baseline.json（用于改动前后对比）
 *
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
const REPORT_DIR = path.join(HERE, 'report');
const MIME = { '.html': 'text/html; charset=utf-8', '.md': 'text/markdown; charset=utf-8', '.json': 'application/json; charset=utf-8' };

function startStaticServer() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const relative = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname);
    const file = path.join(ROOT, relative);
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port })));
}

function judge(testCase, observed) {
  const { refused, answer } = observed;
  if (testCase.expectRefusal) return { pass: refused, reason: refused ? '正确拒答' : '应拒答但给出了答案' };
  if (refused) return { pass: false, reason: '未找到依据，但该问题有预期答案' };
  const missing = (testCase.expectKeywords || []).filter(keyword => !answer.includes(keyword));
  if (missing.length) return { pass: false, reason: `缺少要点：${missing.join(' / ')}` };
  const leaked = (testCase.rejectKeywords || []).filter(keyword => answer.includes(keyword));
  if (leaked.length) return { pass: false, reason: `混入了不该出现的内容：${leaked.join(' / ')}` };
  if (testCase.expectUnitTitle && !answer.includes(`${testCase.expectUnitTitle} · 完整小节`)) {
    return { pass: false, reason: `未定位到编号小节「${testCase.expectUnitTitle}」` };
  }
  const crossed = (testCase.rejectUnitTitles || []).filter(title => answer.includes(`${title} · 完整小节`));
  if (crossed.length) return { pass: false, reason: `越界到兄弟小节：${crossed.join(' / ')}` };
  return { pass: true, reason: '命中预期要点' };
}

const labelArgIndex = process.argv.indexOf('--label');
const label = labelArgIndex > -1 ? process.argv[labelArgIndex + 1] : '';

const spec = JSON.parse(fs.readFileSync(path.join(HERE, 'cases.json'), 'utf8'));
const { server, port } = await startStaticServer();
const base = `http://127.0.0.1:${port}`;

const browser = await launchBrowser();
const context = await browser.newContext({ viewport: { width: 1365, height: 1000 } });
const page = await context.newPage();
const browserErrors = [];
page.on('pageerror', error => browserErrors.push(error.message));
page.on('console', message => { if (message.type() === 'error') browserErrors.push(message.text()); });

const results = [];
try {
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.querySelector('#statDocs')?.textContent === '3');

  for (const relative of spec.corpus) {
    const file = path.join(HERE, relative);
    const name = path.basename(file);
    await page.getByRole('button', { name: '＋ 导入资料' }).click();
    await page.locator('#fileInput').setInputFiles({ name, mimeType: 'text/markdown', buffer: fs.readFileSync(file) });
    await page.waitForFunction(() => (document.querySelector('#docBody')?.value || '').length > 0);
    await page.locator('#saveDoc').click();
    await page.waitForFunction(n => document.querySelector('#docGrid')?.innerText.includes(n), name.replace(/\.[^.]+$/, ''));
    console.log(`已导入语料：${name}`);
  }

  let currentRole = 'employee';
  for (const testCase of spec.cases) {
    if (testCase.role && testCase.role !== currentRole) {
      await page.selectOption('#roleSelect', testCase.role);
      currentRole = testCase.role;
      await page.waitForTimeout(60);
    }
    await page.locator('#questionInput').fill(testCase.query);
    await page.locator('#askButton').click();
    await page.waitForTimeout(40);
    const status = (await page.locator('#resultStatus').innerText()).trim();
    const answer = await page.locator('#answerPane').innerText();
    const refused = status === '未找到足够依据' || answer.includes('暂未找到足够依据');
    const verdict = judge(testCase, { refused, answer });
    results.push({
      id: testCase.id,
      group: testCase.group,
      role: testCase.role || 'employee',
      query: testCase.query,
      pass: verdict.pass,
      reason: verdict.reason,
      note: testCase.note || '',
      observed: refused ? '[拒答]' : answer.replace(/\s+/g, ' ').slice(0, 160),
    });
    console.log(`${verdict.pass ? 'PASS' : 'FAIL'} ${testCase.id} [${testCase.group}] ${testCase.query}${verdict.pass ? '' : ` — ${verdict.reason}`}`);
  }
} finally {
  await browser.close();
  server.close();
}

const summary = {};
for (const group of Object.keys(spec.groups)) {
  const items = results.filter(item => item.group === group);
  summary[group] = {
    label: spec.groups[group],
    total: items.length,
    passed: items.filter(item => item.pass).length,
    rate: items.length ? Number((items.filter(item => item.pass).length / items.length * 100).toFixed(1)) : 0,
  };
}
const overall = {
  total: results.length,
  passed: results.filter(item => item.pass).length,
  rate: Number((results.filter(item => item.pass).length / results.length * 100).toFixed(1)),
};

const report = {
  generatedAt: new Date().toISOString(),
  target: 'index.html',
  corpus: spec.corpus,
  overall,
  summary,
  browserErrors,
  results,
};

fs.mkdirSync(REPORT_DIR, { recursive: true });
fs.writeFileSync(path.join(REPORT_DIR, 'latest.json'), JSON.stringify(report, null, 2), 'utf8');
if (label) fs.writeFileSync(path.join(REPORT_DIR, `${label}.json`), JSON.stringify(report, null, 2), 'utf8');

const lines = [];
lines.push('# 离线评测报告', '');
lines.push(`- 生成时间：${report.generatedAt}`);
lines.push(`- 被测对象：\`index.html\`（本地浏览器原型）`);
lines.push(`- 语料：${spec.corpus.join('、')} + 内置 5 份演示制度`);
lines.push(`- 用例总数：**${overall.total}**，通过 **${overall.passed}**，综合通过率 **${overall.rate}%**`);
lines.push('', '## 分组指标', '', '| 分组 | 用例数 | 通过 | 通过率 |', '| --- | ---: | ---: | ---: |');
for (const [key, value] of Object.entries(summary)) lines.push(`| ${value.label} | ${value.total} | ${value.passed} | ${value.rate}% |`);
lines.push('', '## 逐条结果', '', '| 用例 | 分组 | 身份 | 问题 | 结果 | 说明 |', '| --- | --- | --- | --- | --- | --- |');
for (const item of results) lines.push(`| ${item.id} | ${item.group} | ${item.role} | ${item.query} | ${item.pass ? '✅ 通过' : '❌ 未通过'} | ${item.pass ? item.reason : item.reason} |`);
const failures = results.filter(item => !item.pass);
if (failures.length) {
  lines.push('', '## 未通过明细', '');
  for (const item of failures) lines.push(`- **${item.id}**「${item.query}」→ ${item.reason}${item.note ? `（${item.note}）` : ''}`, `  - 实际输出：${item.observed}`);
}
if (browserErrors.length) lines.push('', '## 浏览器错误', '', ...browserErrors.map(error => `- ${error}`));
fs.writeFileSync(path.join(REPORT_DIR, 'latest.md'), lines.join('\n'), 'utf8');

console.log('\n================ 评测结果 ================');
for (const [key, value] of Object.entries(summary)) console.log(`${value.label.padEnd(22, ' ')} ${value.passed}/${value.total}  ${value.rate}%`);
console.log(`综合通过率               ${overall.passed}/${overall.total}  ${overall.rate}%`);
console.log(`浏览器错误：${browserErrors.length}`);
console.log(`报告已写入：eval/report/latest.json、eval/report/latest.md`);
if (overall.passed !== overall.total) process.exitCode = 1;
