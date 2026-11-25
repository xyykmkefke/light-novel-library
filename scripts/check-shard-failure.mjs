// 分片失败三态回归：extra（详情字段）与 ch（子卷索引）在 503 时的表现
// 独立成脚本的原因：这两个文件在 sw.js 的 SHELL 预缓存列表里，verify 中 SW 已注册，
// 请求走缓存优先，服务端的 503 根本拦不到（rest 不在 SHELL 里，所以能在 verify 内测）。
// 用法：node scripts/check-shard-failure.mjs
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';

const ROOT = path.resolve(import.meta.dirname, '..');
const PORT = 8801;
const CDP_PORT = 9351;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const BROWSERS = [
  process.env.CHROME_PATH,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium',
].filter(Boolean);

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png' };

const fault = { extraFail: 0, chFail: 0 };

function startServer() {
  const server = http.createServer(async (req, res) => {
    try {
      let p = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
      if (p === '/') p = '/index.html';
      // 不提供 sw.js：让页面无法注册 Service Worker，从而走真实网络
      if (p === '/sw.js') {
        res.writeHead(404, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
        res.end('no sw');
        return;
      }
      if (p.includes('light-novels-extra.js') && fault.extraFail > 0) {
        fault.extraFail -= 1;
        res.writeHead(503, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
        res.end('service unavailable');
        return;
      }
      if (p.includes('light-novels-ch.js') && fault.chFail > 0) {
        fault.chFail -= 1;
        res.writeHead(503, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
        res.end('service unavailable');
        return;
      }
      const body = await readFile(path.join(ROOT, p));
      res.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      res.end(body);
    } catch { res.writeHead(404).end('nf'); }
  });
  return new Promise((r) => server.listen(PORT, '127.0.0.1', () => r(server)));
}

async function getPage() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const l = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
      const p = l.find((t) => t.type === 'page');
      if (p) return p;
    } catch {}
    await sleep(200);
  }
  throw new Error('无法连接调试端口');
}

function cdp(ws) {
  let seq = 0; const pending = new Map();
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
  const send = (method, params = {}) => new Promise((res) => { const id = ++seq; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.result?.exceptionDetails) throw new Error(String(r.result.exceptionDetails.exception?.description));
    return r.result?.result?.value;
  };
  return { send, evaluate };
}

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  → ' + detail : ''}`);
}

