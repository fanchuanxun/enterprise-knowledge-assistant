#!/usr/bin/env node
/**
 * 服务端参考实现测试：真实进程 + 真实 HTTP，覆盖
 *   A. 身份认证：未登录 401、错误口令 401、伪造签名 token 401、正确登录签发 token
 *   B. 服务端权限：文档出网前按身份过滤；按 id 请求越权文档返回 403，且拒绝由服务端权威留痕
 *   C. 写入侧 RBAC：非管理员新增 / 启停 / 移除文档一律 403
 *   D. 审计：append-only、仅管理员可读、哈希链校验；**直接改写 audit.jsonl 会被检出并定位到行**
 *   E. 静态资源隔离：只托管 index.html，data/ 与 server/ 一律 404
 *   F. 前端集成：页面登录后身份锁定、文档集来自服务端、服务端审计面板显示哈希链完整、断开后回到本地模式
 *
 * 用法：node eval/server-mode-test.mjs
 * 环境变量：PLAYWRIGHT_CORE=<playwright-core 入口>  CHROME_PATH=<chrome.exe 路径>
 */
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { launchBrowser } from './browser-harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const results = [];
function check(name, pass, detail = '') { results.push({ name, pass, detail }); console.log(`${pass ? 'PASS' : 'FAIL'}: ${name}${pass || !detail ? '' : ` — ${detail}`}`); }

const freePort = () => new Promise((resolve) => { const probe = net.createServer(); probe.listen(0, '127.0.0.1', () => { const p = probe.address().port; probe.close(() => resolve(p)); }); });

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'zhigui-server-'));
const PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;

