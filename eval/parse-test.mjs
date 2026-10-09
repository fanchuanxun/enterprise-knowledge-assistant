#!/usr/bin/env node
/**
 * 二进制文档解析测试：DOCX（ZIP + document.xml）与 PDF（FlateDecode + 文本操作符）。
 *
 * 用法：node eval/parse-test.mjs
 * 依赖 playwright-core（本机隔离工作区已安装），可用环境变量覆盖：
 *   PLAYWRIGHT_CORE=<playwright-core 入口路径>  CHROME_PATH=<chrome.exe 路径>
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { launchBrowser } from './browser-harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const MIME = { '.html': 'text/html; charset=utf-8', '.md': 'text/markdown; charset=utf-8', '.json': 'application/json; charset=utf-8' };

// ── 构造测试用 DOCX（ZIP store 模式，无需压缩）─────────────────────────────
function zipStore(files) {
  const chunks = []; const central = []; let offset = 0;
  for (const file of files) {
    const nameBuf = Buffer.from(file.name, 'utf8');
    const data = Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data, 'utf8');
    const crc = zlib.crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8); local.writeUInt16LE(0, 10); local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26); local.writeUInt16LE(0, 28);
    chunks.push(local, nameBuf, data);
    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4); dir.writeUInt16LE(20, 6); dir.writeUInt16LE(0x0800, 8);
    dir.writeUInt16LE(0, 10); dir.writeUInt16LE(0, 12); dir.writeUInt16LE(0, 14);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(data.length, 20); dir.writeUInt32LE(data.length, 24);
    dir.writeUInt16LE(nameBuf.length, 28);
    dir.writeUInt16LE(0, 30); dir.writeUInt16LE(0, 32); dir.writeUInt16LE(0, 34); dir.writeUInt16LE(0, 36);
    dir.writeUInt32LE(0, 38); dir.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([dir, nameBuf]));
    offset += 30 + nameBuf.length + data.length;
  }
  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8); eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12); eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, centralBuf, eocd]);
}

const DOCX_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>差旅与年假制度（DOCX 测试）</w:t></w:r></w:p>
<w:p><w:r><w:t>员工申请年假应至少提前 5 个工作日在办公系统提交申请。</w:t></w:r></w:p>
<w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:t>1.1 差旅报销要求</w:t></w:r></w:p>
<w:p><w:r><w:t>报销须提供经审批的出差申请与合规票据。</w:t></w:r></w:p>
</w:body></w:document>`;

const DOCX_BUFFER = zipStore([
  { name: 'word/document.xml', data: DOCX_XML },
  { name: '[Content_Types].xml', data: '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>' },
]);

// ── 构造测试用 PDF（未压缩内容流）─────────────────────────────────────────
const PDF_TEXT = 'Travel reimbursement requires an approved trip request and valid invoices.';
function buildPdf() {
  const content = `BT /F1 12 Tf 72 720 Td (${PDF_TEXT}) Tj ET`;
  const objects = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n',
    `4 0 obj\n<< /Length ${content.length} >>\nstream\n${content}\nendstream\nendobj\n`,
    '5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n',
  ];
  return Buffer.from(`%PDF-1.4\n${objects.join('')}trailer\n<< /Size 6 >>\n%%EOF\n`, 'latin1');
}
const PDF_BUFFER = buildPdf();
const BROKEN_PDF = Buffer.concat([Buffer.from('%PDF-1.4\n', 'latin1'), Buffer.from([0x00, 0xff, 0x01, 0xfe, 0x02, 0xfd, 0x03, 0xfc, 0x04, 0xfb, 0x05, 0xfa])]);

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

const { server, port } = await startStaticServer();
const browser = await launchBrowser();
const context = await browser.newContext({ viewport: { width: 1365, height: 1000 } });
const page = await context.newPage();
const browserErrors = [];
page.on('pageerror', error => browserErrors.push(error.message));
page.on('console', message => { if (message.type() === 'error') browserErrors.push(message.text()); });

async function importFile(name, mimeType, buffer) {
  await page.getByRole('button', { name: '＋ 导入资料' }).click();
  await page.locator('#fileInput').setInputFiles({ name, mimeType, buffer });
  await page.waitForTimeout(400);
  const toast = (await page.locator('#toast').innerText().catch(() => '')).trim();
  const title = await page.locator('#docTitle').inputValue();
  const body = await page.locator('#docBody').inputValue();
  return { toast, title, body };
}

try {
  await page.goto(`http://127.0.0.1:${port}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.querySelector('#statDocs')?.textContent === '3');

  // ① DOCX 解析
  const docx = await importFile('差旅与年假制度.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', DOCX_BUFFER);
  check('DOCX 正文提取成功（含段落文本）', docx.body.includes('员工申请年假应至少提前 5 个工作日'), docx.body.slice(0, 120));
  check('DOCX 标题样式转换为 Markdown 标题', /^# 差旅与年假制度（DOCX 测试）/m.test(docx.body) && /^## 1\.1 差旅报销要求/m.test(docx.body), JSON.stringify(docx.body.slice(0, 60)));
  check('DOCX 导入后回填文档标题', docx.title.includes('差旅与年假制度'), docx.title);

  // 保存 DOCX 并验证可检索
  await page.locator('#saveDoc').click();
  await page.waitForFunction(() => document.querySelector('#docGrid')?.innerText.includes('差旅与年假制度'));
  check('DOCX 保存进本地知识库', await page.locator('#docGrid').innerText().then(text => text.includes('差旅与年假制度')));

  await page.locator('#questionInput').fill('年假要提前几个工作日申请');
  await page.locator('#askButton').click();
  await page.waitForTimeout(200);
  const answer = await page.locator('#answerPane').innerText();
  check('DOCX 内容可被检索命中编号小节', answer.includes('5 个工作日'), answer.replace(/\s+/g, ' ').slice(0, 140));
  await page.locator('#questionInput').fill('差旅报销要求是什么');
  await page.locator('#askButton').click();
  await page.waitForTimeout(200);
  const sectionAnswer = await page.locator('#answerPane').innerText();
  check('DOCX 标题层级还原为可检索的编号小节', sectionAnswer.includes('1.1 差旅报销要求 · 完整小节'), sectionAnswer.replace(/\s+/g, ' ').slice(0, 160));

  // ② PDF 解析
  const pdf = await importFile('差旅报销指引.pdf', 'application/pdf', PDF_BUFFER);
  check('PDF 正文提取成功（文本操作符 + 字符串）', pdf.body.includes('approved trip request'), pdf.body.slice(0, 140));

  await page.locator('#saveDoc').click();
  await page.waitForFunction(() => document.querySelector('#docGrid')?.innerText.includes('差旅报销指引'));
  check('PDF 保存进本地知识库', await page.locator('#docGrid').innerText().then(text => text.includes('差旅报销指引')));

  // ③ 损坏 PDF 应被拒绝且给出提示
  const broken = await importFile('损坏文档.pdf', 'application/pdf', BROKEN_PDF);
  check('损坏 / 扫描件 PDF 被拒绝并给出提示', /未提取到足够的可读文本|建议先转成文本/.test(broken.toast), broken.toast);
  check('被拒绝的 PDF 不会回填正文', broken.body.trim() === '', JSON.stringify(broken.body.slice(0, 40)));
  await page.locator('#cancelModal').click();

  // ④ 不支持的扩展名
  const unsupported = await importFile('说明.docx.bak', 'application/octet-stream', Buffer.from('hello'));
  check('不支持的扩展名被拒绝', /当前支持/.test(unsupported.toast), unsupported.toast);
  await page.locator('#cancelModal').click();

  check('无浏览器控制台 / 运行时错误', browserErrors.length === 0, browserErrors.slice(0, 2).join(' | '));
} finally {
  await browser.close();
  server.close();
}

const passed = results.filter(item => item.pass).length;
console.log(`\n================ 解析测试结果 ================`);
console.log(`通过 ${passed}/${results.length}`);
if (passed !== results.length) process.exitCode = 1;
