#!/usr/bin/env node
/**
 * 企业内部知识问答与制度助手 · 服务端参考实现（零依赖，只用 Node 内置模块）
 *
 * 目的：把「权限」与「审计」从浏览器搬到服务端，解决纯本地原型的三条硬伤——
 *   1. 身份靠下拉手动切换 → 改为真实登录（scrypt 口令哈希 + HMAC 签名 token）
 *   2. 可见范围只在前端过滤，改代码即可绕过 → 文档在出网前按身份过滤，越权文档不下发；
 *      直接按 id 请求越权文档返回 403，并且这次拒绝由服务端权威记入审计
 *   3. 审计存本机 IndexedDB，用户可自行清空 → 改为服务端 append-only JSONL + 哈希链，
 *      不提供任何修改 / 删除接口，篡改会被 verifyChain() 检出
 *
 * 启动：
 *   node server/server.mjs                 # 默认 http://127.0.0.1:8787
 *   ZHIGUI_PORT=9000 node server/server.mjs
 *
 * 环境变量：
 *   ZHIGUI_PORT / PORT        监听端口（默认 8787）
 *   ZHIGUI_HOST               监听地址（默认 127.0.0.1，只绑本机）
 *   ZHIGUI_DATA_DIR           数据目录（默认 <项目根>/data）
 *   ZHIGUI_SECRET             token 签名密钥（默认生成并持久化到 <data>/secret.key）
 *   ZHIGUI_CORS_ORIGIN        允许的跨域来源（默认 *，仅适用于本机演示）
 *   ZHIGUI_TOKEN_TTL_MINUTES  token 有效期（默认 120）
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { ACCESS_POLICY, AUDIENCE_LABELS, canAccess, visibleDocuments, describeDenial } from './policy.mjs';
import { AuditLog } from './audit.mjs';
import { UserStore, loadSecret, signToken, verifyToken } from './auth.mjs';
import { DEMO_USERS } from './seed.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const DATA = path.resolve(process.env.ZHIGUI_DATA_DIR || path.join(ROOT, 'data'));

const PORT = Number(process.env.ZHIGUI_PORT || process.env.PORT || 8787);
const HOST = process.env.ZHIGUI_HOST || '127.0.0.1';
const CORS_ORIGIN = process.env.ZHIGUI_CORS_ORIGIN || '*';
const TOKEN_TTL_MINUTES = Number(process.env.ZHIGUI_TOKEN_TTL_MINUTES || 120);

// ── 数据 ────────────────────────────────────────────────────────────────────
fs.mkdirSync(DATA, { recursive: true });

const SECRET = loadSecret(path.join(DATA, 'secret.key'));
const users = new UserStore(path.join(DATA, 'users.json'), DEMO_USERS);
const audit = new AuditLog(path.join(DATA, 'audit.jsonl'));

const DOCUMENTS_FILE = path.join(DATA, 'documents.json');
if (!fs.existsSync(DOCUMENTS_FILE)) {
  fs.copyFileSync(path.join(HERE, 'seed-documents.json'), DOCUMENTS_FILE);
}
const documents = JSON.parse(fs.readFileSync(DOCUMENTS_FILE, 'utf8'));
const saveDocuments = () => fs.writeFileSync(DOCUMENTS_FILE, JSON.stringify(documents, null, 2), 'utf8');

// ── 工具 ────────────────────────────────────────────────────────────────────
const clientIp = (req) => (req.socket.remoteAddress || '').replace(/^::ffff:/, '');

function send(res, status, body, extraHeaders = {}) {
  const payload = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': CORS_ORIGIN,
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
    ...extraHeaders,
  });
  res.end(payload);
}

function readJson(req, limitBytes = 1024 * 512) {
  return new Promise((resolve) => {
    let raw = '';
    let tooLarge = false;
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > limitBytes) { tooLarge = true; req.destroy(); }
    });
    req.on('end', () => {
      if (tooLarge) return resolve({ __error: '请求体过大' });
      try { resolve(JSON.parse(raw || '{}')); } catch { resolve({ __error: '请求体不是合法 JSON' }); }
    });
    req.on('error', () => resolve({ __error: '读取请求体失败' }));
  });
}

/** 解析 Bearer token，返回 { username, role }；失败返回 null。 */
function authenticate(req) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  const payload = verifyToken(token, SECRET);
  if (!payload) return null;
  const user = users.users.find((item) => item.username === payload.sub);
  if (!user) return null;
  return { username: user.username, role: user.role };
}