async function main() {
  const browser = BROWSERS.find((p) => existsSync(p));
  if (!browser) throw new Error('未找到 Edge/Chrome');
  const server = await startServer();
  const profile = path.join(os.tmpdir(), 'ln-shard-fail-' + Date.now());
  let child, ws;
  try {
    child = spawn(browser, ['--headless=new', '--disable-gpu', '--no-first-run',
      ...(process.platform === 'linux' ? ['--no-sandbox', '--disable-dev-shm-usage'] : []),
      `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`, '--window-size=1440,1100', `http://127.0.0.1:${PORT}/`], { stdio: 'ignore' });
    const page = await getPage();
    ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
    const c = cdp(ws);
    await c.send('Runtime.enable'); await c.send('Page.enable');
    await c.send('Network.setCacheDisabled', { cacheDisabled: true });

    for (let i = 0; i < 100; i += 1) {
      if (await c.evaluate('(window.LN_DATA||[]).length >= 2026').catch(() => false)) break;
      await sleep(200);
    }
    // 确认 SW 未接管，否则测试无效
    const swState = await c.evaluate('!!navigator.serviceWorker && navigator.serviceWorker.controller !== null');
    check('测试环境未启用 Service Worker（否则缓存会绕过故障）', swState === false, `controller=${swState}`);

    // ---- extra 失败 ----
    fault.extraFail = 999;
    const idWithAu = await c.evaluate(`(() => {
      const x = (window.LN_DATA || []).find(v => !v.gn && !v.c && !v.ver && v.i);
      return x ? String(x.i) : '';
    })()`);
    await c.evaluate(`location.hash = 'd=' + ${JSON.stringify(idWithAu)}`);
    for (let i = 0; i < 40; i += 1) {
      if (await c.evaluate('window.__lnExtraFailed === true').catch(() => false)) break;
      await sleep(150);
    }
    await sleep(400);
    const extraFail = await c.evaluate(`(() => {
      const m = document.getElementById('detailMeta');
      const t = (m ? m.textContent : '').replace(/\\s+/g, ' ').trim();
      return { open: !document.getElementById('modal').hidden, text: t,
               retry: !!document.querySelector('[data-retry-extra]') };
    })()`);
    check('extra 失败时详情提示「字段加载失败」',
      extraFail.open && /字段加载失败/.test(extraFail.text),
      JSON.stringify(extraFail.text.slice(0, 44)));
    check('extra 失败时提供重试入口', extraFail.retry === true);

    // ---- extra 重试成功 ----
    fault.extraFail = 0;
    await c.evaluate(`(() => { const b = document.querySelector('[data-retry-extra]'); if (b) b.click(); })()`);
    for (let i = 0; i < 60; i += 1) {
      if (await c.evaluate('window.__LN_EXTRA_READY === true').catch(() => false)) break;
      await sleep(150);
    }
    await sleep(400);
    const extraOk = await c.evaluate(`(() => {
      const m = document.getElementById('detailMeta');
      const t = (m ? m.textContent : '').replace(/\\s+/g, ' ').trim();
      return { text: t, hasFail: /字段加载失败/.test(t), hasAuthor: /作者/.test(t) };
    })()`);
    check('extra 重试后作者补上且失败提示消失',
      extraOk.hasFail === false && extraOk.hasAuthor,
      JSON.stringify(extraOk.text.slice(0, 44)));

    // ---- ch 失败 ----
    fault.chFail = 999;
    const seriesId = await c.evaluate(`(() => {
      const s = (window.LN_DATA || []).find(x => x.sv && !Array.isArray(x.ch) && x.i);
      return s ? String(s.i) : '';
    })()`);
    await c.evaluate(`location.hash = ''`);
    await sleep(200);
    await c.evaluate(`location.hash = 'd=' + ${JSON.stringify(seriesId)}`);
    for (let i = 0; i < 40; i += 1) {
      if (await c.evaluate('window.__lnChFailed === true').catch(() => false)) break;
      await sleep(150);
    }
    await sleep(400);
    const chFail = await c.evaluate(`(() => {
      const b = document.getElementById('detailVolumes');
      const t = (b ? b.textContent : '').replace(/\\s+/g, ' ').trim();
      return { text: t, retry: !!document.querySelector('[data-retry-ch]') };
    })()`);
    check('ch 失败时卷清单提示「卷清单加载失败」',
      /卷清单加载失败/.test(chFail.text), JSON.stringify(chFail.text.slice(0, 44)));
    check('ch 失败时提供重试入口', chFail.retry === true);

    // ---- 防死循环：失败后不得反复请求 ----
    const before = await c.evaluate(`document.querySelectorAll('script[src*="light-novels-ch"]').length`);
    await sleep(1500);
    const after = await c.evaluate(`document.querySelectorAll('script[src*="light-novels-ch"]').length`);
    check('分片失败后不自动重复请求（防死循环）', before === after, `${before} → ${after}`);

    // ---- ch 重试成功 ----
    fault.chFail = 0;
    await c.evaluate(`(() => { const b = document.querySelector('[data-retry-ch]'); if (b) b.click(); })()`);
    for (let i = 0; i < 60; i += 1) {
      if (await c.evaluate('window.__LN_CH_READY === true').catch(() => false)) break;
      await sleep(150);
    }
    await sleep(400);
    const chOk = await c.evaluate(`(() => {
      const b = document.getElementById('detailVolumes');
      const t = (b ? b.textContent : '').replace(/\\s+/g, ' ').trim();
      return { text: t, hasFail: /卷清单加载失败/.test(t) };
    })()`);
    check('ch 重试后卷清单恢复且失败提示消失', chOk.hasFail === false, JSON.stringify(chOk.text.slice(0, 44)));
  } finally {
    try { ws?.close(); } catch {}
    try { child?.kill(); } catch {}
    server.close();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} 通过`);
  if (failed.length) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
