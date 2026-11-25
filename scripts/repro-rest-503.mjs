// 失败场景验证：light-novels-rest.js 返回 503 时页面表现
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';

const ROOT = path.resolve(import.meta.dirname, '..');
const PORT = 8797;
const CDP_PORT = 9343;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BROWSERS = [
  process.env.CHROME_PATH,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium',
].filter(Boolean);
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png' };

function startServer() {
  const server = http.createServer(async (req, res) => {
    try {
      let p = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
      if (p === '/') p = '/index.html';
      if (p.includes('light-novels-rest.js')) {
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
  throw new Error('no cdp');
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

async function main() {
  const browser = BROWSERS.find((p) => existsSync(p));
  const server = await startServer();
  const profile = path.join(os.tmpdir(), 'ln-fail-' + Date.now());
  let child, ws;
  try {
    child = spawn(browser, ['--headless=new', '--disable-gpu', '--no-first-run', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`, '--window-size=1440,1100', `http://127.0.0.1:${PORT}/`], { stdio: 'ignore' });
    const page = await getPage();
    ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
    const c = cdp(ws);
    await c.send('Runtime.enable'); await c.send('Page.enable');
    await c.send('Network.setCacheDisabled', { cacheDisabled: true });

    // 等首屏 + 让 3s 的 loadRest 跑完并失败
    for (let i = 0; i < 100; i += 1) {
      if (await c.evaluate('(window.LN_DATA||[]).length >= 2026').catch(() => false)) break;
      await sleep(200);
    }
    console.log('首屏:', await c.evaluate('(window.LN_DATA||[]).length'));
    for (let i = 0; i < 80; i += 1) {
      if (await c.evaluate('window.__LN_REST_READY === true || window.__lnRestFailed === true').catch(() => false)) break;
      await sleep(250);
    }
    // 检查是否有失败标记
    const flags = await c.evaluate(`({
      restReady: window.__LN_REST_READY === true,
      fullReady: window.__FULL_DATA_READY === true,
      len: (window.LN_DATA||[]).length,
      hasFailedFlag: typeof window.__lnRestFailed !== 'undefined',
      hint: (document.getElementById('dataHint')||{}).textContent
    })`);
    console.log('失败后状态:', JSON.stringify(flags));

    // 打开含一般小说，再搜索 rest 独有书
    await c.evaluate(`document.getElementById('includeNovelBtn').click()`);
    await sleep(1500);
    await c.evaluate(`(function(){var s=document.getElementById('search');s.value='銃×石';s.dispatchEvent(new Event('input',{bubbles:true}));return true})()`);
    await sleep(900);
    const r = await c.evaluate(`(function(){var e=document.getElementById('empty');return{hidden:e.hidden,text:(e.textContent||'').trim().slice(0,110),count:(document.getElementById('resultCount')||{}).textContent,retryBtn:!!document.getElementById('retryRest')}})()`);
    console.log('失败+含一般小说+搜索:', JSON.stringify(r));
    console.log('→ 是否出现可重试入口:', r.retryBtn ? '✅ 有' : '❌ 无');
    console.log('→ 是否假报「没有找到」:', (!r.hidden && r.text.includes('没有找到')) ? '❌ 是' : '✅ 否');
  } finally {
    try { ws?.close(); } catch {}
    try { child?.kill(); } catch {}
    server.close();
  }
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