const child = spawn(process.execPath, [path.join(ROOT, 'server', 'server.mjs')], {
  cwd: ROOT,
  env: { ...process.env, ZHIGUI_PORT: String(PORT), ZHIGUI_HOST: '127.0.0.1', ZHIGUI_DATA_DIR: DATA_DIR },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
child.stdout.on('data', (chunk) => { serverLog += chunk; });
child.stderr.on('data', (chunk) => { serverLog += chunk; });

async function waitForServer(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { const res = await fetch(`${BASE}/api/health`); if (res.ok) return true; } catch {}
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

const api = async (pathname, { method = 'GET', token, body } = {}) => {
  const res = await fetch(`${BASE}${pathname}`, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let payload = null;
  try { payload = await res.json(); } catch {}
  return { status: res.status, body: payload };
};
const login = async (username, password = 'demo1234') => (await api('/api/login', { method: 'POST', body: { username, password } })).body?.token;
const AUDIT_FILE = path.join(DATA_DIR, 'audit.jsonl');

let browser;
try {
  const up = await waitForServer();
  check('服务端进程可启动并响应 /api/health', up, up ? '' : serverLog.slice(0, 200));
  if (!up) throw new Error('服务端未就绪');

  // ── A. 身份认证 ─────────────────────────────────────────────────────────
  check('未携带 token 访问受保护接口返回 401', (await api('/api/documents')).status === 401);
  check('错误口令登录返回 401', (await api('/api/login', { method: 'POST', body: { username: 'employee', password: 'wrong' } })).status === 401);
  check('不存在的用户名返回 401', (await api('/api/login', { method: 'POST', body: { username: 'nobody', password: 'demo1234' } })).status === 401);

  const employeeToken = await login('employee');
  const hrToken = await login('hr');
  const managerToken = await login('manager');
  const adminToken = await login('admin');
  check('正确口令登录签发 token', !!employeeToken && employeeToken.split('.').length === 2, `token 长度 ${employeeToken?.length}`);

  const [payloadPart] = String(employeeToken).split('.');
  check('伪造签名（改动签名段）被拒绝', (await api('/api/documents', { token: `${payloadPart}.AAAA` })).status === 401);
  const forgedPayload = Buffer.from(JSON.stringify({ sub: 'admin', role: 'admin', exp: Date.now() + 60000 })).toString('base64url');
  check('伪造 payload 提权被拒绝（签名不匹配）', (await api('/api/documents', { token: `${forgedPayload}.${String(employeeToken).split('.')[1]}` })).status === 401);

  // ── B. 服务端权限 ───────────────────────────────────────────────────────
  const employeeDocs = await api('/api/documents', { token: employeeToken });
  const employeeIds = (employeeDocs.body?.documents || []).map((doc) => doc.id);
  check('员工只拿到 3 份可见文档（共 5 份）', employeeDocs.body?.visible === 3 && employeeDocs.body?.total === 5, `visible=${employeeDocs.body?.visible} total=${employeeDocs.body?.total}`);
  check('人事 / 主管专属文档不出网', !employeeIds.includes('demo-hr-onboarding') && !employeeIds.includes('demo-manager-purchase'), employeeIds.join(','));
  check('服务端响应里不含被过滤文档的任何字段', !JSON.stringify(employeeDocs.body).includes('入职当天由人事核验录用材料'));

  const hrDocs = await api('/api/documents', { token: hrToken });
  check('人事拿到 4 份（看不到主管专属）', hrDocs.body?.visible === 4 && !(hrDocs.body?.documents || []).some((doc) => doc.id === 'demo-manager-purchase'), `visible=${hrDocs.body?.visible}`);
  const managerDocs = await api('/api/documents', { token: managerToken });
  check('主管拿到 4 份（看不到人事专属）', managerDocs.body?.visible === 4 && !(managerDocs.body?.documents || []).some((doc) => doc.id === 'demo-hr-onboarding'), `visible=${managerDocs.body?.visible}`);
  const adminDocs = await api('/api/documents', { token: adminToken });
  check('管理员拿到全部 5 份', adminDocs.body?.visible === 5, `visible=${adminDocs.body?.visible}`);

  const deniedOpen = await api('/api/documents/demo-hr-onboarding', { token: employeeToken });
  check('员工按 id 直接请求越权文档返回 403', deniedOpen.status === 403, `status=${deniedOpen.status}`);
  check('403 响应不含文档正文', !JSON.stringify(deniedOpen.body).includes('入职当天由人事核验录用材料'), JSON.stringify(deniedOpen.body).slice(0, 80));
  check('员工请求有权文档返回 200', (await api('/api/documents/demo-finance-travel', { token: employeeToken })).status === 200);

  // ── C. 写入侧 RBAC ──────────────────────────────────────────────────────
  check('非管理员新增文档返回 403', (await api('/api/documents', { method: 'POST', token: employeeToken, body: { title: '越权测试', body: '内容' } })).status === 403);
  check('非管理员启停文档返回 403', (await api('/api/documents', { method: 'PATCH', token: hrToken, body: { id: 'demo-hr-leave' } })).status === 403);
  check('非管理员移除文档返回 403', (await api('/api/documents/demo-hr-leave', { method: 'DELETE', token: managerToken })).status === 403);
  const created = await api('/api/documents', { method: 'POST', token: adminToken, body: { title: '服务端新增制度', category: '其他', audience: 'all', body: '服务端新增制度\n本制度由管理员通过服务端接口录入，用于验证写入侧权限。' } });
  check('管理员新增文档成功', created.status === 201 && !!created.body?.document?.id, `status=${created.status}`);
  const employeeDocsAfter = await api('/api/documents', { token: employeeToken });
  check('管理员新增的 all 文档对员工可见', employeeDocsAfter.body?.visible === 4, `visible=${employeeDocsAfter.body?.visible}`);
  check('管理员移除文档成功', (await api(`/api/documents/${created.body.document.id}`, { method: 'DELETE', token: adminToken })).status === 200);

  // ── D. 审计 ─────────────────────────────────────────────────────────────
  check('非管理员读取审计日志返回 403', (await api('/api/audit', { token: employeeToken })).status === 403);
  const audit1 = await api('/api/audit?limit=200', { token: adminToken });
  check('管理员可读取审计日志', audit1.status === 200 && Array.isArray(audit1.body?.entries));
  check('哈希链校验通过', audit1.body?.integrity?.ok === true, JSON.stringify(audit1.body?.integrity));
  const deniedEntry = (audit1.body.entries || []).find((entry) => entry.action === 'open_document' && entry.result === 'denied');
  check('越权访问由服务端权威记为 denied', !!deniedEntry, deniedEntry ? `#${deniedEntry.seq} ${deniedEntry.detail}` : '未找到');
  check('服务端审计条目带 user / role / ip 权威字段', !!deniedEntry?.user && !!deniedEntry?.role && !!deniedEntry?.ip, deniedEntry ? `${deniedEntry.user}/${deniedEntry.role}/${deniedEntry.ip}` : '');
  check('审计为追加式（写入只增不减）', (audit1.body.entries || []).every((entry) => typeof entry.prevHash === 'string' && typeof entry.hash === 'string'));

  await api('/api/events', { method: 'POST', token: adminToken, body: { action: 'query', detail: '年假怎么申请（3 条证据）' } });
  const audit2 = await api('/api/audit?limit=200', { token: adminToken });
  check('客户端上报的业务事件被写入', audit2.body.total > audit1.body.total, `${audit1.body.total} → ${audit2.body.total}`);
  check('客户端无法伪造 user 字段', (audit2.body.entries || []).find((entry) => entry.action === 'query')?.user === 'admin');

  // 直接改写磁盘上的 audit.jsonl —— 这是「本机审计可被清空 / 篡改」的反例验证
  const rawLines = fs.readFileSync(AUDIT_FILE, 'utf8').split('\n').filter(Boolean);
  const tampered = JSON.parse(rawLines[1]);
  const originalDetail = tampered.detail;
  tampered.detail = '被偷偷改过的内容';
  rawLines[1] = JSON.stringify(tampered);
  fs.writeFileSync(AUDIT_FILE, `${rawLines.join('\n')}\n`, 'utf8');
  const audit3 = await api('/api/audit?limit=200', { token: adminToken });
  check('直接改写 audit.jsonl 会被哈希链检出', audit3.body?.integrity?.ok === false, JSON.stringify(audit3.body?.integrity));
  check('篡改定位到具体行号', audit3.body?.integrity?.brokenAt === 2, `brokenAt=${audit3.body?.integrity?.brokenAt}`);
  check('给出可读的篡改原因', /hash/.test(audit3.body?.integrity?.reason || ''), audit3.body?.integrity?.reason);
  // 还原，便于后续浏览器阶段看到正常状态
  tampered.detail = originalDetail;
  rawLines[1] = JSON.stringify(tampered);
  fs.writeFileSync(AUDIT_FILE, `${rawLines.join('\n')}\n`, 'utf8');
  check('还原后哈希链恢复完整', (await api('/api/audit?limit=200', { token: adminToken })).body?.integrity?.ok === true);

  // ── E. 静态资源隔离 ─────────────────────────────────────────────────────
  check('静态托管返回 index.html', (await fetch(`${BASE}/`)).status === 200);
  check('data/ 目录不对外暴露', (await fetch(`${BASE}/data/audit.jsonl`)).status === 404);
  check('server/ 目录不对外暴露', (await fetch(`${BASE}/server/server.mjs`)).status === 404);
  check('密钥文件不对外暴露', (await fetch(`${BASE}/data/secret.key`)).status === 404);

  // ── F. 前端集成 ─────────────────────────────────────────────────────────
  browser = await launchBrowser();
  const page = await (await browser.newContext({ viewport: { width: 1365, height: 1000 } })).newPage();
  const browserErrors = [];
  page.on('pageerror', (error) => browserErrors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error' && !/Failed to load resource/i.test(message.text())) browserErrors.push(message.text()); });
  page.on('dialog', (dialog) => dialog.accept());

  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.querySelector('#statDocs')?.textContent === '3');
  check('默认仍是纯本地模式', /纯本地模式/.test(await page.locator('#serverStatus').innerText()), await page.locator('#serverStatus').innerText());

  await page.locator('.nav button[data-page="manage"]').click();
  await page.locator('#serverUrl').fill(BASE);
  await page.locator('#serverUser').fill('hr');
  await page.locator('#serverPass').fill('demo1234');
  await page.locator('#serverConnect').click();
  await page.waitForFunction(() => document.querySelector('#serverStatus')?.classList.contains('on'), null, { timeout: 8000 });
  check('页面登录后进入服务端模式', /已连接服务端/.test(await page.locator('#serverStatus').innerText()));
  check('服务端模式下身份下拉被锁定', await page.locator('#roleSelect').isDisabled());

  await page.locator('.nav button[data-page="docs"]').click();
  await page.waitForTimeout(300);
  check('文档集来自服务端（人事 4 份）', (await page.locator('#docGrid .doc-card').count()) === 4, `实际 ${await page.locator('#docGrid .doc-card').count()} 张`);
  check('越权文档根本不下发（列表无受限卡片）', (await page.locator('#docGrid .doc-card.restricted').count()) === 0);
  check('文档列表里没有主管专属文档', (await page.locator('#docGrid .doc-card', { hasText: '部门采购审批说明' }).count()) === 0);

  await page.locator('.nav button[data-page="ask"]').click();
  await page.locator('#questionInput').fill('差旅报销需要什么材料');
  await page.locator('#askButton').click();
  await page.waitForTimeout(400);
  check('服务端模式下检索正常作答', (await page.locator('#answerPane').innerText()).includes('经审批的出差申请'), await page.locator('#resultStatus').innerText());

  // 人事是非管理员：读服务端审计应被拒
  await page.locator('.nav button[data-page="audit"]').click();
  await page.locator('#auditServer').click();
  await page.waitForFunction(() => /拉取失败|哈希链校验/.test(document.querySelector('#serverAuditPanel')?.innerText || ''), null, { timeout: 8000 });
  const hrPanel = await page.locator('#serverAuditPanel').innerText();
  check('非管理员读服务端审计被拒并给出可读原因', /拉取失败/.test(hrPanel) && /只有管理员/.test(hrPanel), hrPanel.replace(/\s+/g, ' ').slice(0, 110));

  // 换成管理员再看一次
  await page.locator('.nav button[data-page="manage"]').click();
  await page.locator('#serverDisconnect').click();
  await page.waitForFunction(() => !document.querySelector('#serverStatus')?.classList.contains('on'), null, { timeout: 8000 });
  check('断开后回到纯本地模式', /纯本地模式/.test(await page.locator('#serverStatus').innerText()));
  check('断开后身份下拉恢复可用', !(await page.locator('#roleSelect').isDisabled()));
  await page.locator('.nav button[data-page="docs"]').click();
  await page.waitForTimeout(300);
  check('断开后文档集回到本地 5 份', (await page.locator('#docGrid .doc-card').count()) === 5, `实际 ${await page.locator('#docGrid .doc-card').count()} 张`);

  await page.locator('.nav button[data-page="manage"]').click();
  await page.locator('#serverUser').fill('admin');
  await page.locator('#serverPass').fill('demo1234');
  await page.locator('#serverConnect').click();
  await page.waitForFunction(() => document.querySelector('#serverStatus')?.classList.contains('on'), null, { timeout: 8000 });
  await page.locator('.nav button[data-page="docs"]').click();
  await page.waitForTimeout(300);
  check('管理员登录后拿到全部 5 份文档', (await page.locator('#docGrid .doc-card').count()) === 5, `实际 ${await page.locator('#docGrid .doc-card').count()} 张`);

  await page.locator('.nav button[data-page="audit"]').click();
  await page.locator('#auditServer').click();
  await page.waitForFunction(() => /哈希链校验/.test(document.querySelector('#serverAuditPanel')?.innerText || ''), null, { timeout: 8000 });
  const panel = await page.locator('#serverAuditPanel').innerText();
  check('管理员可拉取服务端权威日志', /服务端审计日志/.test(panel) && /哈希链校验：完整/.test(panel), panel.replace(/\s+/g, ' ').slice(0, 110));
  check('服务端审计面板渲染出记录行', (await page.locator('#serverAuditPanel .server-row').count()) > 1);
  check('服务端审计里能看到越权拒绝记录', /已拒绝/.test(panel));

  check('无浏览器控制台 / 运行时错误', browserErrors.length === 0, browserErrors.slice(0, 2).join(' | '));
} catch (error) {
  check('测试执行未抛异常', false, error.message);
} finally {
  if (browser) await browser.close().catch(() => {});
  child.kill();
  await new Promise((r) => setTimeout(r, 200));
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
}

const passed = results.filter((item) => item.pass).length;
console.log(`\n================ 服务端模式测试结果 ================`);
console.log(`通过 ${passed}/${results.length}`);
if (passed !== results.length) process.exitCode = 1;
