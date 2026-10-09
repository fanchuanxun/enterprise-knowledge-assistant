/**
 * 追加式审计日志（append-only + 哈希链）。
 *
 * 设计目标：把「审计可被本机清空 / 篡改」这条局限真正解决掉。
 *   - 只追加，不提供任何修改或删除接口
 *   - 每条记录写入 prevHash 与 hash，形成链：
 *       hash = sha256(`${prevHash}|${seq}|${at}|${user}|${role}|${action}|${target}|${detail}|${result}`)
 *     首条记录的 prevHash 为 "GENESIS"
 *   - verifyChain() 逐条重算，任何一行被改动 / 删除 / 换序都会暴露出来
 *
 * 注意：哈希链只能**发现**篡改，不能**阻止**有文件写权限的人重算整条链。
 * 真实生产应把日志实时推送到独立的只写存储（对象存储 WORM、日志服务、SIEM），
 * 或对链尾定期做外部签名 / 时间戳锚定。这一点在 docs/服务端说明.md 里有说明。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const GENESIS = 'GENESIS';

export function canonicalLine(entry) {
  return [entry.prevHash, entry.seq, entry.at, entry.user, entry.role, entry.action, entry.target, entry.detail, entry.result].join('|');
}

export function hashEntry(entry) {
  return crypto.createHash('sha256').update(canonicalLine(entry), 'utf8').digest('hex');
}

export class AuditLog {
  constructor(file) {
    this.file = file;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (!fs.existsSync(file)) fs.writeFileSync(file, '', 'utf8');
    this.entries = this.#load();
  }

  #load() {
    const raw = fs.readFileSync(this.file, 'utf8');
    return raw.split('\n').filter(Boolean).map((line, index) => {
      try { return JSON.parse(line); } catch { return { __broken: true, __line: index + 1, raw: line.slice(0, 200) }; }
    });
  }

  get size() { return this.entries.length; }

  /** 追加一条记录，返回落盘后的完整条目。字段中的 user / role / ip 由服务端补全，不接受客户端指定。 */
  append({ action, target = '', detail = '', result = 'allowed', user = '', role = '', ip = '' }) {
    const previous = this.entries[this.entries.length - 1];
    const entry = {
      seq: this.entries.length + 1,
      at: new Date().toISOString(),
      user,
      role,
      action,
      target,
      detail,
      result,
      ip,
      prevHash: previous?.hash || GENESIS,
    };
    entry.hash = hashEntry(entry);
    this.entries.push(entry);
    fs.appendFileSync(this.file, `${JSON.stringify(entry)}\n`, 'utf8');
    return entry;
  }

  /** 最近 N 条（倒序）。 */
  tail(limit = 100) {
    return this.entries.slice(-limit).reverse();
  }

  /**
   * 逐条重算哈希链。
   * **从磁盘重新读取**而不是用内存缓存 —— 只有读盘重算才能发现「有人直接改了 audit.jsonl」。
   * @returns {{ok:boolean,total:number,brokenAt:number|null,reason:string}}
   */
  verifyChain() {
    const entries = this.#load();
    let prevHash = GENESIS;
    for (let index = 0; index < entries.length; index++) {
      const entry = entries[index];
      const seq = index + 1;
      if (entry.__broken) return { ok: false, total: entries.length, brokenAt: seq, reason: '该行不是合法 JSON，已被改动或截断' };
      if (entry.seq !== seq) return { ok: false, total: entries.length, brokenAt: seq, reason: `序号不连续：期望 ${seq}，实际 ${entry.seq}` };
      if (entry.prevHash !== prevHash) return { ok: false, total: entries.length, brokenAt: seq, reason: 'prevHash 与前一条记录的 hash 不匹配（记录被删除、插入或换序）' };
      if (hashEntry(entry) !== entry.hash) return { ok: false, total: entries.length, brokenAt: seq, reason: '记录内容与 hash 不匹配（该条被改写）' };
      prevHash = entry.hash;
    }
    return { ok: true, total: entries.length, brokenAt: null, reason: '' };
  }
}
