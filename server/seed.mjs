/** 演示账号（首次启动写入 data/users.json，口令经 scrypt 加盐哈希后存储）。 */
export const DEMO_USERS = [
  { username: 'employee', password: 'demo1234', role: 'employee' },
  { username: 'hr', password: 'demo1234', role: 'hr' },
  { username: 'manager', password: 'demo1234', role: 'manager' },
  { username: 'admin', password: 'demo1234', role: 'admin' },
];