// 登录限速：同一 IP 5 分钟内最多 10 次失败尝试
const loginAttempts = new Map();
const LOGIN_WINDOW_MS = 5 * 60 * 1000;
const LOGIN_MAX_FAILURES = 10;
function loginRateLimited(ip) {
  const record = loginAttempts.get(ip);
  if (!record || record.resetAt < Date.now()) return false;
  return record.failures >= LOGIN_MAX_FAILURES;
}
function noteLoginFailure(ip) {
  const record = loginAttempts.get(ip);
  if (!record || record.resetAt < Date.now()) loginAttempts.set(ip, { failures: 1, resetAt: Date.now() + LOGIN_WINDOW_MS });
  else record.failures += 1;
}

// ── 客户端事件上报的白名单 ──────────────────────────────────────────────────
// 只接受「服务端无法感知的纯前端行为」。像 open_document / import_document /
// toggle_document / delete_document / export_backup 这类**服务端自己会权威记录**的事件，
// 一律不接受客户端上报 —— 否则同一件事会出现两条来源不同、可信度不同的记录，
// 取证时无法区分「服务端确认发生」与「客户端声称发生」。
const CLIENT_REPORTABLE_ACTIONS = new Set([
  'query',          // 检索在浏览器本地执行，服务端感知不到
  'query_blocked',  // 前置安全闸在前端
  'copy_text',      // 纯前端行为
  'llm_config',     // 模型配置存前端 localStorage
  'llm_models',     // 前端直连模型服务拉取列表
  'role_switch',    // 纯本地模式的演示身份切换
  'export_backup',  // 导出本机知识库备份，服务端不感知
  'audit_export',   // 导出本机审计日志，服务端不感知
  'audit_clear',    // 清空本机审计日志：只影响前端 IndexedDB，动不了服务端 append-only 日志
]);
// ⚠️ 这份白名单必须覆盖「前端会主动上报的全部动作」。
// 前端 index.html 里 `recordAudit()` 会跳过 SERVER_AUTHORITATIVE（由服务端权威记录的那批），
// 其余动作一律上报；因此本集合必须 ⊇ (AUDIT_LABELS \ SERVER_AUTHORITATIVE)。
// 少放行一个动作，它就会被 400 拒掉并记成 client_event_rejected，等于审计静默降级。
// 这个不变量由 eval/server-mode-test.mjs 的白名单一致性用例守护。

// 事件写入限速：同一用户 1 分钟内最多 60 条。
// 在没有日志轮转机制之前，这是防止审计文件被高频上报灌爆的兜底。
const eventRate = new Map();
const EVENT_WINDOW_MS = 60 * 1000;
const EVENT_MAX_PER_WINDOW = 60;
function eventRateLimited(user) {
  const now = Date.now();
  const record = eventRate.get(user);
  if (!record || record.resetAt < now) {
    // 顺手清理已过期条目，避免 Map 随用户数无限增长
    if (eventRate.size > 500) {
      for (const [key, value] of eventRate) if (value.resetAt < now) eventRate.delete(key);
    }
    eventRate.set(user, { count: 1, resetAt: now + EVENT_WINDOW_MS });
    return false;
  }
  record.count += 1;
  return record.count > EVENT_MAX_PER_WINDOW;
}

// ── 路由 ────────────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
  const route = `${req.method} ${url.pathname}`;
  const ip = clientIp(req);

  if (req.method === 'OPTIONS') { send(res, 204, undefined); return; }

  // 静态资源：**只托管 index.html**。data/（审计日志、用户库、密钥）与 server/ 一律不暴露。
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    const html = fs.readFileSync(path.join(ROOT, 'index.html'));
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(html);
    return;
  }
  if (req.method === 'GET' && url.pathname === '/favicon.ico') { send(res, 204, undefined); return; }

  // 非 /api 的其它路径一律 404 —— 静态资源只托管 index.html，
  // 这样探测 data/audit.jsonl 或 server/server.mjs 时既拿不到内容，也拿不到「该路径存在」的信号。
  if (!url.pathname.startsWith('/api/')) { send(res, 404, { error: '未找到该资源' }); return; }

  if (req.method === 'GET' && url.pathname === '/api/health') {
    send(res, 200, {
      ok: true,
      documents: documents.length,
      users: users.size,
      auditEntries: audit.size,
      auditSources: audit.countBySource(),
      policy: Object.keys(ACCESS_POLICY),
    });
    return;
  }

  // ── 登录 ──────────────────────────────────────────────────────────────────
  if (route === 'POST /api/login') {
    if (loginRateLimited(ip)) {
      audit.append({ action: 'login', detail: '登录被限速拒绝', result: 'denied', user: '', role: '', ip });
      send(res, 429, { error: '尝试次数过多，请稍后再试' });
      return;
    }
    const body = await readJson(req);
    if (body.__error) { send(res, 400, { error: body.__error }); return; }
    const user = users.authenticate(body.username, body.password);
    if (!user) {
      noteLoginFailure(ip);
      audit.append({ action: 'login', target: String(body.username || ''), detail: '用户名或口令不正确', result: 'denied', user: '', role: '', ip });
      send(res, 401, { error: '用户名或口令不正确' });
      return;
    }
    const { token, payload } = signToken(user, SECRET, TOKEN_TTL_MINUTES * 60 * 1000);
    audit.append({ action: 'login', target: user.username, detail: `登录成功 · 角色 ${ACCESS_POLICY[user.role]?.label || user.role}`, result: 'allowed', user: user.username, role: user.role, ip });
    send(res, 200, { token, expiresAt: new Date(payload.exp).toISOString(), user: { username: user.username, role: user.role, label: ACCESS_POLICY[user.role]?.label || user.role } });
    return;
  }

  // 以下接口都需要有效 token
  const identity = authenticate(req);
  if (!identity) {
    send(res, 401, { error: '未登录或登录已过期' });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/session') {
    send(res, 200, { user: { username: identity.username, role: identity.role, label: ACCESS_POLICY[identity.role]?.label || identity.role } });
    return;
  }

  // ── 文档：出网前按身份过滤 ────────────────────────────────────────────────
  if (req.method === 'GET' && url.pathname === '/api/documents') {
    const visible = visibleDocuments(identity.role, documents);
    send(res, 200, {
      role: identity.role,
      label: ACCESS_POLICY[identity.role]?.label || identity.role,
      total: documents.length,
      visible: visible.length,
      audiences: AUDIENCE_LABELS,
      documents: visible,
    });
    return;
  }

  const documentMatch = url.pathname.match(/^\/api\/documents\/([^/]+)$/);
  if (req.method === 'GET' && documentMatch) {
    const id = decodeURIComponent(documentMatch[1]);
    const doc = documents.find((item) => item.id === id);
    if (!doc) { send(res, 404, { error: '文档不存在' }); return; }
    if (!canAccess(identity.role, doc)) {
      // 越权拒绝由**服务端**权威记录，不依赖客户端上报
      audit.append({ action: 'open_document', target: doc.title, detail: describeDenial(identity.role, doc), result: 'denied', user: identity.username, role: identity.role, ip });
      send(res, 403, { error: describeDenial(identity.role, doc) });
      return;
    }
    audit.append({ action: 'open_document', target: doc.title, detail: `${doc.category} · 服务端放行`, result: 'allowed', user: identity.username, role: identity.role, ip });
    send(res, 200, { document: doc });
    return;
  }

  // 写入侧同样做 RBAC：只有管理员能新增 / 修改文档
  if (route === 'POST /api/documents') {
    const body = await readJson(req);
    if (body.__error) { send(res, 400, { error: body.__error }); return; }
    if (identity.role !== 'admin') {
      audit.append({ action: 'import_document', target: String(body.title || ''), detail: `身份「${ACCESS_POLICY[identity.role]?.label || identity.role}」没有维护文档的权限`, result: 'denied', user: identity.username, role: identity.role, ip });
      send(res, 403, { error: `身份「${ACCESS_POLICY[identity.role]?.label || identity.role}」没有维护文档的权限，只有管理员可以新增或修改文档。` });
      return;
    }
    const title = String(body.title || '').trim();
    const text = String(body.body || '').trim();
    if (!title || !text) { send(res, 400, { error: '文档标题与正文不能为空' }); return; }
    const audience = ['all', 'hr', 'manager'].includes(body.audience) ? body.audience : 'all';
    const existing = body.id ? documents.find((item) => item.id === body.id) : null;
    const doc = {
      id: existing?.id || `srv-${crypto.randomUUID()}`,
      title,
      category: String(body.category || '其他').trim() || '其他',
      audience,
      status: body.status === 'inactive' ? 'inactive' : 'active',
      source: String(body.source || '服务端录入'),
      body: text,
      createdAt: existing?.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    if (existing) Object.assign(existing, doc);
    else documents.push(doc);
    saveDocuments();
    audit.append({ action: existing ? 'edit_document' : 'import_document', target: doc.title, detail: `${doc.category} · ${AUDIENCE_LABELS[doc.audience]} · ${doc.body.length} 字`, result: 'allowed', user: identity.username, role: identity.role, ip });
    send(res, existing ? 200 : 201, { document: doc });
    return;
  }

  // 启停：同样只有管理员可操作
  if (route === 'PATCH /api/documents') {
    const body = await readJson(req);
    if (body.__error) { send(res, 400, { error: body.__error }); return; }
    if (identity.role !== 'admin') {
      audit.append({ action: 'toggle_document', target: String(body.id || ''), detail: `身份「${ACCESS_POLICY[identity.role]?.label || identity.role}」没有维护文档的权限`, result: 'denied', user: identity.username, role: identity.role, ip });
      send(res, 403, { error: `身份「${ACCESS_POLICY[identity.role]?.label || identity.role}」没有维护文档的权限，只有管理员可以启停文档。` });
      return;
    }
    const doc = documents.find((item) => item.id === body.id);
    if (!doc) { send(res, 404, { error: '文档不存在' }); return; }
    doc.status = doc.status === 'active' ? 'inactive' : 'active';
    doc.updatedAt = new Date().toISOString();
    saveDocuments();
    audit.append({ action: 'toggle_document', target: doc.title, detail: doc.status === 'active' ? '已启用' : '已停用', result: 'allowed', user: identity.username, role: identity.role, ip });
    send(res, 200, { document: doc });
    return;
  }

  // 移除：同样只有管理员可操作
  if (req.method === 'DELETE' && documentMatch) {
    const id = decodeURIComponent(documentMatch[1]);
    if (identity.role !== 'admin') {
      audit.append({ action: 'delete_document', target: id, detail: `身份「${ACCESS_POLICY[identity.role]?.label || identity.role}」没有维护文档的权限`, result: 'denied', user: identity.username, role: identity.role, ip });
      send(res, 403, { error: `身份「${ACCESS_POLICY[identity.role]?.label || identity.role}」没有维护文档的权限，只有管理员可以移除文档。` });
      return;
    }
    const index = documents.findIndex((item) => item.id === id);
    if (index < 0) { send(res, 404, { error: '文档不存在' }); return; }
    const [removed] = documents.splice(index, 1);
    saveDocuments();
    audit.append({ action: 'delete_document', target: removed.title, detail: '已从服务端知识库移除', result: 'allowed', user: identity.username, role: identity.role, ip });
    send(res, 200, { ok: true, id });
    return;
  }

  // ── 业务事件上报（仅接受白名单内的纯前端事件）─────────────────────────────
  // 时间 / 身份 / IP 由服务端补全；action / target / detail 属于**客户端声明**，
  // 因此落盘时标记 source=client，与 source=server 的权威记录在存储层就可区分。
  if (route === 'POST /api/events') {
    const body = await readJson(req);
    if (body.__error) { send(res, 400, { error: body.__error }); return; }
    const action = String(body.action || '');
    if (!CLIENT_REPORTABLE_ACTIONS.has(action)) {
      // 拒绝本身也由服务端权威留痕，并带上被拒的 action 以便排查
      audit.append({
        action: 'client_event_rejected',
        target: action.slice(0, 60) || '(空)',
        detail: `客户端上报了不在白名单内的事件类型；仅接受：${[...CLIENT_REPORTABLE_ACTIONS].join(' / ')}`,
        result: 'denied',
        user: identity.username, role: identity.role, ip,
      });
      send(res, 400, { error: `事件类型「${action || '(空)'}」不允许由客户端上报` });
      return;
    }
    if (eventRateLimited(identity.username)) {
      audit.append({
        action: 'client_event_rejected',
        target: action,
        detail: `上报频率超限（同一用户 ${EVENT_WINDOW_MS / 60000} 分钟内超过 ${EVENT_MAX_PER_WINDOW} 条）`,
        result: 'denied',
        user: identity.username, role: identity.role, ip,
      });
      send(res, 429, { error: '事件上报过于频繁，请稍后再试' });
      return;
    }
    const entry = audit.append({
      action,
      target: String(body.target || '').slice(0, 200),
      detail: String(body.detail || '').slice(0, 500),
      result: body.result === 'denied' ? 'denied' : 'allowed',
      user: identity.username,
      role: identity.role,
      ip,
      source: 'client',
    });
    send(res, 202, { ok: true, seq: entry.seq, source: 'client' });
    return;
  }

  // ── 审计查询：仅管理员 ────────────────────────────────────────────────────
  if (req.method === 'GET' && url.pathname === '/api/audit') {
    if (identity.role !== 'admin') {
      audit.append({ action: 'audit_read', detail: `身份「${ACCESS_POLICY[identity.role]?.label || identity.role}」尝试读取审计日志`, result: 'denied', user: identity.username, role: identity.role, ip });
      send(res, 403, { error: '只有管理员可以读取审计日志。' });
      return;
    }
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit') || 100), 1), 500);
    send(res, 200, {
      integrity: audit.verifyChain(),
      total: audit.size,
      sources: audit.countBySource(),
      entries: audit.tail(limit),
    });
    return;
  }

  send(res, 404, { error: `未知接口：${route}` });
});

export { server, audit, documents };

// 仅在直接运行时监听；被 import 时（例如测试里复用模块）不自动起服务。
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  server.listen(PORT, HOST, () => {
    const integrity = audit.verifyChain();
    console.log(`企业内部知识问答与制度助手 · 服务端已启动`);
    console.log(`  地址        http://${HOST}:${PORT}`);
    console.log(`  数据目录    ${DATA}`);
    console.log(`  文档        ${documents.length} 份（出网前按身份过滤）`);
    console.log(`  账号        ${DEMO_USERS.map((u) => `${u.username}/${u.password}（${ACCESS_POLICY[u.role].label}）`).join('  ')}`);
    console.log(`  审计        ${path.join(DATA, 'audit.jsonl')} · 已记录 ${audit.size} 条 · 哈希链 ${integrity.ok ? '完整' : `异常（第 ${integrity.brokenAt} 条：${integrity.reason}）`}`);
    console.log(`  说明        静态资源只托管 index.html，data/ 与 server/ 不对外暴露`);
  });
}
