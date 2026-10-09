/**
 * 身份认证：scrypt 口令哈希 + HMAC 签名 token。
 *
 * token 结构：base64url(JSON payload) + "." + base64url(HMAC-SHA256(payload, secret))
 * payload：{ sub: 用户名, role, iat, exp }
 *
 * 之所以不用 JWT 库：本参考实现坚持零依赖，而这里需要的只是「服务端签发、服务端能验签」，
 * 一个 HMAC 就够。没有引入 JWT 的 alg 协商，也就没有 alg=none 这类经典坑。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const TOKEN_TTL_MS = 2 * 60 * 60 * 1000; // 2 小时

export function base64url(buffer) {
  return Buffer.from(buffer).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function fromBase64url(value) {
  return Buffer.from(String(value).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

export function hashPassword(password, salt) {
  return crypto.scryptSync(String(password), salt, 32).toString('hex');
}
export function verifyPassword(password, salt, expected) {
  const actual = hashPassword(password, salt);
  const a = Buffer.from(actual, 'hex');
  const b = Buffer.from(String(expected || ''), 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/** 载入或生成签名密钥（持久化到 data/secret.key，权限 0600）。 */
export function loadSecret(file, fromEnv = process.env.ZHIGUI_SECRET) {
  if (fromEnv) return String(fromEnv);
  if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8').trim();
  const secret = crypto.randomBytes(32).toString('hex');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, secret, { encoding: 'utf8', mode: 0o600 });
  return secret;
}

export function signToken(user, secret, ttlMs = TOKEN_TTL_MS) {
  const now = Date.now();
  const payload = { sub: user.username, role: user.role, iat: now, exp: now + ttlMs };
  const body = base64url(JSON.stringify(payload));
  const signature = base64url(crypto.createHmac('sha256', secret).update(body).digest());
  return { token: `${body}.${signature}`, payload };
}

/** 验签 + 校验过期。任何异常都返回 null，由调用方统一回 401。 */
export function verifyToken(token, secret) {
  try {
    const [body, signature] = String(token || '').split('.');
    if (!body || !signature) return null;
    const expected = base64url(crypto.createHmac('sha256', secret).update(body).digest());
    const a = Buffer.from(signature);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    const payload = JSON.parse(fromBase64url(body).toString('utf8'));
    if (typeof payload.exp !== 'number' || payload.exp < Date.now()) return null;
    if (!payload.sub || !payload.role) return null;
    return payload;
  } catch {
    return null;
  }
}

/** 用户仓库：data/users.json（含 salt + scrypt 哈希，明文口令不落盘）。 */
export class UserStore {
  constructor(file, seedUsers) {
    this.file = file;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (!fs.existsSync(file)) {
      const users = seedUsers.map(({ username, password, role }) => {
        const salt = crypto.randomBytes(16).toString('hex');
        return { username, role, salt, hash: hashPassword(password, salt), createdAt: new Date().toISOString() };
      });
      fs.writeFileSync(file, JSON.stringify(users, null, 2), 'utf8');
    }
    this.users = JSON.parse(fs.readFileSync(file, 'utf8'));
  }

  get size() { return this.users.length; }

  authenticate(username, password) {
    const user = this.users.find((item) => item.username === String(username || '').trim());
    if (!user) {
      // 用户不存在时也做一次等价开销的哈希，避免通过响应时间枚举用户名
      hashPassword(String(password || ''), 'enumeration-guard');
      return null;
    }
    if (!verifyPassword(password, user.salt, user.hash)) return null;
    return { username: user.username, role: user.role };
  }
}
