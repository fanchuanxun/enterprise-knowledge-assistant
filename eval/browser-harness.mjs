/**
 * 浏览器测试夹具：把「找到 playwright-core」与「找到 Chrome」这两件与机器强相关的事
 * 收敛到一处。
 *
 * 之所以单独抽出来：这两个路径此前在 9 个测试脚本里各写了一份硬编码的本机绝对路径，
 * 换一台机器（或别人克隆仓库后）测试必然跑不起来。现在只在这里解析一次。
 *
 * 解析顺序（均可用环境变量覆盖）：
 *   playwright-core：PLAYWRIGHT_CORE → 项目 node_modules（npm install 装的）→ NODE_PATH 下的各安装位置
 *   Chrome：CHROME_PATH → PUPPETEER_EXECUTABLE_PATH → 各平台常见安装路径 → 交给 playwright 自带的浏览器
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export function playwrightCandidates() {
  const list = [];
  if (process.env.PLAYWRIGHT_CORE) list.push(process.env.PLAYWRIGHT_CORE);
  // 裸模块名：由 Node 从本文件所在位置向上找 node_modules，是 npm install 后的常规路径
  list.push('playwright-core', 'playwright');
  // NODE_PATH 指向的目录（Node 的 ESM 解析不认 NODE_PATH，这里手动补上）
  for (const dir of String(process.env.NODE_PATH || '').split(path.delimiter).filter(Boolean)) {
    for (const name of ['playwright-core', 'playwright']) {
      list.push(path.join(dir, name, 'index.mjs'));
      list.push(path.join(dir, name, 'index.js'));
    }
  }
  return [...new Set(list)];
}

export async function loadChromium() {
  let lastError;
  for (const candidate of playwrightCandidates()) {
    try {
      const specifier = /^[A-Za-z]:[\\/]|^\//.test(candidate) ? pathToFileURL(candidate).href : candidate;
      const mod = await import(specifier);
      const exported = mod.chromium || mod.default?.chromium;
      if (exported) return exported;
    } catch (error) { lastError = error; }
  }
  throw new Error(
    '无法加载 playwright-core。请任选其一：\n' +
    '  1) 在项目根执行 npm install（会装上 devDependency playwright-core）\n' +
    '  2) 设置环境变量 PLAYWRIGHT_CORE=<playwright-core 入口路径>\n' +
    `最后一次错误：${lastError?.message}`,
  );
}

export function chromeCandidates() {
  const list = [
    process.env.CHROME_PATH,
    process.env.PUPPETEER_EXECUTABLE_PATH,
    // 机器级安装排在前面：它比按用户安装更稳定。
    // 注意 %LOCALAPPDATA% 下可能残留「存在但无法启动」的 Chrome（实测会 spawn UNKNOWN），
    // 所以不能只判断文件存在，必须真的能启动才算数 —— 见下面的逐个回退。
    process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    process.env['PROGRAMFILES(X86)'] && path.join(process.env['PROGRAMFILES(X86)'], 'Google', 'Chrome', 'Application', 'chrome.exe'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
  ];
  return list.filter(Boolean);
}

/** 真实存在的候选（按优先级）。 */
export function existingChromeCandidates() {
  const seen = new Set();
  return chromeCandidates().filter((candidate) => {
    if (seen.has(candidate)) return false;
    seen.add(candidate);
    try { return fs.existsSync(candidate); } catch { return false; }
  });
}

/**
 * 一行拿到浏览器实例。
 * 逐个候选尝试启动，前一个失败就换下一个，最后兜底用 playwright 自带的浏览器 ——
 * 因为「文件存在」不等于「能启动」，只有真的 launch 成功才算数。
 */
export async function launchBrowser(options = {}) {
  const chromium = await loadChromium();
  const attempts = [...existingChromeCandidates(), ''];
  let lastError;
  for (const executablePath of attempts) {
    const launchOptions = { headless: true, ...options };
    if (executablePath) launchOptions.executablePath = executablePath;
    try {
      return await chromium.launch(launchOptions);
    } catch (error) {
      lastError = error;
      if (attempts.length > 1) {
        console.warn(`[harness] 浏览器启动失败，改试下一个候选：${executablePath || '(playwright 自带)'} — ${String(error.message).split('\n')[0]}`);
      }
    }
  }
  throw new Error(`所有浏览器候选都启动失败。最后一次错误：${String(lastError?.message).split('\n')[0]}`);
}
