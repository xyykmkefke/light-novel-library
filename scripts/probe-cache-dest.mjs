// 一次性诊断：Cache API 读回来的 Request，destination 到底是什么。
//
// 背景：galgame 的 sw.js 用 `req.destination === 'image'` 判断「这是不是封面」，
// 实测该字段在从缓存读回时恒为 ''（Cache API 只保留 url/method/headers/mode）。
// 轻小说的 sw.js 与 index.html 用的是同一套写法（destination + 正则），
// 需要确认这里是不是同一个结果 —— 若是，那 destination 那一半是死代码，
// 整个判断完全由正则单独承担，正则漏掉哪个域名就会删错东西。
import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = process.cwd();
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json', '.jpg': 'image/jpeg', '.css': 'text/css',
};

function startServer() {
  const server = http.createServer((req, res) => {
    const p = decodeURIComponent(req.url.split('?')[0]);
    const f = path.join(ROOT, p === '/' ? 'index.html' : p);
    fs.readFile(f, (err, buf) => {
      if (err) { res.writeHead(404); res.end('not found'); return; }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' });
      res.end(buf);
    });
  });
  return server;
}

function findBrowser() {
  const cands = [
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  ];
  for (const c of cands) if (fs.existsSync(c)) return c;
  throw new Error('找不到浏览器');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function freePort(base) {
  for (let p = base; p < base + 15; p += 1) {
    const ok = await new Promise((resolve) => {
      const s = http.createServer();
      s.once('error', () => resolve(false));
      s.once('listening', () => s.close(() => resolve(true)));
      s.listen(p, '127.0.0.1');
    });
    if (ok) return p;
  }
  throw new Error('没有空闲端口');
}

async function main() {
  const server = startServer();
  const port = await freePort(8901);
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  const cdpPort = await freePort(9331);

  const profileDir = path.join(os.tmpdir(), 'ln-probe-dest-' + process.pid + '-' + Date.now());
  let child = null;
  let ws = null;
  try {
    child = spawn(findBrowser(), [
      '--headless=new', '--disable-gpu', '--no-first-run', '--disable-extensions',
      '--disable-component-extensions-with-background-pages',
      `--remote-debugging-port=${cdpPort}`,
      `--user-data-dir=${profileDir}`,
      `http://127.0.0.1:${port}/`,
    ], { stdio: 'ignore' });

    let page = null;
    for (let i = 0; i < 80; i += 1) {
      await sleep(250);
      try {
        const res = await fetch(`http://127.0.0.1:${cdpPort}/json`);
        const pages = await res.json();
        page = pages.find((t) => t.type === 'page' && String(t.url).includes(`:${port}`));
        if (page && page.webSocketDebuggerUrl) break;
      } catch {}
    }
    if (!page) throw new Error('连不上调试端口');

    ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });

    let seq = 0;
    const pending = new Map();
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    };
    const send = (method, params = {}) => new Promise((resolve) => {
      seq += 1; pending.set(seq, resolve);
      ws.send(JSON.stringify({ id: seq, method, params }));
    });
    const evaluate = async (expression) => {
      const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      if (r.result?.exceptionDetails) {
        throw new Error(JSON.stringify(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text));
      }
      return r.result?.result?.value;
    };

    await send('Runtime.enable');
    await send('Page.enable');

    for (let i = 0; i < 60; i += 1) {
      const n = await evaluate("document.querySelectorAll('.card').length").catch(() => 0);
      if (n > 0) { console.log('首屏卡片', n); break; }
      await sleep(400);
    }

    const out = await evaluate(`(async () => {
      if (!('caches' in window)) return { noCaches: true };
      const names = await caches.keys();
      const mine = names.filter((k) => k.indexOf('yuc-ln-') === 0);
      if (!mine.length) return { noCacheNames: names };
      const key = mine[0];
      const cache = await caches.open(key);
      // 三条：同源脚本（不该被当封面）、两个真实封面域名
      const probes = [
        ['data/light-novels-lite.js', new Request('data/light-novels-lite.js'), 'same-origin script'],
        ['bgm', new Request('https://bgmimg.anibt.net/r/400/pic/cover/l/b5/a9/715681_x.jpg', { mode: 'no-cors' }), 'bgm cover'],
        ['rn', new Request('https://images.ranobedb.org/x.jpg', { mode: 'no-cors' }), 'ranobedb cover'],
      ];
      for (const [, req] of probes) await cache.put(req, new Response('probe'));
      const keys = await cache.keys();
      const RE = /bgmimg|anibt|ranobedb/;
      const rows = keys
        .filter((r) => /light-novels-lite|anibt|ranobedb/.test(r.url))
        .map((r) => {
          let short = r.url;
          try {
            const u = new URL(r.url);
            short = u.origin === location.origin ? u.pathname : u.host + u.pathname;
          } catch (e) {}
          return {
            url: short.slice(0, 60),
            destination: r.destination,
            mode: r.mode,
            matchedByDest: r.destination === 'image',
            matchedByRegex: RE.test(r.url),
          };
        });
      // 清理，别污染真实缓存
      for (const r of keys) if (/light-novels-lite|anibt|ranobedb/.test(r.url)) await cache.delete(r);
      return { cacheName: key, rows };
    })()`);

    console.log(JSON.stringify(out, null, 2));
  } finally {
    try { ws?.close(); } catch {}
    if (child) {
      try { spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {}
      const tag = path.basename(profileDir);
      try {
        spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
          `Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | Where-Object { $_.CommandLine -like '*${tag}*' } | ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop } catch {} }`,
        ], { stdio: 'ignore' });
      } catch {}
    }
    try { server.close(); } catch {}
    await sleep(800);
    try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch {}
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });