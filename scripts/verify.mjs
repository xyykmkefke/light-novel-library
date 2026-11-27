// 自动化验收：启动本地静态服务 + Edge 无头浏览器，通过 CDP 跑核心交互检查
// 用法：node scripts/verify.mjs [--keep]
// 退出码 0 表示全部通过，1 表示存在失败项

import http from 'node:http';
import net from 'node:net';
import { readFile, rm, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';

const ROOT = path.resolve(import.meta.dirname, '..');
const PKG_VERSION = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8')).version;
// 端口可被环境变量覆盖，也允许自动顺延。
// 起因：本次调试中上一个实例被强杀后，8791 的监听句柄挂在 OwningProcess=0 上不释放
// （Windows 上强杀进程常见的残留），后续每次运行都在 listen 阶段直接 EADDRINUSE，
// 而这时浏览器根本还没启动，报错看起来像「验收挂了」，实际一行断言都没跑。
// 与其让人手工等端口，不如自己找一个能用的。
const BASE_PORT = Number(process.env.LN_VERIFY_PORT) || 8791;
const BASE_CDP_PORT = Number(process.env.LN_VERIFY_CDP_PORT) || 9337;
let PORT = BASE_PORT;
let CDP_PORT = BASE_CDP_PORT;
const KEEP = process.argv.includes('--keep');
const SHOT_DIR = path.join(ROOT, 'screenshots');

// 浏览器候选：优先级 CHROME_PATH 环境变量 > Windows Edge/Chrome > Linux Chrome/Chromium
// CI（ubuntu-latest）通过 CHROME_PATH 指向 actions/setup-chrome 安装的浏览器
const EDGE_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium-browser',
  '/usr/bin/chromium',
].filter(Boolean);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function findBrowser() {
  const found = EDGE_CANDIDATES.find((p) => existsSync(p));
  if (!found) throw new Error('未找到 Edge/Chrome，可执行文件不存在');
  return found;
}

// 测试钩子：模拟分片慢网与失败，用于验证加载期文案与重试
// （extra / ch 的失败三态由 scripts/check-shard-failure.mjs 单独测：它们在 SW 预缓存里，
//   verify 跑到这里 SW 已接管，缓存优先会绕过服务端故障）
const fault = { restDelay: 0, restFail: 0 };

function startServer() {
  const server = http.createServer(async (req, res) => {
    try {
      let pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
      if (pathname === '/') pathname = '/index.html';
      const file = path.join(ROOT, pathname);
      const rel = path.relative(ROOT, file);
      if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('forbidden');
      if (pathname.includes('light-novels-rest.js')) {
        if (fault.restFail > 0) {
          fault.restFail -= 1;
          res.writeHead(503, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
          res.end('service unavailable');
          return;
        }
        if (fault.restDelay > 0) await sleep(fault.restDelay);
      }
      const data = await readFile(file);
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
        'Cache-Control': 'no-store',
      });
      res.end(data);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
    }
  });
  // 不在这里 listen：端口可能在调用时才确定（见 listenWithFallback）
  return server;
}

// 找一个能监听的端口：默认用 BASE_PORT，被占用就向后顺延几个。
// 端口进不了页面（页面走相对路径），换端口不影响任何断言。
async function listenWithFallback(server) {
  for (let i = 0; i < 12; i += 1) {
    const port = BASE_PORT + i;
    const ok = await new Promise((resolve) => {
      const onErr = (e) => { server.removeListener('listening', onOk); resolve(e.code !== 'EADDRINUSE'); };
      const onOk = () => { server.removeListener('error', onErr); resolve(true); };
      server.once('error', onErr);
      server.once('listening', onOk);
      server.listen(port, '127.0.0.1');
    });
    if (ok && server.listening) { PORT = port; return port; }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`端口 ${BASE_PORT}~${BASE_PORT + 11} 都被占用，无法启动静态服务`);
}

// CDP 端口同理：浏览器绑定失败时只会静默退出，表现为「无法连接到浏览器调试端口」，
// 与真正的浏览器崩溃难以区分。先探一个闲置端口再用。
async function pickFreePort(base) {
  for (let i = 0; i < 12; i += 1) {
    const port = base + i;
    const free = await new Promise((resolve) => {
      const probe = net.createServer();
      probe.once('error', () => resolve(false));
      probe.once('listening', () => probe.close(() => resolve(true)));
      probe.listen(port, '127.0.0.1');
    });
    if (free) return port;
  }
  throw new Error(`CDP 端口 ${base}~${base + 11} 都被占用`);
}

async function getDebugPage() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json`);
      const pages = await res.json();
      const page = pages.find((t) => t.type === 'page' && String(t.url).includes(`:${PORT}`));
      if (page && page.webSocketDebuggerUrl) return page;
    } catch {}
    await sleep(250);
  }
  throw new Error('无法连接到浏览器调试端口');
}

function createCdp(ws) {
  let seq = 0;
  const pending = new Map();
  const events = [];

  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
      return;
    }
    if (msg.method) events.push(msg);
  };

  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const id = ++seq;
      pending.set(id, resolve);
      ws.send(JSON.stringify({ id, method, params }));
    });

  const evaluate = async (expression) => {
    const res = await send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (res.result?.exceptionDetails) {
      throw new Error('页面脚本异常：' + JSON.stringify(res.result.exceptionDetails.exception?.description || res.result.exceptionDetails.text));
    }
    return res.result?.result?.value;
  };

  return { send, evaluate, events };
}

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: detail === undefined ? '' : detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  → ' + detail : ''}`);
}

async function main() {
  const browser = findBrowser();
  const profile = path.join(os.tmpdir(), 'ln-verify-profile');
  // profile 被上一个残留浏览器锁住时 rm 会抛 EBUSY，而那与本次运行无关：
  // 换一个带时间戳的独立 profile，比在这里失败更符合「验收要能跑完」的目的。
  let profileDir = profile;
  try {
    await rm(profile, { recursive: true, force: true });
  } catch {
    profileDir = `${profile}-${Date.now()}`;
    console.log('提示：默认 profile 被占用，改用独立 profile');
  }
  await mkdir(SHOT_DIR, { recursive: true });

  const server = await startServer();
  const port = await listenWithFallback(server);
  if (port !== BASE_PORT) console.log(`提示：端口 ${BASE_PORT} 被占用，改用 ${port}`);
  CDP_PORT = await pickFreePort(BASE_CDP_PORT);
  if (CDP_PORT !== BASE_CDP_PORT) console.log(`提示：CDP 端口 ${BASE_CDP_PORT} 被占用，改用 ${CDP_PORT}`);
  let child = null;
  let ws = null;

  try {
    child = spawn(
      browser,
      [
        '--headless=new',
        '--disable-gpu',
        '--hide-scrollbars',
        '--no-first-run',
        // 扩展必须禁用：即便用全新 profile，Windows 上的 Edge 仍会加载内置组件扩展，
        // 它们注入的 content script 会抛「listener indicated an asynchronous response …
        // message channel closed」，被「无 JS 异常」误判成页面缺陷。
        // 实测 2026-11-27：未加参数时该断言报 3 条此错误，加了即通过。
        // 番剧（../番剧/scripts/verify.mjs）与 galgame 两份脚本都踩过同一个坑。
        '--disable-extensions',
        '--disable-component-extensions-with-background-pages',
        ...(process.platform === 'linux' ? ['--no-sandbox', '--disable-dev-shm-usage'] : []),
        `--remote-debugging-port=${CDP_PORT}`,
        `--user-data-dir=${profileDir}`,
        '--window-size=1440,1100',
        `http://127.0.0.1:${PORT}/`,
      ],
      { stdio: 'ignore' },
    );

    const page = await getDebugPage();
    ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = reject;
    });

    const cdp = createCdp(ws);
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');

    const sendRaw = cdp.send;
    cdp.send = async (method, params = {}) => {
      const res = await sendRaw(method, params);
      if (method === 'Page.reload') {
        for (let i = 0; i < 80; i += 1) {
          try {
            if (await cdp.evaluate('window.__FULL_DATA_READY === true')) break;
          } catch {}
          await sleep(100);
        }
        await sleep(300);
      }
      return res;
    };

    const reload = async () => {
      await cdp.send('Page.reload', { ignoreCache: true });
      for (let i = 0; i < 60; i += 1) {
        const n = await cdp.evaluate("document.querySelectorAll('.card').length").catch(() => 0);
        if (n > 0) return;
        await sleep(150);
      }
    };

    // 等某条目的作者字段真正到位，返回是否等到。
    // 只检查 window.__LN_EXTRA_READY 不够：该标志为真不代表目标条目的 au 已经落到数据上。
    // 实测偶发「标志已真但 item.au 仍为空」，随后「恢复上游清除覆盖与别名」拿 '' 去比
    // 页面加载时记下的 editPick.au 就 FAIL，详情区同时显示「字段加载中…」。
    // 这是前置条件问题，不是被测功能的问题，必须等真实数据而不是等标志。
    const waitAuthor = async (id, tries = 120) => {
      for (let i = 0; i < tries; i += 1) {
        const ok = await cdp.evaluate(`(() => {
          if (window.__LN_EXTRA_READY !== true) return false;
          const x = (window.LN_DATA || []).find((v) => String(v.i) === ${JSON.stringify(id)});
          return !!x && !!String(x.au || '');
        })()`).catch(() => false);
        if (ok) return true;
        await sleep(150);
      }
      return false;
    };

    // 清掉 Service Worker 与缓存：data 走缓存优先，不清掉则服务端的延迟 / 503 模拟不到
    const clearShellGlobal = async () => {
      await cdp.evaluate(`(async () => {
        const regs = await navigator.serviceWorker.getRegistrations();
        await Promise.all(regs.map((r) => r.unregister()));
        const keys = await caches.keys();
        await Promise.all(keys.map((k) => caches.delete(k)));
        return true;
      })()`).catch(() => {});
    };

    // 只等首屏就绪、不等后续分片（后续分片正是要观察的窗口）
    const reloadToLiteGlobal = async () => {
      await sendRaw('Page.reload', { ignoreCache: true });
      for (let i = 0; i < 100; i += 1) {
        const ok = await cdp.evaluate('window.__LN_LITE_READY === true').catch(() => false);
        if (ok) return;
        await sleep(100);
      }
    };

    const setSearch = async (q) => {
      await cdp.evaluate(`(() => {
        const el = document.getElementById('search');
        el.value = ${JSON.stringify(q)};
        el.dispatchEvent(new Event('input', { bubbles: true }));
      })()`);
      await sleep(350);
    };

    const click = async (selector) => {
      const ok = await cdp.evaluate(`(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return false;
        el.click();
        return true;
      })()`);
      await sleep(250);
      return ok;
    };

    const count = (selector) =>
      cdp.evaluate(`document.querySelectorAll(${JSON.stringify(selector)}).length`);

    // 等待首屏渲染
    let cards = 0;
    for (let i = 0; i < 80; i += 1) {
      cards = await cdp.evaluate("document.querySelectorAll('.card').length").catch(() => 0);
      if (cards > 0) break;
      await sleep(250);
    }

    // ---- 基础与数据 ----
    check('页面渲染出书目卡片', cards > 0, `${cards} 张`);
    const liteCore = await cdp.evaluate(`(() => ({
      ready: window.__LN_LITE_READY === true,
      data: (window.LN_DATA || []).length,
      full: window.__FULL_DATA_READY === true,
      restReady: window.__LN_REST_READY === true,
      restScript: !!document.querySelector('script[src*="light-novels-rest"]'),
      chScript: !!document.querySelector('script[src*="light-novels-ch"]'),
      metaCount: Number((window.LN_META || {}).count) || 0,
    }))()`);
    check('首屏加载轻量核心',
      liteCore.ready === true && liteCore.data > 1500 && liteCore.data < 2500,
      `${liteCore.data} 条`);
    check('首屏未加载剩余核心与子卷索引',
      liteCore.full === false && liteCore.restReady === false && liteCore.restScript === false &&
      liteCore.chScript === false,
      JSON.stringify(liteCore));
    const restCore = await cdp.evaluate(`(async () => {
      await window.__lnLoadRest();
      return {
        ready: window.__LN_REST_READY === true,
        count: window.__LN_REST_COUNT,
        total: (window.LN_DATA || []).length,
        full: window.__FULL_DATA_READY === true,
        metaCount: Number((window.LN_META || {}).count) || 0,
      };
    })()`);
    check('剩余核心按需加载',
      restCore.ready === true && restCore.total === restCore.metaCount &&
      restCore.count === restCore.metaCount - liteCore.data && restCore.full === true,
      JSON.stringify(restCore));
    check('全库数据已就绪', restCore.full === true);
    const perf = await cdp.evaluate(`(() => {
      const n = performance.getEntriesByType('navigation')[0] || {};
      return {
        dcl: Math.round(n.domContentLoadedEventEnd || 0),
        paint: Math.round((performance.getEntriesByName('first-contentful-paint')[0] || {}).startTime || 0),
      };
    })()`);
    check('首屏脚本解析在 4 秒内', perf.dcl > 0 && perf.dcl < 4000, `DCL ${perf.dcl}ms / FCP ${perf.paint}ms`);

    // 详情字段拆包：首屏不应下载，按需加载后才合并进数据
    const lazyExtra = await cdp.evaluate(`(() => ({
      ready: window.__LN_EXTRA_READY === true,
      script: !!document.querySelector('script[src*="light-novels-extra"]'),
      coreHasAuthor: (window.LN_DATA || []).some((x) => x.au),
    }))()`);
    check('首屏未加载详情包',
      lazyExtra.ready === false && lazyExtra.script === false && lazyExtra.coreHasAuthor === false,
      JSON.stringify(lazyExtra));
    const extraReady = await cdp.evaluate(`(async () => {
      await window.__lnLoadExtra();
      return window.__LN_EXTRA_READY === true && (window.LN_DATA || []).some((x) => x.au);
    })()`);
    check('详情包按需加载并合并', extraReady === true);

    // 系列新卷：首屏不下载；展开子卷或一键加入时才合并
    const lazyVolumes = await cdp.evaluate(`(() => ({
      ready: window.__LN_VOLUMES_READY === true,
      script: !!document.querySelector('script[src*="light-novels-volumes"]'),
      total: (window.LN_DATA || []).length,
      metaVolumes: Number((window.LN_META || {}).volumes) || 0,
    }))()`);
    check('首屏未加载卷包',
      lazyVolumes.ready === false && lazyVolumes.script === false && lazyVolumes.metaVolumes > 7000,
      JSON.stringify(lazyVolumes));
    const volumeReady = await cdp.evaluate(`(async () => {
      await window.__lnLoadVolumes();
      const d = window.LN_DATA || [];
      const all = new Map(d.map((x) => [String(x.i), x]));
      const bad = d.reduce((n, x) => n + (Array.isArray(x.ch)
        ? x.ch.filter((cid) => !all.get(String(cid))?.c).length : 0), 0);
      return {
        ready: window.__LN_VOLUMES_READY === true,
        count: window.__LN_VOLUME_COUNT,
        total: d.length,
        metaVolumes: Number((window.LN_META || {}).volumes) || 0,
        bad,
      };
    })()`);
    check('卷包按需加载并合并',
      volumeReady.ready === true && volumeReady.count === volumeReady.metaVolumes &&
      volumeReady.total === lazyVolumes.total + volumeReady.metaVolumes && volumeReady.bad === 0,
      JSON.stringify(volumeReady));
    await reload();
    await cdp.evaluate('window.__lnLoadRest()');
    await cdp.evaluate('window.__lnLoadVolumes()');
    await cdp.evaluate('window.__lnLoadExtra()');
    await cdp.evaluate('window.__lnLoadCh()');

    const stats = await cdp.evaluate(`(() => {
      // 统计只看核心包，排除按需加载的卷包
      const volumeIds = new Set((window.LN_VOLUMES || []).map((v) => String(v.i)));
      const d = (window.LN_DATA || []).filter((x) => !volumeIds.has(String(x.i)));
      return {
        total: d.length,
        volumes: Number((window.LN_META || {}).volumes) || 0,
        general: d.filter((x) => x.gn).length,
        versions: d.filter((x) => x.ver).length,
        defaultVisible: d.filter((x) => !x.c && !x.gn && !x.ver && !x.ver).length,
        meta: window.LN_META || null,
        c: d.filter((x) => x.c).length,
        chsSeries: d.filter((x) => x.chs).length,
        series: d.filter((x) => x.sv).length,
        kind: d.reduce((m, x) => { if (x.kind) m[x.kind] = (m[x.kind] || 0) + 1; return m; }, {}),
        py: d.filter((x) => x.py).length,
        au: d.filter((x) => x.au).length,
        il: d.filter((x) => x.il).length,
        pub: d.filter((x) => x.pub).length,
        line: d.filter((x) => x.line).length,
        isbn: d.filter((x) => x.isbn).length,
        fisbn: d.filter((x) => x.fisbn).length,
        jd: d.filter((x) => x.jd).length,
        tg: d.filter((x) => (x.tg || []).length).length,
        rt: d.filter((x) => 'rt' in x).length,
        noDate: d.filter((x) => !x.d).length,
        zeroVol: d.filter((x) => !x.v).length,
        chSeries: d.filter((x) => Array.isArray(x.ch)).length,
        chRefs: d.reduce((n, x) => n + (Array.isArray(x.ch) ? x.ch.length : 0), 0),
        chBad: d.reduce((n, x) => {
          if (!Array.isArray(x.ch)) return n;
          const byId = new Map(d.map((v) => [String(v.i), v]));
          return n + x.ch.filter((cid) => !byId.get(String(cid))?.c).length;
        }, 0),
      };
    })()`);
    check('条目数不少于 3900', stats.total >= 3900, `${stats.total} 条`);
    check('系列子卷已标记', stats.c > 1500, `${stats.c} 条子卷 / ${stats.series} 系列`);
    check('拼音字段覆盖 99% 以上', stats.py / stats.total > 0.99, `${stats.py}/${stats.total}`);
    check('作者字段已抽取', stats.au > 3000, `${stats.au} 条`);
    check('插图字段已抽取', stats.il > 2500, `${stats.il} 条`);
    check('出版社字段已抽取', stats.pub > 3000, `${stats.pub} 条`);
    check('书系字段已抽取', stats.line > 1500, `${stats.line} 条`);
    check('ISBN 字段已抽取', stats.isbn > 3000, `${stats.isbn} 条`);
    check('系列首卷 ISBN 已补充', stats.fisbn > 150, `${stats.fisbn} 条`);
    check('日文版发售日已抽取', stats.jd > 2500, `${stats.jd} 条`);
    check('题材覆盖超过 70%', stats.tg / stats.total > 0.7, `${stats.tg} 条`);
    check('最终数据不含 rt 字段', stats.rt === 0);
    check('漫画/画集/指南标记存在',
      (stats.kind.manga || 0) > 0 && (stats.kind.artbook || 0) > 0,
      JSON.stringify(stats.kind));
    check('系列子卷索引完整',
      stats.chSeries > 300 && stats.chRefs === stats.c + stats.volumes,
      `${stats.chSeries} 系列 / ${stats.chRefs} 引用（核心 ${stats.c} + 卷包 ${stats.volumes}）`);
    check('拆分卷按故事卷统计',
      stats.chsSeries > 20 && stats.meta &&
      Number(stats.meta.storyVolumes) < Number(stats.meta.physicalVolumes),
      `${stats.chsSeries} 个系列 / ${stats.meta && stats.meta.physicalVolumes} 册 → ${stats.meta && stats.meta.storyVolumes} 故事卷`);

    // ---- 默认筛选 ----
    const visibleDefault = await cdp.evaluate(`(() => Number(document.getElementById('resultCount').textContent))()`);
    const expectedDefault = await cdp.evaluate(`(() => (window.LN_DATA || []).filter((x) => !x.c && !x.gn && !x.ver && !x.ver).length)()`);
    check('默认隐藏系列子卷', visibleDefault === expectedDefault, `${visibleDefault} / ${expectedDefault}`);
    check('一般小说已合并入库',
      stats.general > 700 && stats.meta && stats.meta.general === stats.general,
      `${stats.general} 本 / META ${stats.meta && stats.meta.general}`);
    check('默认不含一般小说',
      visibleDefault === stats.defaultVisible,
      `${visibleDefault} / ${stats.defaultVisible}`);
    check('含一般小说后结果增加', await (async () => {
      await click('#includeNovelBtn');
      const n = await cdp.evaluate(`(() => Number(document.getElementById('resultCount').textContent))()`);
      const pressed = await cdp.evaluate("document.getElementById('includeNovelBtn').getAttribute('aria-pressed')");
      await click('#includeNovelBtn');
      return n === stats.total - stats.c - stats.versions && pressed === 'true';
    })(), `全部 ${stats.total - stats.c - stats.versions}`);
    check('默认筛选按钮显示已隐藏子卷',
      (await cdp.evaluate("document.getElementById('hideChildrenBtn').getAttribute('aria-pressed')")) === 'true');
    check('年份条溢出时显示滚动提示',
      (await cdp.evaluate(`(() => {
        const el = document.getElementById('years');
        return el.scrollWidth > el.clientWidth && el.classList.contains('has-more');
      })()`)) === true);

    // 初始状态截图（此时没有提示条等临时元素）
    // 等前几张封面加载完，避免截图里全是占位色块
    await cdp.evaluate(`(async () => {
      const imgs = [...document.querySelectorAll('.card img')].slice(0, 6);
      await Promise.all(imgs.map((img) => img.complete ? Promise.resolve() : new Promise((resolve) => {
        img.addEventListener('load', resolve, { once: true });
        img.addEventListener('error', resolve, { once: true });
        setTimeout(resolve, 4000);
      })));
    })()`);
    await sleep(300);
    const shotDesktop = await cdp.send('Page.captureScreenshot', { format: 'png' });
    if (shotDesktop.result?.data) {
      await writeFile(path.join(SHOT_DIR, 'desktop.png'), Buffer.from(shotDesktop.result.data, 'base64'));
    }

    const showChildren = await (async () => {
      await cdp.evaluate('window.__lnLoadVolumes()');
      await click('#hideChildrenBtn');
      const debug = await cdp.evaluate(`(() => {
        const d = window.LN_DATA || [];
        return {
          n: Number(document.getElementById('resultCount').textContent),
          expected: d.filter((x) => !x.gn && !x.ver).length,
          total: d.length,
          gn: d.filter((x) => x.gn).length,
          ver: d.filter((x) => x.ver).length,
          both: d.filter((x) => x.gn && x.ver).length,
          hc: document.getElementById('hideChildrenBtn').getAttribute('aria-pressed'),
          dup: document.getElementById('showVersionsBtn').getAttribute('aria-pressed'),
        };
      })()`);
      await click('#hideChildrenBtn');
      return debug;
    })();
    check('显示系列子卷后总数增加', showChildren.n === showChildren.expected,
      JSON.stringify(showChildren));

    check('重复版本默认隐藏且可切换', await (async () => {
      const before = await cdp.evaluate(`(() => Number(document.getElementById('resultCount').textContent))()`);
      await click('#showVersionsBtn');
      const after = await cdp.evaluate(`(() => Number(document.getElementById('resultCount').textContent))()`);
      const expected = await cdp.evaluate(`(() =>
        (window.LN_DATA || []).filter((x) => !x.c && !x.gn).length)()`);
      const pressed = await cdp.evaluate("document.getElementById('showVersionsBtn').getAttribute('aria-pressed')");
      await click('#showVersionsBtn');
      return stats.versions > 50 && before === stats.defaultVisible &&
        after === expected && pressed === 'true';
    })(), `版本 ${stats.versions} 个`);

    // ---- 年份 ----
    const year = await cdp.evaluate(`(() => {
      const d = (window.LN_DATA || []).filter((x) => !x.c && !x.gn && !x.ver && x.d);
      const y = String(d[0].d).slice(0, 4);
      return { y, n: d.filter((x) => String(x.d).slice(0, 4) === y).length };
    })()`);
    await click(`[data-year="${year.y}"]`);
    const yearCount = await cdp.evaluate(`(() => Number(document.getElementById('resultCount').textContent))()`);
    check('按年份筛选结果一致', yearCount === year.n, `${year.y}: ${yearCount}/${year.n}`);
    await click('[data-year="all"]');

    // ---- 题材 ----
    const genre = await cdp.evaluate(`(() => {
      const opt = [...document.querySelectorAll('#genre option')].find((o) => o.value !== 'all');
      const id = opt.value;
      const n = (window.LN_DATA || []).filter((x) => !x.c && !x.gn && !x.ver && (x.tg || []).includes(id)).length;
      return { id, n };
    })()`);
    await cdp.evaluate(`(() => {
      const el = document.getElementById('genre');
      el.value = ${JSON.stringify(genre.id)};
      el.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await sleep(250);
    const genreCount = await cdp.evaluate(`(() => Number(document.getElementById('resultCount').textContent))()`);
    check('按题材筛选结果一致', genreCount === genre.n, `${genre.id}: ${genreCount}/${genre.n}`);
    await click('#clearFiltersBtn');

    // ---- 书系 ----
    const lineFilter = await cdp.evaluate(`(async () => {
      const sel = document.getElementById('lineFilter');
      sel.dispatchEvent(new Event('focus'));
      for (let i = 0; i < 30 && sel.options.length < 3; i += 1) {
        await new Promise((r) => setTimeout(r, 150));
      }
      const opts = [...sel.options].filter((o) => o.value !== 'all');
      if (!opts.length) return { ok: false, options: 0 };
      const value = opts[0].value;
      const expected = (window.LN_DATA || []).filter((x) => !x.c && !x.gn && !x.ver && String(x.line || '').trim() === value).length;
      sel.value = value;
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 350));
      return {
        ok: true,
        options: opts.length,
        value,
        count: Number(document.getElementById('resultCount').textContent),
        expected,
      };
    })()`);
    check('书系筛选可用且结果一致',
      lineFilter.ok === true && lineFilter.options >= 5 && lineFilter.count === lineFilter.expected,
      JSON.stringify(lineFilter));
    await click('#clearFiltersBtn');

    // ---- 类型 ----
    await cdp.evaluate(`(() => {
      const el = document.getElementById('kind');
      el.value = 'manga';
      el.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await sleep(250);
    const mangaCount = await cdp.evaluate(`(() => Number(document.getElementById('resultCount').textContent))()`);
    check('按类型筛选漫画', mangaCount === await cdp.evaluate(`(() => (window.LN_DATA || []).filter((x) => x.kind === 'manga' && !x.c && !x.gn && !x.ver).length)()`), `${mangaCount} 本`);
    await click('#clearFiltersBtn');

    // ---- 搜索 ----
    const sample = await cdp.evaluate(`(() => {
      const x = (window.LN_DATA || []).find((v) => v.cn && !v.c && !v.gn && !v.ver);
      return { id: x.i, cn: x.cn };
    })()`);
    await setSearch(sample.cn.slice(0, 2));
    const searchCount = await cdp.evaluate(`(() => Number(document.getElementById('resultCount').textContent))()`);
    check('中文搜索有结果', searchCount > 0, `${sample.cn.slice(0, 2)} → ${searchCount}`);
    check('标题关键词高亮', (await count('.title mark')) > 0);
    await setSearch(`${sample.cn.slice(0, 2)} -${sample.cn.slice(-2)}`);
    const excludeCount = await cdp.evaluate(`(() => Number(document.getElementById('resultCount').textContent))()`);
    check('排除词缩小结果', excludeCount <= searchCount, `${searchCount} → ${excludeCount}`);
    await setSearch('');
    const py = await cdp.evaluate(`(() => (window.LN_DATA || []).find((x) => x.py && x.py.length > 2 && !x.c && !x.gn && !x.ver).py)()`);
    await setSearch(py);
    check('拼音首字母搜索有结果',
      (await cdp.evaluate(`(() => Number(document.getElementById('resultCount').textContent))()`)) > 0, py);
    await setSearch('');
    const kanaPy = await cdp.evaluate(`(() => (window.LN_DATA || []).find((x) => /^[\\u3040-\\u30ff]/.test(x.n || '') && x.py && x.py.length > 4 && !x.c && !x.gn && !x.ver).py)()`);
    await setSearch(kanaPy);
    check('纯日文标题可用罗马字首字母搜索',
      (await cdp.evaluate(`(() => Number(document.getElementById('resultCount').textContent))()`)) > 0, kanaPy);
    await setSearch('');

    // ---- 高级搜索语法 ----
    await setSearch('分:>=9');
    const scoreExprCount = await cdp.evaluate(`(() => Number(document.getElementById('resultCount').textContent))()`);
    const scoreExprExpected = await cdp.evaluate(`(() => window.LN_DATA.filter((x) => !x.c && !x.gn && !x.ver && x.s != null && x.s >= 9).length)()`);
    check('分:>=9 搜索生效', scoreExprCount === scoreExprExpected, `${scoreExprCount}/${scoreExprExpected}`);
    check('分: 语法不参与标题高亮', (await count('.title mark')) === 0);

    await setSearch('题材:奇幻');
    const genreExprCount = await cdp.evaluate(`(() => Number(document.getElementById('resultCount').textContent))()`);
    const genreExprExpected = await cdp.evaluate(`(() => window.LN_DATA.filter((x) => !x.c && !x.gn && !x.ver && (x.tg || []).includes('fan')).length)()`);
    check('题材:奇幻 搜索生效', genreExprCount === genreExprExpected, `${genreExprCount}/${genreExprExpected}`);

    await setSearch('年:2020');
    const yearExprCount = await cdp.evaluate(`(() => Number(document.getElementById('resultCount').textContent))()`);
    const yearExprExpected = await cdp.evaluate(`(() => window.LN_DATA.filter((x) => !x.c && !x.gn && !x.ver && String(x.d || '').startsWith('2020')).length)()`);
    check('年:2020 搜索生效', yearExprCount === yearExprExpected, `${yearExprCount}/${yearExprExpected}`);

    await cdp.evaluate('window.__lnLoadExtra()');
    const authorName = await cdp.evaluate(`(() => {
      const x = window.LN_DATA.find((v) => v.au && !v.c && !v.gn && !v.ver);
      return String(x.au).split(/[\\/、,，&]/)[0].trim();
    })()`);
    await setSearch('作者:' + authorName);
    check('作者: 搜索有结果',
      (await cdp.evaluate(`(() => Number(document.getElementById('resultCount').textContent))()`)) > 0, authorName);

    await setSearch('出版社:KADOKAWA');
    const pubExprCount = await cdp.evaluate(`(() => Number(document.getElementById('resultCount').textContent))()`);
    const pubExprExpected = await cdp.evaluate(`(() => window.LN_DATA.filter((x) => !x.c && !x.gn && !x.ver && String(x.pub || '').toLowerCase().includes('kadokawa')).length)()`);
    check('出版社: 搜索生效', pubExprCount === pubExprExpected, `${pubExprCount}/${pubExprExpected}`);

    await setSearch('书系:電撃文庫');
    const lineExprCount = await cdp.evaluate(`(() => Number(document.getElementById('resultCount').textContent))()`);
    const lineExprExpected = await cdp.evaluate(`(() => window.LN_DATA.filter((x) => !x.c && !x.gn && !x.ver && String(x.line || '').includes('電撃文庫')).length)()`);
    check('书系: 搜索生效', lineExprCount === lineExprExpected, `${lineExprCount}/${lineExprExpected}`);

    await setSearch('分:>=8 题材:恋爱');
    check('字段与关键词可组合',
      (await cdp.evaluate(`(() => Number(document.getElementById('resultCount').textContent))()`)) > 0);
    await setSearch('');
    await cdp.evaluate(`(() => { location.hash = ''; })()`);

    // ---- 多语言 / 多写法搜索：同一本书无论按哪种写法都要能搜到 ----
    // 五项能力：全角折半、繁转简、全拼命中、罗马字命中、作者独立索引
    const normReady = await (async () => {
      for (let i = 0; i < 60; i += 1) {
        const ok = await cdp.evaluate('window.__lnT2CNReady && window.__lnT2CNReady()').catch(() => false);
        if (ok) return true;
        await sleep(100);
      }
      return false;
    })();
    check('繁简转换表已就绪', normReady === true, `opencc=${normReady}`);

    // 索引包按需加载：显式驱动，不依赖聚焦时序
    const idxState = await cdp.evaluate(`(async () => {
      await Promise.all([window.__lnLoadIdx('au'), window.__lnLoadIdx('pyf'), window.__lnLoadIdx('rpy')]);
      return window.__lnIdxState();
    })()`);
    check('三个搜索索引包均可加载',
      idxState.au.ready && idxState.pyf.ready && idxState.rpy.ready, JSON.stringify(idxState));

    const resultCountOf = () =>
      cdp.evaluate(`(() => Number(document.getElementById('resultCount').textContent))()`);

    // 1) 全角输入：ＧＲＩＤＭＡＮ 与 GRIDMAN 结果应一致
    await setSearch('GRIDMAN');
    const halfWidth = await resultCountOf();
    await setSearch('ＧＲＩＤＭＡＮ');
    const fullWidth = await resultCountOf();
    check('全角字母可搜到半角书名', halfWidth > 0 && fullWidth === halfWidth,
      `半角 ${halfWidth} / 全角 ${fullWidth}`);

    // 2) 繁体书名：用简体写法能搜到库里以繁体存储的条目
    const tradSample = await cdp.evaluate(`(() => {
      const conv = window.__lnNormalizeForTest;
      const list = (window.LN_DATA || []).filter((x) => x.cn && !x.c && !x.gn && !x.ver);
      for (const x of list) {
        const simple = conv(x.cn);
        if (simple !== x.cn) return { id: String(x.i), raw: x.cn, simple };
      }
      return null;
    })()`);
    if (tradSample) {
      await setSearch(tradSample.simple);
      const ids = await cdp.evaluate(`(() => [...document.querySelectorAll('.card')].map((c) => c.dataset.id))()`);
      check('简体写法可搜到繁体书名', ids.includes(tradSample.id),
        `${tradSample.simple} → ${ids.length} 条，含目标=${ids.includes(tradSample.id)}`);
      await setSearch(tradSample.raw);
      const tradIds = await cdp.evaluate(`(() => [...document.querySelectorAll('.card')].map((c) => c.dataset.id))()`);
      check('繁体写法同样可搜到', tradIds.includes(tradSample.id),
        `${tradSample.raw} → ${tradIds.length} 条`);
    } else {
      check('简体写法可搜到繁体书名', false, '未取到繁体样本');
    }

    // 3) 全拼：用完整拼音（非首字母）搜到目标
    const fullPy = await cdp.evaluate(`(() => {
      const x = (window.LN_DATA || []).find((v) => v.pyFull && v.pyFull.length >= 10 && !v.c && !v.gn && !v.ver);
      return x ? { id: String(x.i), py: x.pyFull, title: x.cn || x.n } : null;
    })()`);
    if (fullPy) {
      await setSearch(fullPy.py);
      const ids = await cdp.evaluate(`(() => [...document.querySelectorAll('.card')].map((c) => c.dataset.id))()`);
      check('全拼命中目标书名', ids.includes(fullPy.id),
        `${fullPy.py} → ${ids.length} 条，含目标=${ids.includes(fullPy.id)}`);
    } else {
      check('全拼命中目标书名', false, '未取到全拼样本');
    }

    // 4) 罗马字：假名标题可用罗马字读音搜到
    const romaji = await cdp.evaluate(`(() => {
      const x = (window.LN_DATA || []).find((v) => v.rpyFull && v.rpyFull.length >= 10 && !v.c && !v.gn && !v.ver);
      return x ? { id: String(x.i), rpy: x.rpyFull, title: x.cn || x.n } : null;
    })()`);
    if (romaji) {
      await setSearch(romaji.rpy);
      const ids = await cdp.evaluate(`(() => [...document.querySelectorAll('.card')].map((c) => c.dataset.id))()`);
      check('罗马字读音可搜到日文标题', ids.includes(romaji.id),
        `${romaji.rpy} → ${ids.length} 条，含目标=${ids.includes(romaji.id)}`);
    } else {
      check('罗马字读音可搜到日文标题', false, '未取到罗马字样本');
    }

    // 4b) 假名折叠：书名用片假名存储时，用户按平假名输入（同一个词的另一种写法）也要能搜到。
    //     日文输入法里「ムダに」和「むだに」是同一个词，用户记不住库里存的是哪一种。
    const kanaCase = await cdp.evaluate(`(() => {
      const toHira = (s) => String(s).replace(/[\\u30A1-\\u30F6]/g, (ch) =>
        String.fromCharCode(ch.charCodeAt(0) - 0x60));
      for (const x of window.LN_DATA || []) {
        if (x.c || x.gn || x.ver) continue;
        const t = String(x.cn || x.n || '');
        if (!/[\\u30A1-\\u30F6]/.test(t)) continue;
        const hira = toHira(t);
        // 片假名与平假名折叠后是同一串，查询必须仍能命中
        return { id: String(x.i), kata: t, hira };
      }
      return null;
    })()`);
    if (kanaCase) {
      // 反向确认：这个平假名查询在「不折叠」时应为 0，否则用例证明不了折叠
      await setSearch(kanaCase.hira);
      const ids = await cdp.evaluate(`(() => [...document.querySelectorAll('.card')].map((c) => c.dataset.id))()`);
      check('平假名写法可搜到片假名书名', ids.includes(kanaCase.id),
        `${kanaCase.hira.slice(0, 16)} → ${ids.length} 条，含目标=${ids.includes(kanaCase.id)}`);
    } else {
      check('平假名写法可搜到片假名书名', false, '未取到含片假名样本');
    }

    // 4c) 长音折叠：库里罗马字把 ー 直接删掉（コーヒー→kohi），按赫本式双写元音打的
    //     koohii 必须也能命中。严格匹配下折叠式一本都中不了，产品会切到兜底通道。
    const choonCase = await cdp.evaluate(`(() => {
      const fold = (s) => String(s || '').replace(/ou/g, 'o').replace(/([aiueo])\\1+/g, '$1');
      for (const x of window.LN_DATA || []) {
        if (x.c || x.gn || x.ver) continue;
        const r = String(x.rpyFull || '');
        if (r.length < 6) continue;
        const f = fold(r);
        if (f === r || f.length < 6) continue;
        return { id: String(x.i), rpy: r, folded: f };
      }
      return null;
    })()`);
    if (choonCase) {
      await setSearch(choonCase.folded);
      const ids = await cdp.evaluate(`(() => [...document.querySelectorAll('.card')].map((c) => c.dataset.id))()`);
      check('罗马字长音省略写法可命中', ids.includes(choonCase.id),
        `${choonCase.folded.slice(0, 20)} → ${ids.length} 条，含目标=${ids.includes(choonCase.id)}`);
    } else {
      check('罗马字长音省略写法可命中', false, '未取到含长音样本');
    }

    // 5) 作者独立索引：作者名只存在于 au 包，不出现于任何书名
    const auOnly = await cdp.evaluate(`(() => {
      const corpus = (window.LN_DATA || []).map((x) => (x.cn || '') + '|' + (x.n || '')).join('\\n');
      for (const x of window.LN_DATA || []) {
        const name = String(x.au || '').split(/[\\/、,，&]/)[0].trim();
        if (!name || name.length < 2) continue;
        if (!/^[\\u4e00-\\u9fff]+$/.test(name)) continue;
        if (corpus.includes(name)) continue;
        return { name, id: String(x.i) };
      }
      return null;
    })()`);
    if (auOnly) {
      await setSearch(auOnly.name);
      const ids = await cdp.evaluate(`(() => [...document.querySelectorAll('.card')].map((c) => c.dataset.id))()`);
      check('作者独立索引可搜到', ids.includes(auOnly.id),
        `${auOnly.name} → ${ids.length} 条，含目标=${ids.includes(auOnly.id)}`);
    } else {
      check('作者独立索引可搜到', false, '未取到纯作者名样本');
    }

    // 7) 写法差异兜底：用户省略书名里的标点/空格时也要能搜到
    const compactCase = await cdp.evaluate(`(() => {
      const list = (window.LN_DATA || []).filter((x) => x.n && !x.c && !x.gn && !x.ver);
      for (const x of list) {
        // 找一个「原文里含分隔符、去掉后成为纯连续串」的书名
        const n = String(x.n);
        const compacted = n.replace(/[\\s!-/:-@\\[-\\\`{-~·・、。，．：；！？「」『』（）【】《》〈〉〜～—–―…＆＃＠]/g, '');
        if (compacted.length < 6 || compacted === n) continue;
        // 只有当「严格搜 compacted」确实搜不到时才算有效用例
        return { id: String(x.i), raw: n, compacted };
      }
      return null;
    })()`);
    if (compactCase) {
      // 先确认严格匹配确实为 0（否则这个用例证明不了兜底）
      const strictHit = await cdp.evaluate(`(() => {
        const t = ${JSON.stringify(compactCase.compacted)}.toLowerCase();
        return (window.LN_DATA || []).some((x) => {
          if (x.c || x.gn || x.ver) return false;
          return [x.cn, x.n].some((s) => String(s || '').toLowerCase().includes(t));
        });
      })()`);
      await setSearch(compactCase.compacted);
      const ids = await cdp.evaluate(`(() => [...document.querySelectorAll('.card')].map((c) => c.dataset.id))()`);
      check('省略标点/空格也能搜到',
        ids.includes(compactCase.id),
        `${compactCase.compacted.slice(0, 20)} → ${ids.length} 条（严格匹配原有=${strictHit}）`);
    } else {
      check('省略标点/空格也能搜到', false, '未取到含分隔符样本');
    }

    // 8) 兜底不得污染正常结果：能严格搜到的查询，结果数不应因为兜底而变多
    await setSearch('文学少女');
    const normalCount = await resultCountOf();
    await setSearch('');
    const strictExpected = await cdp.evaluate(`(() => (window.LN_DATA || []).filter((x) => {
      if (x.c || x.gn || x.ver) return false;
      return [x.cn, x.n].some((s) => String(s || '').includes('文学少女'));
    }).length)()`);
    check('严格命中时不启用宽松兜底', normalCount === strictExpected,
      `页面 ${normalCount} / 严格 ${strictExpected}`);

    await setSearch('');
    await cdp.evaluate(`(() => { location.hash = ''; })()`);

    // 6) 索引未就绪 / 加载失败两态：由 scripts/check-shard-failure.mjs 覆盖。
    //    不能在这里测：verify 跑到这里索引包已被 SW 缓存，重置后 loadIdx 会立刻从缓存返回，
    //    「加载中」窗口短到抓不住，断言只能测到竞态。失败态更测不了——缓存优先挡掉 503。
    await setSearch('');
    await cdp.evaluate(`(() => { location.hash = ''; })()`);

    // ---- 排序 ----
    await cdp.evaluate(`(() => {
      const el = document.getElementById('sort');
      el.value = 'heat';
      el.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await sleep(250);
    const heatFirst = await cdp.evaluate(`(() => window.LN_DATA.filter((x) => !x.c && !x.gn && !x.ver).sort((a,b) => (b.h||0)-(a.h||0))[0].i)()`);
    const shownFirst = await cdp.evaluate(`(() => document.querySelector('.card')?.dataset.id)()`);
    check('按热度排序生效', String(shownFirst) === String(heatFirst), `${shownFirst} / ${heatFirst}`);

    // 评分排序使用贝叶斯加权：低收藏的 10 分条目不应占据榜首
    await cdp.evaluate(`(() => {
      const el = document.getElementById('sort');
      el.value = 'score';
      el.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await sleep(250);
    const scoreFirst = await cdp.evaluate(`(() => {
      const list = window.LN_DATA.filter((x) => !x.c && !x.gn && !x.ver);
      const f = window.__lnBayesScore;
      const top = list.slice().sort((a, b) => f(b) - f(a) || (b.h || 0) - (a.h || 0))[0];
      return { id: String(top.i), h: top.h, s: top.s };
    })()`);
    const shownScoreFirst = await cdp.evaluate(`(() => document.querySelector('.card')?.dataset.id)()`);
    check('评分排序使用加权分数', String(shownScoreFirst) === String(scoreFirst.id),
      `${shownScoreFirst} / ${scoreFirst.id}（s=${scoreFirst.s}, h=${scoreFirst.h}）`);
    check('加权后榜首具备足够收藏量', (scoreFirst.h || 0) >= 300, `h=${scoreFirst.h}`);

    // 卷数排序
    await cdp.evaluate(`(() => {
      const el = document.getElementById('sort');
      el.value = 'vol';
      el.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await sleep(250);
    const maxVol = await cdp.evaluate(`(() => Math.max(...window.LN_DATA.filter((x) => !x.c && !x.gn && !x.ver).map((x) => Number(x.v) || 0)))()`);
    const firstVol = await cdp.evaluate(`(() => {
      const id = document.querySelector('.card')?.dataset.id;
      const x = window.LN_DATA.find((v) => String(v.i) === id);
      return Number(x?.v) || 0;
    })()`);
    check('按卷数排序生效', firstVol === maxVol, `${firstVol} / ${maxVol}`);

    // 键盘 J/K 移动焦点
    const keyboardNav = await cdp.evaluate(`(() => {
      const cards = [...document.querySelectorAll('.card')];
      if (cards.length < 2) return false;
      const first = cards[0].querySelector('.card-link');
      first.focus();
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', bubbles: true }));
      const active = document.activeElement.closest('.card');
      return active === cards[1];
    })()`);
    check('J 键移动到下一张卡片', keyboardNav === true);
    await click('#clearFiltersBtn');

    // ---- 我的阅读 ----
    const pick = await cdp.evaluate(`(() => {
      const x = (window.LN_DATA || []).find((v) => v.v > 2 && !v.c && !v.gn && !v.ver && v.img);
      return { id: String(x.i), v: x.v, name: x.cn || x.n };
    })()`);
    // 通过详情加入，避免目标条目不在首个分页里导致点击不到
    await cdp.evaluate(`(() => { location.hash = 'd=' + ${JSON.stringify(pick.id)}; })()`);
    await sleep(300);
    await click('#detailToggle');
    const stored = await cdp.evaluate(`(() => JSON.parse(localStorage.getItem('yuc_ln_mine_v1') || '{}'))()`);
    check('加入后写入本地记录', !!stored[pick.id], pick.name);
    check('新记录状态为想读', stored[pick.id]?.s === 'want');
    check('我的数量徽标更新',
      (await cdp.evaluate(`(() => document.getElementById('mineCount').textContent)()`)) === '1');

    // 详情内一键记录卷进度（参考 BookLore 的一键进度交互）
    const progInit = await cdp.evaluate(`(() => {
      const box = document.getElementById('detailProgress');
      return {
        hidden: box.hidden,
        steps: box.querySelectorAll('[data-prog]').length,
        minusDisabled: box.querySelector('[data-prog="-1"]')?.disabled,
      };
    })()`);
    check('详情显示卷进度控制',
      progInit.hidden === false && progInit.steps === 3, JSON.stringify(progInit));
    check('进度为 0 时不能减卷', progInit.minusDisabled === true);
    await cdp.evaluate(`(() => document.querySelector('#detailProgress [data-prog="1"]').click())()`);
    await sleep(300);
    const progAfter = await cdp.evaluate(`(() => ({
      entry: JSON.parse(localStorage.getItem('yuc_ln_mine_v1') || '{}')[${JSON.stringify(pick.id)}],
      progressText: document.getElementById('detailProgress').textContent,
      metaText: document.getElementById('detailMeta').textContent,
    }))()`);
    check('详情一键记录下一卷',
      Number(progAfter.entry?.vol) === 1 && progAfter.entry?.s === 'doing',
      `vol=${progAfter.entry?.vol} s=${progAfter.entry?.s}`);
    check('详情进度与元信息同步',
      progAfter.progressText.includes('第 1 / ' + pick.v + ' 卷') &&
      progAfter.metaText.includes('第 1 / ' + pick.v + ' 卷'),
      `${progAfter.progressText.slice(0, 40)} / ${progAfter.metaText.slice(0, 40)}`);
    await cdp.evaluate(`(() => { location.hash = ''; })()`);
    await sleep(250);

    await click('.tab[data-tab="mine"]');
    check('我的阅读显示 1 本',
      (await cdp.evaluate(`(() => Number(document.getElementById('statCount').textContent))()`)) === 1);
    check('系列条目显示卷进度输入', (await count('.card .epin')) > 0);

    const volInput = await cdp.evaluate(`(() => {
      const el = document.querySelector('.card .epin');
      if (!el) return null;
      el.value = '2';
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
    await sleep(250);
    const afterVol = await cdp.evaluate(`(() => JSON.parse(localStorage.getItem('yuc_ln_mine_v1') || '{}'))()`);
    check('进度输入写入 vol', volInput && Number(afterVol[pick.id]?.vol) === 2, `vol=${afterVol[pick.id]?.vol}`);
    check('进度未满不标记读完', afterVol[pick.id]?.s !== 'done');

    // 读完状态自动填日期与卷数
    await cdp.evaluate(`(() => { location.hash = 'd=' + ${JSON.stringify(pick.id)}; })()`);
    await sleep(300);
    check('详情弹窗可打开', await cdp.evaluate(`(() => !document.getElementById('modal').hidden)()`));
    await click('#statusOpts [data-status="done"]');
    const doneEntry = await cdp.evaluate(`(() => JSON.parse(localStorage.getItem('yuc_ln_mine_v1') || '{}')[${JSON.stringify(pick.id)}])()`);
    check('标记读完自动记录日期', Number(doneEntry?.f) > 0);
    check('标记读完自动补满卷数', Number(doneEntry?.vol) === pick.v, `${doneEntry?.vol}/${pick.v}`);
    const detailText = await cdp.evaluate(`(() => document.getElementById('detailMeta').textContent)()`);
    check('详情显示作者与出版社', /作者/.test(detailText) || /出版社/.test(detailText), detailText.slice(0, 40));
    check('详情提供 Bangumi 链接',
      /bgm\.tv\/subject\//.test(await cdp.evaluate(`(() => document.getElementById('detailLink').href)()`)));
    check('详情有相似推荐', (await count('#detailSimilar .sim-card')) > 0);
    const simWhy = await cdp.evaluate(`(() => Array.from(document.querySelectorAll('#detailSimilar .sim-why')).map((el) => el.textContent))()`);
    check('相似推荐标注推荐理由',
      simWhy.length > 0 && simWhy.every((w) => ['同作者', '同书系', '同题材', '评分接近'].includes(w)),
      simWhy.join('/'));

    // 点击作者标签跳到该作者的全库筛选
    const authorJumpName = await cdp.evaluate(`(() => {
      const btn = document.querySelector('#detailMeta [data-jump-author]');
      if (!btn) return '';
      const name = btn.dataset.jumpAuthor;
      btn.click();
      return name;
    })()`);
    await sleep(350);
    const authorJumpState = await cdp.evaluate(`(() => ({
      modalClosed: document.getElementById('modal').hidden,
      q: document.getElementById('search').value,
      count: Number(document.getElementById('resultCount').textContent),
    }))()`);
    const authorJumpExpected = await cdp.evaluate(`(() => window.LN_DATA.filter((x) => !x.c && !x.gn && !x.ver && String(x.au || '').includes(${JSON.stringify(authorJumpName)})).length)()`);
    check('作者标签跳转全库筛选',
      !!authorJumpName && authorJumpState.modalClosed && authorJumpState.q === '作者:' + authorJumpName &&
      authorJumpState.count === authorJumpExpected,
      `${authorJumpName} ${authorJumpState.count}/${authorJumpExpected}`);
    await setSearch('');

    // 出版社标签同样可一键筛选（含空白的出版社降级为普通标签，不参与本项）
    const pubJump = await cdp.evaluate(`(() => {
      const counts = {};
      window.LN_DATA.forEach((x) => {
        if (!x.c && !x.gn && !x.ver && x.pub && !/\\s/.test(x.pub)) counts[x.pub] = (counts[x.pub] || 0) + 1;
      });
      const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
      if (!top) return null;
      const rec = window.LN_DATA.find((x) => !x.c && !x.gn && !x.ver && x.pub === top[0]);
      return { pub: top[0], id: String(rec.i) };
    })()`);
    if (pubJump) {
      await cdp.evaluate(`(() => { location.hash = 'd=' + ${JSON.stringify(pubJump.id)}; })()`);
      await sleep(300);
      const pubJumpName = await cdp.evaluate(`(() => {
        const btn = document.querySelector('#detailMeta [data-jump-pub]');
        if (!btn) return '';
        const name = btn.dataset.jumpPub;
        btn.click();
        return name;
      })()`);
      await sleep(350);
      const pubJumpState = await cdp.evaluate(`(() => ({
        modalClosed: document.getElementById('modal').hidden,
        q: document.getElementById('search').value,
        count: Number(document.getElementById('resultCount').textContent),
      }))()`);
      const pubJumpExpected = await cdp.evaluate(`(() => window.LN_DATA.filter((x) => !x.c && !x.gn && !x.ver && String(x.pub || '').toLowerCase().includes(${JSON.stringify(pubJump.pub)}.toLowerCase())).length)()`);
      check('出版社标签跳转全库筛选',
        !!pubJumpName && pubJumpState.modalClosed && pubJumpState.q === '出版社:' + pubJumpName &&
        pubJumpState.count === pubJumpExpected,
        `${pubJumpName} ${pubJumpState.count}/${pubJumpExpected}`);
      await setSearch('');
    } else {
      check('出版社标签跳转全库筛选', true, '数据中无单段出版社');
    }
    await cdp.evaluate(`(() => { location.hash = 'd=' + ${JSON.stringify(pick.id)}; })()`);
    await sleep(300);

    // ---- 我的书评：评分 / 短评 / 笔记 ----
    check('详情显示 10 档评分', (await count('#detailReview [data-rate]')) === 10);
    await cdp.evaluate(`(() => document.querySelector('#detailReview [data-rate="9"]').click())()`);
    await sleep(200);
    await cdp.evaluate(`(() => {
      const shortEl = document.getElementById('reviewShort');
      const noteEl = document.getElementById('reviewNote');
      shortEl.value = '测试短评';
      shortEl.dispatchEvent(new Event('input', { bubbles: true }));
      noteEl.value = '测试笔记';
      noteEl.dispatchEvent(new Event('input', { bubbles: true }));
      document.getElementById('reviewSave').click();
    })()`);
    await sleep(300);
    const reviewEntry = await cdp.evaluate(`(() => JSON.parse(localStorage.getItem('yuc_ln_mine_v1') || '{}')[${JSON.stringify(pick.id)}])()`);
    check('评分写入阅读记录', Number(reviewEntry?.r) === 9, `r=${reviewEntry?.r}`);
    check('短评写入阅读记录', reviewEntry?.rv === '测试短评', reviewEntry?.rv);
    check('笔记写入阅读记录', reviewEntry?.nt === '测试笔记', reviewEntry?.nt);
    check('详情元信息显示我的评分',
      /我的评分/.test(await cdp.evaluate(`(() => document.getElementById('detailMeta').textContent)()`)));
    await click('.tab[data-tab="mine"]');
    check('卡片显示我的评分角标', (await count('.badge.myrating')) > 0);
    check('书评时间戳单独记录', Number(reviewEntry?.rvU) > 0);

    // 导出内容应包含书评字段（拦截 Blob 读取，不真正下载）
    await cdp.evaluate(`(() => {
      window.__lnExported = null;
      const orig = URL.createObjectURL;
      URL.createObjectURL = function (blob) { window.__lnExported = blob; return 'blob:verify'; };
      document.getElementById('exportBtn').click();
      URL.createObjectURL = orig;
    })()`);
    await sleep(200);
    const exportedText = await cdp.evaluate(`(async () => (window.__lnExported ? await window.__lnExported.text() : ''))()`);
    let exportedJson = null;
    try { exportedJson = JSON.parse(exportedText); } catch {}
    const exportedItem = exportedJson && Array.isArray(exportedJson.items)
      ? exportedJson.items.find((it) => String(it.id) === String(pick.id)) : null;
    check('导出 JSON 版本升级为 4', exportedJson?.version === 4, String(exportedJson?.version));
    check('导出 JSON 含评分与短评',
      exportedItem?.rating === 9 && exportedItem?.review === '测试短评',
      JSON.stringify({ r: exportedItem?.rating, rv: exportedItem?.review }));

    // 评: 字段搜索短评与笔记正文
    await setSearch('评:测试短评');
    const reviewSearch = await cdp.evaluate(`(() => ({
      count: Number(document.getElementById('resultCount').textContent),
      ids: [...document.querySelectorAll('.card')].map((c) => c.dataset.id),
    }))()`);
    check('评: 搜索书评正文', reviewSearch.count >= 1 && reviewSearch.ids.includes(String(pick.id)),
      `${reviewSearch.count} 条`);
    await setSearch('');

    await cdp.evaluate(`(() => { location.hash = ''; })()`);
    await sleep(300);

    // ---- 书评草稿：未点保存时本机暂存，重新打开详情自动恢复 ----
    await cdp.evaluate(`(() => { location.hash = 'd=' + ${JSON.stringify(pick.id)}; })()`);
    await sleep(300);
    await cdp.evaluate(`(() => {
      const el = document.getElementById('reviewShort');
      el.value = '未保存草稿';
      el.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await sleep(200);
    const draftAfterInput = await cdp.evaluate(`(() => JSON.parse(localStorage.getItem('yuc_ln_draft_v1') || '{}')[${JSON.stringify(pick.id)}])()`);
    check('未保存书评暂存为草稿', draftAfterInput?.rv === '未保存草稿', draftAfterInput?.rv);
    await cdp.evaluate(`(() => { location.hash = ''; })()`);
    await sleep(300);
    await cdp.evaluate(`(() => { location.hash = 'd=' + ${JSON.stringify(pick.id)}; })()`);
    await sleep(300);
    check('重新打开详情恢复草稿内容',
      (await cdp.evaluate(`(() => document.getElementById('reviewShort').value)()`)) === '未保存草稿');
    check('详情提示已恢复草稿',
      /草稿/.test(await cdp.evaluate(`(() => document.getElementById('detailReview').textContent)()`)));
    await cdp.evaluate(`(() => document.getElementById('reviewSave').click())()`);
    await sleep(300);
    const draftAfterSave = await cdp.evaluate(`(() => JSON.parse(localStorage.getItem('yuc_ln_draft_v1') || '{}')[${JSON.stringify(pick.id)}])()`);
    check('保存书评后清除草稿', !draftAfterSave);
    await cdp.evaluate(`(() => { location.hash = ''; })()`);
    await sleep(300);

    // ---- 视图与分组 ----
    await click('.tab[data-tab="mine"]');
    // 列表视图封面仅 64px 宽，sizes 应随之收窄，避免误取 400w 大图
    await cdp.evaluate(`(() => {
      const el = document.getElementById('viewSelect');
      el.value = 'list';
      el.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await sleep(250);
    const listCovers = await cdp.evaluate(`(() => [...document.querySelectorAll('.grid.list .cover img')].map((i) => ({ sizes: i.getAttribute('sizes'), srcset: i.getAttribute('srcset') || '' })))()`);
    check('列表视图封面使用紧凑 sizes 与 100w 档',
      listCovers.length > 0 && listCovers.every((c) => c.sizes === '64px' && c.srcset.includes('100w')),
      listCovers.slice(0, 3).map((c) => c.sizes).join('|'));
    await cdp.evaluate(`(() => {
      const el = document.getElementById('viewSelect');
      el.value = 'board';
      el.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await sleep(250);
    check('看板视图显示四列', (await count('.board-col')) === 4);
    const boardCovers = await cdp.evaluate(`(() => [...document.querySelectorAll('.board-list .cover img')].map((i) => ({ sizes: i.getAttribute('sizes'), srcset: i.getAttribute('srcset') || '' })))()`);
    check('看板视图封面使用紧凑 sizes 与 100w 档',
      boardCovers.length > 0 && boardCovers.every((c) => c.sizes === '56px' && c.srcset.includes('100w')),
      boardCovers.slice(0, 3).map((c) => c.sizes).join('|'));
    await cdp.evaluate(`(() => {
      const el = document.getElementById('viewSelect');
      el.value = 'grid';
      el.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await sleep(200);
    await click('#groupBtn');
    check('按年份分组渲染分组标题', (await count('.tl-group')) > 0);
    await click('#groupBtn');

    // ---- 批量 ----
    await click('#bulkBtn');
    await click('.card .selbox');
    check('批量选择显示底栏',
      (await cdp.evaluate(`(() => !document.getElementById('bulkBar').hidden)()`)) === true);
    await click('[data-bulk="doing"]');
    const bulkEntry = await cdp.evaluate(`(() => JSON.parse(localStorage.getItem('yuc_ln_mine_v1') || '{}')[${JSON.stringify(pick.id)}])()`);
    check('批量标记为在读', bulkEntry?.s === 'doing', bulkEntry?.s);

    // ---- 导入 JSON ----
    const importTarget = await cdp.evaluate(`(() => {
      const x = (window.LN_DATA || []).find((v) => v.v > 1 && !v.c && !v.gn && !v.ver && v.img && String(v.i) !== ${JSON.stringify(pick.id)});
      return { id: String(x.i), v: x.v };
    })()`);
    await cdp.evaluate(`(() => {
      const payload = {
        app: 'yuc-light-novel-list',
        version: 1,
        items: [
          { id: ${JSON.stringify(importTarget.id)}, status: 'done', vol: ${importTarget.v},
            addedAt: 1, updatedAt: 2, finishedAt: 3, rating: 8, review: '导入短评', note: '导入笔记' },
          { id: 999999999, status: 'want' }
        ]
      };
      const dt = new DataTransfer();
      dt.items.add(new File([JSON.stringify(payload)], 'import.json', { type: 'application/json' }));
      const input = document.getElementById('fileInput');
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await sleep(500);
    const imported = await cdp.evaluate(`(() => JSON.parse(localStorage.getItem('yuc_ln_mine_v1') || '{}'))()`);
    check('导入新增有效条目', !!imported[importTarget.id] && imported[importTarget.id].s === 'done');
    check('导入还原卷进度', Number(imported[importTarget.id]?.vol) === importTarget.v,
      `${imported[importTarget.id]?.vol}/${importTarget.v}`);
    check('导入跳过未知条目', Object.keys(imported).length === 2, Object.keys(imported).join(','));
    check('导入还原书评字段',
      imported[importTarget.id]?.r === 8 && imported[importTarget.id]?.rv === '导入短评' &&
      imported[importTarget.id]?.nt === '导入笔记',
      JSON.stringify({ r: imported[importTarget.id]?.r, rv: imported[importTarget.id]?.rv }));

    // ---- 我的阅读排序（参考 Bangumi 客户端收藏列表的评分 / 进度 / 最近更新排序）----
    const setMineSort = async (value) => {
      await cdp.evaluate(`(() => {
        const el = document.getElementById('mineSort');
        el.value = ${JSON.stringify(value)};
        el.dispatchEvent(new Event('change', { bubbles: true }));
      })()`);
      await sleep(250);
      return cdp.evaluate(`(() => document.querySelector('.card')?.dataset.id)()`);
    };
    check('我的阅读可按我的评分排序', (await setMineSort('rating')) === pick.id);
    // 把 pick 回退一卷，制造与导入条目（读满）不同的进度比例
    await cdp.evaluate(`(() => {
      const el = document.querySelector('.card[data-id="' + ${JSON.stringify(pick.id)} + '"] .epin');
      if (!el) return;
      el.value = String(Math.max(0, ${pick.v} - 1));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await sleep(250);
    check('我的阅读可按阅读进度排序', (await setMineSort('progress')) === importTarget.id);
    check('我的阅读可按最近更新排序', (await setMineSort('updated')) === pick.id);

    // ---- 继续阅读快捷条（参考 Kavita Continue Reading）----
    const contPure = await cdp.evaluate(`(() => window.__lnContinueList && window.__lnContinueList([
      { i: 1, v: 5 }, { i: 2, v: 3 }, { i: 3, v: 4 }, { i: 4, v: 2 }
    ], {
      1: { s: 'doing', vol: 2, u: 10 },
      2: { s: 'done', vol: 3, u: 20 },
      3: { s: 'doing', vol: 2, u: 30 },
      4: { s: 'want', vol: 0, u: 40 }
    }, 5).map(function (o) { return o.x.i; }))()`);
    check('继续阅读只取在读未读满并按时更新排序',
      JSON.stringify(contPure) === '[3,1]', JSON.stringify(contPure));
    const contDom = await cdp.evaluate(`(() => ({
      hidden: document.getElementById('continueRow').hidden,
      n: document.querySelectorAll('#continueList .cont-card').length,
      id: document.querySelector('#continueList .cont-open')?.dataset.id || '',
      meta: document.querySelector('#continueList .cont-meta')?.textContent || '',
    }))()`);
    check('我的阅读显示继续阅读快捷条',
      contDom.hidden === false && contDom.n === 1 && contDom.id === pick.id &&
      contDom.meta === '第 ' + (pick.v - 1) + ' / ' + pick.v + ' 卷', JSON.stringify(contDom));
    await cdp.evaluate(`(() => { document.querySelector('#continueList [data-cont="next"]').click(); })()`);
    await sleep(350);
    const contAfter = await cdp.evaluate(`(() => ({
      entry: JSON.parse(localStorage.getItem('yuc_ln_mine_v1') || '{}')[${JSON.stringify(pick.id)}],
      hidden: document.getElementById('continueRow').hidden,
      n: document.querySelectorAll('#continueList .cont-card').length,
      toast: document.getElementById('toast').textContent,
    }))()`);
    check('继续阅读一键加一卷并自动读完',
      Number(contAfter.entry?.vol) === pick.v && contAfter.entry?.s === 'done' &&
      contAfter.hidden === true && contAfter.n === 0 && /第 \d+ 卷/.test(contAfter.toast),
      JSON.stringify(contAfter));

    // ---- 阅读统计 ----
    await click('.tab[data-tab="stats"]');
    await sleep(300);
    check('统计页显示统计卡片',
      (await cdp.evaluate(`(() => !document.getElementById('statsPanel').hidden)()`)) === true &&
      (await count('#statsPanel .stat-card')) >= 4);
    check('统计页显示年度目标',
      /年目标/.test(await cdp.evaluate(`(() => document.getElementById('statsPanel').textContent)()`)));
    await cdp.evaluate(`(() => {
      const el = document.getElementById('goalInput');
      el.value = '12';
      document.querySelector('#statsPanel [data-stats="goal"]').click();
    })()`);
    await sleep(250);
    const goalStored = await cdp.evaluate(`(() => JSON.parse(localStorage.getItem('yuc_ln_goal_v1') || '{}'))()`);
    check('年度目标写入本地', Number(goalStored.target) === 12, JSON.stringify(goalStored));
    check('年度目标显示节奏',
      /节奏：/.test(await cdp.evaluate(`(() => document.getElementById('statsPanel').textContent)()`)) &&
      /(领先|落后|正好按时)/.test(await cdp.evaluate(`(() => document.getElementById('statsPanel').textContent)()`)));
    const pace = await cdp.evaluate(`(() => window.__lnGoalPace(20, 10, new Date('2026-07-02T12:00:00')))()`);
    check('目标节奏按已过天数计算',
      pace && pace.expected === 5 && pace.delta === 15 && pace.percentDay === 50,
      JSON.stringify(pace));
    check('统计页汇总已评分数量',
      /已评分/.test(await cdp.evaluate(`(() => document.getElementById('statsPanel').textContent)()`)));
    // 我的评分分布（参考 Goodreads 书页的星级分布条）
    const distPure = await cdp.evaluate(`(() => window.__lnRatingDist && window.__lnRatingDist([
      { e: { r: 9 } }, { e: { r: 9 } }, { e: { r: 10 } }, { e: { r: 0 } }, { e: { r: 7 } }
    ]))()`);
    check('评分分布按 1–10 分统计并给出平均与最常分',
      distPure && distPure.rated === 4 && distPure.counts[8] === 2 && distPure.counts[9] === 1 &&
      distPure.mode === 9 && distPure.avg === 8.8, JSON.stringify(distPure));
    const distDom = await cdp.evaluate(`(() => {
      const card = Array.from(document.querySelectorAll('#statsPanel .stat-card'))
        .find((el) => /我的评分/.test(el.textContent));
      if (!card) return null;
      return {
        bars: card.querySelectorAll('.rdist span').length,
        on: card.querySelectorAll('.rdist span.on').length,
        aria: card.querySelector('.rdist')?.getAttribute('aria-label') || '',
        text: card.textContent,
      };
    })()`);
    check('统计页显示评分分布柱与偏好摘要',
      !!distDom && distDom.bars === 10 && distDom.on === 2 &&
      /最常给/.test(distDom.text) && /分 \d+ 本/.test(distDom.aria), JSON.stringify(distDom));
    check('统计页显示常读作者',
      /常读作者/.test(await cdp.evaluate(`(() => document.getElementById('statsPanel').textContent)()`)));

    // 年度小结导出（拦截 Blob 读取，不真正下载）
    await cdp.evaluate(`(() => {
      window.__lnYearMd = null;
      const orig = URL.createObjectURL;
      URL.createObjectURL = function (blob) { window.__lnYearMd = blob; return 'blob:verify-year'; };
      document.querySelector('#statsPanel [data-stats="exportYear"]').click();
      URL.createObjectURL = orig;
    })()`);
    await sleep(250);
    const yearMd = await cdp.evaluate(`(async () => (window.__lnYearMd ? await window.__lnYearMd.text() : ''))()`);
    const currentYear = new Date().getFullYear();
    check('年度小结导出 Markdown',
      yearMd.includes(currentYear + ' 年阅读小结') && yearMd.includes(pick.name) && yearMd.includes('读完：'),
      yearMd.slice(0, 40));
    check('年度小结含题材与书目段落',
      yearMd.includes('## 题材偏好') && yearMd.includes('## 读完书目'));
    // 阅读节奏：读完率与平均读完天数（参考 StoryGraph 的平均读完用时统计）
    const paceSample = await cdp.evaluate(`(() => window.__lnReadingPace && window.__lnReadingPace([
      { e: { s: 'done', t: 1000, f: 1000 + 3 * 86400000 } },
      { e: { s: 'done', t: 1000, f: 1000 + 5 * 86400000 } },
      { e: { s: 'want', t: 1000, f: 0 } },
    ]))()`);
    check('阅读节奏按加入与读完时间计算',
      paceSample && paceSample.rate === 67 && paceSample.avgDays === 4 && paceSample.sampled === 2,
      JSON.stringify(paceSample));
    const paceDom = await cdp.evaluate(`(() => {
      const card = Array.from(document.querySelectorAll('#statsPanel .stat-card'))
        .find((el) => /阅读节奏/.test(el.textContent));
      return card ? card.textContent : '';
    })()`);
    check('统计页显示读完率与平均读完天数',
      /读完率/.test(paceDom) && /平均读完天数/.test(paceDom) && /\d+%/.test(paceDom), paceDom);
    // 阅读打卡：连续天数（参考 StoryGraph 的 daily streak）
    const streakSample = await cdp.evaluate(`(() => {
      const d = (y, m, day) => new Date(y, m - 1, day, 12, 0, 0).getTime();
      return window.__lnReadingStreak(
        ['2026-11-20', '2026-11-21', '2026-11-22', '2026-11-23'],
        [{ e: { u: d(2026, 11, 18), f: 0 } }, { e: { u: 0, f: d(2026, 11, 19) } }],
        new Date(2026, 10, 23, 12, 0, 0));
    })()`);
    check('打卡按自然日合并记录并计算连续天数',
      streakSample && streakSample.current === 6 && streakSample.longest === 6 &&
      streakSample.week === 6 && streakSample.today === true, JSON.stringify(streakSample));
    const streakGrace = await cdp.evaluate(
      `(() => window.__lnReadingStreak(['2026-11-21', '2026-11-22'], [], new Date(2026, 10, 23, 12, 0, 0)))()`);
    check('当天未打卡时连续天数不归零',
      streakGrace && streakGrace.current === 2 && streakGrace.today === false, JSON.stringify(streakGrace));
    const streakDom = await cdp.evaluate(`(() => {
      const card = Array.from(document.querySelectorAll('#statsPanel .stat-card'))
        .find((el) => /阅读打卡/.test(el.textContent));
      return card ? {
        text: card.textContent,
        dots: card.querySelectorAll('.week-dots span').length,
        on: card.querySelectorAll('.week-dots span.on').length,
      } : null;
    })()`);
    check('统计页显示阅读打卡卡片与近 7 天',
      !!streakDom && /连续天数/.test(streakDom.text) && /近 7 天/.test(streakDom.text) &&
      streakDom.dots === 7, JSON.stringify(streakDom));
    const daysStored = await cdp.evaluate(`(() => JSON.parse(localStorage.getItem('yuc_ln_days_v1') || '[]'))()`);
    check('阅读动作写入打卡日期', Array.isArray(daysStored) && daysStored.length >= 1, JSON.stringify(daysStored));
    // 我的书评汇总（参考 StoryGraph / Goodreads 的书评列表）
    const reviewPure = await cdp.evaluate(`(() => window.__lnRecentReviews && window.__lnRecentReviews([
      { x: { i: 1, cn: '甲' }, e: { rv: '好', rvU: 20 } },
      { x: { i: 2, cn: '乙' }, e: { nt: '笔记', u: 30 } },
      { x: { i: 3, cn: '丙' }, e: { r: 8 } },
    ], 5).map((o) => [o.i, o.u, o.rv || o.nt]))()`);
    check('书评汇总只取有短评或笔记并按时更新排序',
      JSON.stringify(reviewPure) === '[["2",30,"笔记"],["1",20,"好"]]', JSON.stringify(reviewPure));
    const reviewDom = await cdp.evaluate(`(() => {
      const card = Array.from(document.querySelectorAll('#statsPanel .stat-card'))
        .find((el) => /我的书评/.test(el.textContent));
      if (!card) return null;
      return {
        items: card.querySelectorAll('.review-item').length,
        excerpt: card.querySelector('.review-excerpt')?.textContent || '',
        text: card.textContent,
        id: card.querySelector('.review-item')?.dataset.statsReview || '',
      };
    })()`);
    check('统计页汇总我的书评并显示摘要',
      !!reviewDom && reviewDom.items >= 1 && !!reviewDom.excerpt && /书评记录/.test(reviewDom.text),
      JSON.stringify(reviewDom && { n: reviewDom.items, excerpt: reviewDom.excerpt }));
    // 相似推荐理由（参考 Goodreads Readers also enjoyed / StoryGraph Browse similar books）
    const simPure = await cdp.evaluate(`(() => {
      const item = { i: 1, au: '甲', line: 'L1', tg: ['rom'], s: 8, kind: '' };
      const pool = [
        item,
        { i: 2, au: '甲', line: 'L2', tg: [], s: 5.5, kind: '' },
        { i: 3, au: '乙', line: 'L1', tg: [], s: 9, kind: '' },
        { i: 4, au: '丙', line: 'L3', tg: ['rom'], s: 8.4, kind: '' },
        { i: 5, au: '丁', line: 'L4', tg: ['hor'], s: 8.2, kind: '' },
        { i: 6, au: '甲', line: 'L1', tg: ['rom'], s: 8.1, kind: 'manga' },
      ];
      return window.__lnSimilar ? window.__lnSimilar(item, 4, pool).map((o) => [String(o.x.i), o.why]) : null;
    })()`);
    check('相似推荐按同作者/同书系/同题材排序并给出理由',
      JSON.stringify(simPure) === '[["2","同作者"],["3","同书系"],["4","同题材"],["5","评分接近"]]',
      JSON.stringify(simPure));
    const statsDesktopShot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    if (statsDesktopShot.result?.data) {
      await writeFile(path.join(SHOT_DIR, 'desktop-stats.png'), Buffer.from(statsDesktopShot.result.data, 'base64'));
    }
    await cdp.evaluate(`(() => { document.querySelector('#statsPanel .review-item').click(); })()`);
    await sleep(300);
    const reviewOpen = await cdp.evaluate(`(() => ({
      modal: !document.getElementById('modal').hidden,
      title: document.getElementById('modalTitle').textContent,
      hash: location.hash,
    }))()`);
    check('点击书评条目可打开对应详情',
      reviewOpen.modal && reviewOpen.title.length > 0 && /d=/.test(reviewOpen.hash),
      JSON.stringify(reviewOpen));
    await cdp.evaluate(`(() => document.getElementById('modalClose').click())()`);
    await sleep(200);
    // 想读队列（参考 Hikara 的 Up Next queue：没排序时用理由解释下一本读什么）
    const upPure = await cdp.evaluate(`(() => window.__lnUpNext && window.__lnUpNext([
      { i: 1, au: '甲', s: 7, v: 10 },
      { i: 2, au: '甲 / 乙', s: 9, v: 12 },
      { i: 3, au: '丙', s: 8.6, v: 9 },
      { i: 4, au: '丁', s: 7.2, v: 2 },
      { i: 5, au: '戊', s: 6.5, v: 8 },
      { i: 6, au: '己', s: 9.5, v: 5 }
    ], {
      1: { s: 'doing' },
      2: { s: 'want', t: 500 },
      3: { s: 'want', t: 400 },
      4: { s: 'want', t: 300 },
      5: { s: 'want', t: 200 },
      6: { s: 'done' }
    }, 3).map((o) => [String(o.x.i), o.why]))()`);
    check('想读队列按同作者在读/评分/短篇排序并给出理由',
      JSON.stringify(upPure) === '[["2","同作者在读"],["3","评分 8.6"],["4","短篇 · 2 卷"]]',
      JSON.stringify(upPure));
    await cdp.evaluate(`(() => { location.hash = 'tab=all'; })()`);
    await sleep(350);
    const upId = await cdp.evaluate(`(() => {
      const card = Array.from(document.querySelectorAll('#grid .card')).find((c) => {
        const btn = c.querySelector('[data-act="toggle"]');
        return btn && /加入/.test(btn.textContent);
      });
      if (!card) return '';
      card.querySelector('[data-act="toggle"]').click();
      return card.dataset.id;
    })()`);
    await sleep(350);
    await cdp.evaluate(`(() => { location.hash = 'tab=stats'; })()`);
    await sleep(400);
    const upDom = await cdp.evaluate(`(() => {
      const card = Array.from(document.querySelectorAll('#statsPanel .stat-card'))
        .find((el) => /想读队列/.test(el.textContent));
      return card ? {
        n: card.querySelectorAll('.upnext-item').length,
        why: card.querySelector('.upnext-why')?.textContent || '',
        start: card.querySelectorAll('.upnext-start').length,
      } : null;
    })()`);
    check('统计页显示想读队列并给出理由',
      !!upDom && upDom.n >= 1 && !!upDom.why && upDom.start === upDom.n, JSON.stringify(upDom));
    await cdp.evaluate(`(() => { document.querySelector('#statsPanel .upnext-start').click(); })()`);
    await sleep(400);
    const upStarted = await cdp.evaluate(`(() => ({
      s: (JSON.parse(localStorage.getItem('yuc_ln_mine_v1') || '{}')[${JSON.stringify(upId)}] || {}).s,
      n: document.querySelectorAll('#statsPanel .upnext-item').length,
      toast: document.getElementById('toast').textContent,
    }))()`);
    check('想读队列点「开始读」移到在读',
      upStarted.s === 'doing' && upStarted.n === 0 && /已标记为「在读」/.test(upStarted.toast),
      JSON.stringify(upStarted));
    await cdp.evaluate(`(() => { location.hash = 'tab=mine'; })()`);
    await sleep(300);
    check('hash 可直达统计以外的标签页',
      (await cdp.evaluate(`(() => document.querySelector('.tab.active')?.dataset.tab)()`)) === 'mine');

    // ---- 命令面板 ----
    await cdp.evaluate(`(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true })); })()`);
    await sleep(250);
    check('命令面板可打开',
      (await cdp.evaluate(`(() => !document.getElementById('palette').hidden)()`)) === true);
    await cdp.evaluate(`(() => {
      const el = document.getElementById('paletteInput');
      el.value = '导出';
      el.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await sleep(200);
    check('命令面板可搜索命令', (await count('.palette-item')) > 0);
    await cdp.evaluate(`(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))()`);
    await sleep(200);

    // ---- 设置与主题 ----
    await cdp.evaluate(`(() => document.querySelector('[data-more="settings"]').click())()`);
    await sleep(200);
    await click('#fontSeg [data-font="lg"]');
    check('设置字号生效', (await cdp.evaluate(`(() => document.documentElement.getAttribute('data-font'))()`)) === 'lg');
    await sleep(500);
    const offlineInfo = await cdp.evaluate(`(() => ({
      text: document.getElementById('offlineInfo').textContent,
      exposed: !!(window.__lnOfflineInfo && typeof window.__lnOfflineInfo.imgs === 'number'),
    }))()`);
    check('设置面板显示离线缓存占用',
      /封面 \d+ 张 · 占用/.test(offlineInfo.text) && offlineInfo.exposed, offlineInfo.text);
    // 安装引导 toast 可能延迟出现并覆盖清理提示，记录变更序列而不只读最后一条
    await cdp.evaluate(`(() => {
      window.__toastLog = [];
      if (window.__toastObserver) window.__toastObserver.disconnect();
      var el = document.getElementById('toast');
      window.__toastObserver = new MutationObserver(function () {
        var t = el.textContent || '';
        if (t) window.__toastLog.push(t);
      });
      window.__toastObserver.observe(el, { childList: true, subtree: true, characterData: true });
    })()`);
    await cdp.evaluate(`(() => document.getElementById('clearImgCache').click())()`);
    await sleep(700);
    const clearedCache = await cdp.evaluate(`(() => ({
      text: document.getElementById('offlineInfo').textContent,
      toasts: (window.__toastLog || []).slice(),
      imgs: window.__lnOfflineInfo ? window.__lnOfflineInfo.imgs : -1,
    }))()`);
    check('清理封面缓存后统计归零',
      clearedCache.imgs === 0 && /封面 0 张/.test(clearedCache.text) &&
      clearedCache.toasts.some((t) => /已清理 \d+ 张封面缓存/.test(t)),
      `${clearedCache.text} / ${clearedCache.toasts.join(' | ')}`);
    await click('#settingsClose');
    const themeBefore = await cdp.evaluate(`(() => document.documentElement.getAttribute('data-theme'))()`);
    await click('#themeBtn');
    const themeAfter = await cdp.evaluate(`(() => document.documentElement.getAttribute('data-theme'))()`);
    check('明暗主题可切换', themeBefore !== themeAfter, `${themeBefore} → ${themeAfter}`);

    // 浅色主题对比度审计：正文与次要文字相对卡片背景 ≥ 4.5:1
    const lightTheme = await cdp.evaluate(`(() => {
      const el = document.querySelector('.card .title') || document.querySelector('.card');
      const muted = document.querySelector('.card .meta') || el;
      const panel = document.querySelector('.card-link') || el;
      const parse = (c) => { const m = c.match(/[\\d.]+/g).map(Number); return { r: m[0], g: m[1], b: m[2], a: m.length > 3 ? m[3] : 1 }; };
      const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
        return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
      const ratio = (a, b) => { const l1 = lum(a), l2 = lum(b); return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05); };
      const bgOf = (node) => {
        let n = node;
        while (n && n !== document.documentElement) {
          const c = parse(getComputedStyle(n).backgroundColor);
          if (c.a > 0.5) return c;
          n = n.parentElement;
        }
        return parse(getComputedStyle(document.body).backgroundColor);
      };
      const bg = bgOf(panel);
      return {
        theme: document.documentElement.getAttribute('data-theme'),
        text: ratio(parse(getComputedStyle(el).color), bg),
        muted: ratio(parse(getComputedStyle(muted).color), bg),
      };
    })()`);
    check('浅色主题正文对比度达标', lightTheme.text >= 4.5, `${lightTheme.theme} ${lightTheme.text.toFixed(2)}:1`);
    check('浅色主题次要文字对比度达标', lightTheme.muted >= 4.5, `${lightTheme.theme} ${lightTheme.muted.toFixed(2)}:1`);
    const lightShot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    if (lightShot.result?.data) {
      await writeFile(path.join(SHOT_DIR, 'light.png'), Buffer.from(lightShot.result.data, 'base64'));
    }
    await click('#themeBtn');

    // ---- 云同步状态面板 ----
    await cdp.evaluate(`(() => {
      localStorage.removeItem('yuc_ln_gist_v1');
      localStorage.setItem('yuc_ln_synclog_v1', JSON.stringify([{
        t: Date.now(), ok: true, first: false, changed: 2, added: 0,
        remoteNewer: 2, localNewer: 0, sameTime: 0, volMerged: 0, tomb: 0,
      }]));
      localStorage.setItem('yuc_ln_dirty_v1', '3');
    })()`);
    await click('#syncBtn');
    await sleep(250);
    const syncPanel = await cdp.evaluate(`(() => ({
      open: !document.getElementById('syncModal').hidden,
      pill: document.getElementById('syncPill').textContent,
      dirty: document.getElementById('syncDirty').textContent,
      merge: document.getElementById('syncLastMerge').textContent,
      log: document.getElementById('syncLog').textContent,
    }))()`);
    check('云同步面板显示状态与最近合并',
      syncPanel.open && syncPanel.pill === '未配置' && syncPanel.dirty === '3' &&
      /远端较新 2/.test(syncPanel.merge) && /远端较新 2/.test(syncPanel.log),
      JSON.stringify(syncPanel));
    await cdp.evaluate(`(() => {
      document.getElementById('syncMask').click();
      localStorage.removeItem('yuc_ln_synclog_v1');
      localStorage.removeItem('yuc_ln_dirty_v1');
    })()`);
    await sleep(150);

    // ---- 空结果恢复 ----
    await click('.tab[data-tab="all"]');
    await setSearch('zzzz不存在的书名zzzz');
    check('无结果时展示空状态',
      (await cdp.evaluate(`(() => !document.getElementById('empty').hidden)()`)) === true);
    check('空状态提供放宽条件', (await count('#empty .btn')) > 0);
    await click('#resetFilters');
    check('清除筛选后恢复列表',
      (await cdp.evaluate(`(() => document.querySelectorAll('.card').length)()`)) > 0);

    // ---- 搜索联想 ----
    const sugTitle = await cdp.evaluate(`(() => {
      const x = (window.LN_DATA || []).find((v) => !v.c && !v.gn && !v.ver && (v.cn || v.n) &&
        String(v.cn || v.n).length >= 4 && String(v.cn || v.n).indexOf(' ') < 0);
      return x ? String(x.cn || x.n) : '';
    })()`);
    await cdp.evaluate(`(() => document.getElementById('search').focus())()`);
    await setSearch(sugTitle.slice(0, 2));
    await sleep(250);
    const sugPanel = await cdp.evaluate(`(() => {
      const box = document.getElementById('searchHist');
      const list = box.querySelector('.suglist');
      return {
        open: !box.hidden,
        sugmode: box.classList.contains('sugmode'),
        n: box.querySelectorAll('.sug').length,
        role: list ? list.getAttribute('role') : '',
        expanded: document.getElementById('search').getAttribute('aria-expanded'),
      };
    })()`);
    check('输入关键词浮出搜索联想', sugPanel.open && sugPanel.sugmode && sugPanel.n > 0,
      JSON.stringify(sugPanel));
    check('联想列表具备 listbox 语义', sugPanel.role === 'listbox' && sugPanel.expanded === 'true');
    check('搜索框声明组合框语义', (await cdp.evaluate(`(() => {
      const s = document.getElementById('search');
      return s.getAttribute('role') === 'combobox' && s.getAttribute('aria-autocomplete') === 'list';
    })()`)) === true);
    await cdp.evaluate(`(() => {
      document.getElementById('search').dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    })()`);
    await sleep(200);
    const sugActive = await cdp.evaluate(`(() => ({
      ad: document.getElementById('search').getAttribute('aria-activedescendant'),
      active: document.querySelectorAll('#searchHist .sug.active').length,
    }))()`);
    check('方向键高亮联想项', /^sugOpt\d+$/.test(sugActive.ad || '') && sugActive.active === 1,
      JSON.stringify(sugActive));
    const sugPick = await cdp.evaluate(`(() => {
      const el = document.querySelector('#searchHist .sug');
      if (!el) return '';
      el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      return el.dataset.q;
    })()`);
    await sleep(400);
    const sugAfter = await cdp.evaluate(`(() => ({
      q: document.getElementById('search').value,
      cards: document.querySelectorAll('.card').length,
      open: !document.getElementById('searchHist').hidden,
    }))()`);
    check('点击联想项回填并出结果',
      !!sugPick && sugAfter.q === sugPick && sugAfter.cards > 0 && sugAfter.open === false,
      JSON.stringify(sugAfter));
    await cdp.evaluate(`(() => {
      const s = document.getElementById('search');
      s.value = '';
      s.dispatchEvent(new Event('input', { bubbles: true }));
      s.blur();
    })()`);
    await sleep(300);

    // ---- 分享与 hash ----
    const hash = await cdp.evaluate(`(() => location.hash)()`);
    check('URL hash 同步筛选状态', /tab=/.test(hash), hash.slice(0, 60));
    check(`页脚版本为 v${PKG_VERSION}`, (await cdp.evaluate(`(() => document.querySelector('footer').textContent)()`)).includes(`v${PKG_VERSION}`));

    // ---- 数据边界 ----
    const noDate = await cdp.evaluate(`(() => {
      const x = (window.LN_DATA || []).find((v) => !v.d && !v.c && !v.gn && !v.ver);
      return x ? { id: String(x.i), name: x.cn || x.n } : null;
    })()`);
    if (noDate) {
      await cdp.evaluate(`(() => { location.hash = 'd=' + ${JSON.stringify(noDate.id)}; })()`);
      await sleep(300);
      check('无日期条目可打开详情', (await cdp.evaluate(`(() => !document.getElementById('modal').hidden)()`)) === true, noDate.name);
      check('缺失日期显示为未知',
        (await cdp.evaluate(`(() => document.getElementById('detailMeta').textContent)()`)).includes('未知'));
      await cdp.evaluate(`(() => { location.hash = ''; })()`);
      await sleep(200);
    } else {
      check('无日期条目可打开详情', true, '数据中无此类条目');
    }

    const partialDate = await cdp.evaluate(`(() => {
      const x = (window.LN_DATA || []).find((v) => v.d && String(v.d).length < 10 && !v.c && !v.gn && !v.ver);
      return x ? { id: String(x.i), d: String(x.d), name: x.cn || x.n } : null;
    })()`);
    if (partialDate) {
      await cdp.evaluate(`(() => { location.hash = 'd=' + ${JSON.stringify(partialDate.id)}; })()`);
      await sleep(300);
      const expected = partialDate.d.length === 4
        ? `${partialDate.d} 年`
        : `${partialDate.d.slice(0, 4)} 年 ${Number(partialDate.d.slice(5, 7))} 月`;
      const detailText = await cdp.evaluate(`(() => document.getElementById('detailMeta').textContent)()`);
      check('部分日期按精度显示', detailText.includes(expected), `${partialDate.d} → ${expected}（${partialDate.name}）`);
      await cdp.evaluate(`(() => { location.hash = ''; })()`);
      await sleep(200);
    } else {
      check('部分日期按精度显示', true, '数据中无部分日期条目');
    }

    const noVol = await cdp.evaluate(`(() => {
      const x = (window.LN_DATA || []).find((v) => !v.v && !v.c && !v.gn && !v.ver);
      return x ? { id: String(x.i) } : null;
    })()`);
    const zeroVolProgress = await cdp.evaluate(`(() => {
      const e = document.querySelector('.card[data-id="${noVol ? noVol.id : ''}"] .epin');
      return !!e;
    })()`);
    check('卷数未知的条目不显示进度输入', zeroVolProgress === false);

    // ---- 本地存储命名 ----
    const keys = await cdp.evaluate(`(() => Object.keys(localStorage))()`);
    check('本地存储全部使用 yuc_ln_ 前缀',
      keys.length > 0 && keys.every((k) => k.startsWith('yuc_ln_')), keys.join(','));

    // ---- PWA ----
    const manifest = await (await fetch(`http://127.0.0.1:${PORT}/manifest.webmanifest`)).json();
    check('manifest 名称正确', manifest.name.includes('轻小说'), manifest.name);
    check(`manifest 版本为 ${PKG_VERSION}`, manifest.version === PKG_VERSION);
    check('manifest 声明稳定 id', manifest.id === './', String(manifest.id));
    const shortcuts = Array.isArray(manifest.shortcuts) ? manifest.shortcuts : [];
    check('manifest 提供桌面快捷方式', shortcuts.length >= 3, `${shortcuts.length} 个`);
    check('快捷方式覆盖我的阅读与统计',
      shortcuts.some((s) => /我的阅读/.test(s.name)) && shortcuts.some((s) => /统计/.test(s.name)),
      shortcuts.map((s) => s.name).join(' / '));
    check('快捷方式指向可用 hash 路由',
      shortcuts.length > 0 && shortcuts.every((s) => /^\.\/#tab=(all|mine|stats)(&|$)/.test(String(s.url))),
      shortcuts.map((s) => s.url).join(' '));
    const pageVersion = await cdp.evaluate(`(() => document.querySelector('meta[name="version"]').getAttribute('content') )()`);
    check('页面 meta 版本与 manifest 一致', pageVersion === manifest.version, `${pageVersion} / ${manifest.version}`);
    const swReg = await cdp.evaluate(`(async () => {
      for (let i = 0; i < 40; i += 1) {
        const reg = await navigator.serviceWorker.getRegistration();
        if (reg) return { reg: true, fn: !!(window.__lnSwReg && typeof window.__lnSwReg.update === 'function') };
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return { reg: false, fn: false };
    })()`);
    check('SW 注册支持主动更新检查', swReg.reg === true && swReg.fn === true, JSON.stringify(swReg));
    const swTxt = await (await fetch(`http://127.0.0.1:${PORT}/sw.js`)).text();
    check('Service Worker 缓存名独立', /yuc-ln-shell-v\d+/.test(swTxt) && !/yuc-anime-|yuc-gl-/.test(swTxt));
    check('Service Worker 不预缓存卷包', !swTxt.includes('light-novels-volumes'));
    check('Service Worker 不预缓存扩展包', !swTxt.includes('light-novels-rn'));
    check('Service Worker 不预缓存剩余核心', !swTxt.includes('light-novels-rest'));
    check('Service Worker 缓存轻量核心与详情包',
      swTxt.includes('data/light-novels-lite.js') && swTxt.includes('data/light-novels-extra.js'));
    check('封面缓存带数量上限清理', swTxt.includes('trimImageCache') && swTxt.includes('IMG_LIMIT'));
    check('图标文件存在', existsSync(path.join(ROOT, 'icons/icon-512.png')) && existsSync(path.join(ROOT, 'icons/icon-180.png')));
    const indexTxt = await (await fetch(`http://127.0.0.1:${PORT}/index.html`)).text();
    check('包含安装引导', indexTxt.includes('beforeinstallprompt') && indexTxt.includes('添加到主屏幕'));
    check('安装完成后收起引导', indexTxt.includes("addEventListener('appinstalled'"));
    check('帮助面板写明高级搜索语法', indexTxt.includes('作者:米泽穗信') && indexTxt.includes('出版社:KADOKAWA'));
    check('卡片启用 content-visibility',
      (await cdp.evaluate(`(() => getComputedStyle(document.querySelector('.card')).contentVisibility)()`)) === 'auto');
    check('卡片记录已渲染尺寸减少滚动跳动', indexTxt.includes('contain-intrinsic-size: auto'));
    check('统计标签入口存在', (await count('.tab[data-tab="stats"]')) === 1);

    // ---- 无障碍 ----
    check('存在跳过头部链接', (await count('#skipLink')) === 1);
    check('搜索框有可访问名称',
      !!(await cdp.evaluate(`(() => document.getElementById('search').getAttribute('aria-label'))()`)));
    check('弹窗具备 aria-modal',
      (await cdp.evaluate(`(() => document.querySelector('.modal-panel').getAttribute('aria-modal'))()`)) === 'true');
    check('卡片可通过键盘聚焦',
      (await cdp.evaluate(`(() => { const el = document.querySelector('.card-link[tabindex="0"]'); return !!el; })()`)) === true);
    const liveRegion = await cdp.evaluate(`(() => {
      const el = document.getElementById('resultAnnounce');
      return el ? { role: el.getAttribute('role'), live: el.getAttribute('aria-live'), atomic: el.getAttribute('aria-atomic') } : null;
    })()`);
    check('结果数通过礼貌级 live region 播报',
      !!liveRegion && liveRegion.role === 'status' && liveRegion.live === 'polite' && liveRegion.atomic === 'true',
      JSON.stringify(liveRegion));
    await cdp.evaluate(`(() => {
      const s = document.getElementById('search');
      s.value = '播报测试';
      s.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await sleep(900);
    const announced = await cdp.evaluate(`(() => document.getElementById('resultAnnounce').textContent)()`);
    check('筛选变化后播报结果数', announced.includes('筛选后') && announced.includes('条全库搜索结果'), announced);
    await cdp.evaluate(`(() => {
      const s = document.getElementById('search');
      s.value = '';
      s.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await sleep(300);
    check('当前视图标记 aria-current',
      (await cdp.evaluate(`(() => { const t = document.querySelector('.tab.active'); return t ? t.getAttribute('aria-current') : ''; })()`)) === 'page');
    await cdp.evaluate(`(() => { location.hash = 'd=' + ${JSON.stringify(pick.id)}; })()`);
    await sleep(250);
    const bgInert = await cdp.evaluate(`(() => ({
      open: !document.getElementById('modal').hidden,
      main: document.querySelector('main').hasAttribute('inert'),
      header: document.querySelector('header').hasAttribute('inert'),
    }))()`);
    check('详情打开时背景区域 inert',
      bgInert.open && bgInert.main && bgInert.header, JSON.stringify(bgInert));
    await cdp.evaluate(`(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))()`);
    await sleep(250);
    check('Esc 关闭详情并归还焦点',
      (await cdp.evaluate(`(() => document.getElementById('modal').hidden)()`)) === true);
    check('关闭详情后解除背景 inert',
      (await cdp.evaluate(`(() => !document.querySelector('main').hasAttribute('inert'))()`)) === true);
    await cdp.evaluate(`(() => { location.hash = ''; })()`);

    // ---- 系列卡片「子卷」入口 ----
    const volEntry = await cdp.evaluate(`(() => {
      const b = document.querySelector('.card [data-act="vols"]');
      return b ? { id: b.closest('.card').dataset.id } : null;
    })()`);
    check('系列卡片显示查看子卷入口', !!volEntry);
    if (volEntry) {
      await cdp.evaluate(`(() => { const b = document.querySelector('.card [data-act="vols"]'); if (b) b.click(); })()`);
      for (let i = 0; i < 40; i += 1) {
        if (await cdp.evaluate("!!document.querySelector('[data-vol-expand]')")) break;
        await sleep(150);
      }
      const volEntryOpen = await cdp.evaluate(`(() => ({
        open: !document.getElementById('modal').hidden,
        expanded: document.querySelector('[data-vol-expand]') ? document.querySelector('[data-vol-expand]').getAttribute('aria-expanded') : '',
      }))()`);
      check('卡片子卷入口直接展开卷清单', volEntryOpen.open && volEntryOpen.expanded === 'true', JSON.stringify(volEntryOpen));
      await cdp.evaluate(`(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))()`);
      await sleep(250);
      await cdp.evaluate(`(() => { location.hash = ''; })()`);
      await sleep(200);
    }

    // ---- 系列一键加入全部子卷 ----
    const seriesPick = await cdp.evaluate(`(() => {
      const s = window.LN_DATA.find((x) => x.sv && Array.isArray(x.ch) && x.ch.length >= 3 && (!x.v || x.v >= 3));
      return s ? { id: String(s.i), n: s.ch.length } : null;
    })()`);
    const mineBeforeSeries = await cdp.evaluate(`localStorage.getItem('yuc_ln_mine_v1') || '{}'`);
    await cdp.evaluate(`(() => { location.hash = 'd=' + ${JSON.stringify(seriesPick.id)}; })()`);
    await sleep(400);
    const addChildrenBtn = await cdp.evaluate(`(() => {
      const b = document.getElementById('detailAddChildren');
      return { hidden: b.hidden, disabled: b.disabled, text: b.textContent };
    })()`);
    check('系列详情显示一键加入子卷',
      addChildrenBtn.hidden === false && /加入/.test(addChildrenBtn.text), addChildrenBtn.text);
    await cdp.evaluate(`document.getElementById('detailAddChildren').click()`);
    await sleep(500);
    const seriesAdded = await cdp.evaluate(`(() => {
      const map = JSON.parse(localStorage.getItem('yuc_ln_mine_v1') || '{}');
      const s = window.LN_DATA.find((x) => String(x.i) === ${JSON.stringify(seriesPick.id)});
      const b = document.getElementById('detailAddChildren');
      return { inMap: s.ch.filter((cid) => map[String(cid)]).length, total: s.ch.length, text: b.textContent, disabled: b.disabled };
    })()`);
    check('一键加入全部子卷', seriesAdded.inMap === seriesAdded.total,
      `${seriesAdded.inMap}/${seriesAdded.total}`);
    check('全部加入后按钮置为已加入',
      seriesAdded.disabled === true && /已加入/.test(seriesAdded.text), seriesAdded.text);

    // ---- 系列卷清单与自动进度 ----
    const volBox = await cdp.evaluate(`(() => {
      const b = document.getElementById('detailVolumes');
      return { hidden: b.hidden, text: b.textContent };
    })()`);
    check('系列详情显示卷清单', volBox.hidden === false && /卷清单/.test(volBox.text), volBox.text.slice(0, 40));
    await cdp.evaluate(`(() => { const b = document.querySelector('[data-vol-expand]'); if (b) b.click(); })()`);
    for (let i = 0; i < 60; i += 1) {
      if ((await cdp.evaluate("document.querySelectorAll('.vol-row').length")) > 0) break;
      await sleep(150);
    }
    const volRows = await cdp.evaluate(`(() => ({
      rows: document.querySelectorAll('.vol-row').length,
      total: ${JSON.stringify(seriesPick.n)},
    }))()`);
    check('卷清单展开并加载卷目', volRows.rows === volRows.total, `${volRows.rows}/${volRows.total}`);
    const volCover = await cdp.evaluate(`(() => {
      const img = document.querySelector('.vol-row img');
      return img ? img.getAttribute('src') : '';
    })()`);
    check('卷清单显示封面缩略图', /\/r\/100\//.test(volCover), volCover);
    await cdp.evaluate(`(() => { const r = document.querySelector('.vol-row'); if (r) r.click(); })()`);
    await sleep(300);
    await cdp.evaluate(`(() => { const b = document.querySelector('[data-vol-next]'); if (b) b.click(); })()`);
    await sleep(300);
    const expectedVolText = '已读 2 / ' + seriesPick.n;
    const volProgress = await cdp.evaluate(`(() => {
      const map = JSON.parse(localStorage.getItem('yuc_ln_mine_v1') || '{}');
      const s = map[${JSON.stringify(seriesPick.id)}];
      const box = document.getElementById('detailVolumes');
      return {
        status: s && s.s,
        vol: s && s.vol,
        done: document.querySelectorAll('.vol-row.done').length,
        text: box ? box.textContent : '',
      };
    })()`);
    check('勾选卷与下一卷自动更新系列进度',
      volProgress.status === 'doing' && volProgress.vol === 2 && volProgress.done === 2 &&
      volProgress.text.includes(expectedVolText),
      JSON.stringify(volProgress));

    // 还原阅读记录，避免影响后续移动端用例
    await cdp.evaluate(`localStorage.setItem('yuc_ln_mine_v1', ${JSON.stringify(mineBeforeSeries)})`);
    await cdp.send('Page.reload', { ignoreCache: true });
    for (let i = 0; i < 80; i += 1) {
      if ((await cdp.evaluate("document.querySelectorAll('.card').length").catch(() => 0)) > 0) break;
      await sleep(150);
    }
    await cdp.evaluate(`(() => { location.hash = ''; })()`);
    await sleep(200);

    // ---- 本地纠错与别名 ----
    const editPick = await cdp.evaluate(`(() => {
      const s = (window.LN_DATA || []).find((x) => !x.rn && !x.ver && !x.c && !x.gn && x.n);
      return s ? { id: String(s.i), au: s.au || '', n: s.n } : null;
    })()`);
    await cdp.evaluate(`(() => { location.hash = 'd=' + ${JSON.stringify(editPick.id)}; })()`);
    await sleep(450);
    // 等详情包到位：作者 / 出版社等上游字段随包加载，恢复上游才有值可回。
    // 等「作者的字段真正到位」而不是只等 ready 标志，见 waitAuthor 的注释。
    const extraOk = await waitAuthor(editPick.id);
    if (!extraOk) {
      check('详情包已就绪（本地纠错的前置条件）', false, '等了 18 秒仍未拿到作者字段');
    }
    // editPick.au 是在 extra 包到位之前取的，那时可能还是空串；「恢复上游」要在恢复后
    // 拿它做比较基准，基准本身为空会让断言永远不可能通过。这里以就绪后的真实值为准。
    editPick.au = await cdp.evaluate(`(() => {
      const x = (window.LN_DATA || []).find((v) => String(v.i) === ${JSON.stringify(editPick.id)});
      return x ? String(x.au || '') : '';
    })()`);
    await click('#detailEdit');
    await sleep(200);
    const metaPanel = await cdp.evaluate(`(() => {
      const box = document.getElementById('detailMetaEdit');
      return { hidden: box.hidden, fields: box.querySelectorAll('input[data-meta-field]').length };
    })()`);
    check('详情提供本地纠错面板', metaPanel.hidden === false && metaPanel.fields === 8,
      JSON.stringify(metaPanel));
    const metaSaved = await cdp.evaluate(`(() => {
      const set = (k, v) => { document.querySelector('[data-meta-field="' + k + '"]').value = v; };
      set('au', '本地作者甲');
      set('al', '测试别名, 另一个别名');
      document.querySelector('#detailMetaEdit [data-meta-act="save"]').click();
      const rec = JSON.parse(localStorage.getItem('yuc_ln_meta_v1') || '{}')[${JSON.stringify(editPick.id)}] || null;
      return {
        rec: rec,
        metaText: document.getElementById('detailMeta').textContent,
        badge: !!document.querySelector('#detailMeta .chip.local'),
        editHidden: document.getElementById('detailMetaEdit').hidden,
      };
    })()`);
    check('保存纠错覆盖详情并写入本机',
      !!metaSaved.rec && metaSaved.rec.au === '本地作者甲' &&
      Array.isArray(metaSaved.rec.al) && metaSaved.rec.al.length === 2 &&
      metaSaved.metaText.includes('本地作者甲') && metaSaved.badge && metaSaved.editHidden,
      JSON.stringify({ rec: metaSaved.rec, badge: metaSaved.badge, hidden: metaSaved.editHidden }));
    await cdp.evaluate(`(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))()`);
    await sleep(250);
    await setSearch('测试别名');
    const aliasSearch = await cdp.evaluate(`(() => ({
      cards: [...document.querySelectorAll('.card')].map((c) => c.dataset.id),
    }))()`);
    check('本地别名参与搜索', aliasSearch.cards.includes(editPick.id),
      JSON.stringify(aliasSearch.cards).slice(0, 120));
    await setSearch('');

    // ---- 保存本地纠错后，新值必须立刻可搜、旧值必须立刻失效 ----
    // 回归 normCache 键设计：缓存曾以「条目 ID + 字段名」为键，而 applyMetaOverride
    // 会原地改写 cn / au / al 却不失效缓存，于是保存后搜新名字 0 条、搜旧名字仍能命中。
    // 这个 bug 时有时无（索引包加载会顺带 clear 一次，谁先到决定结果），正是它让
    // 「本地别名参与搜索」随机失败。这里显式构造顺序：先搜一次灌满缓存，再改再搜。
    // 判据必须同时验两侧——只看「新名字能搜到」会漏掉「旧名字还残留」的一半缺陷。
    const cacheFresh = await cdp.evaluate(`(async () => {
      const A = window.__lnAudit;
      // 必须避开 editPick：那条的纠错在后续断言里还要用（「纠错与别名刷新后仍生效」），
      // 探针若改到同一条并复位，会把它的纠错一起删掉 —— 两次运行挂一次的来源之一。
      const avoid = ${JSON.stringify(editPick.id)};
      const t = (window.LN_DATA || []).find(
        (x) => x.cn && !x.c && !x.gn && !x.ver && String(x.i) !== avoid,
      );
      if (!t) return { skip: true };
      const id = String(t.i);
      const oldCn = String(t.cn);
      // 1) 先搜旧名，把该条 cn 的归一化结果灌进缓存
      const beforeHit = A.find(oldCn, false).length;
      // 2) 打开详情走真实 UI，把中文名改成原库不存在的新值
      location.hash = 'd=' + id;
      await new Promise((r) => setTimeout(r, 500));
      document.getElementById('detailEdit').click();
      await new Promise((r) => setTimeout(r, 300));
      const input = document.querySelector('[data-meta-field="cn"]');
      if (!input) return { skip: true };
      input.value = '缓存探针改名QQQ';
      document.querySelector('#detailMetaEdit [data-meta-act="save"]').click();
      await new Promise((r) => setTimeout(r, 500));
      const itemNow = A.item(id);
      return {
        skip: false,
        id,
        beforeHit,
        cnAfterSave: itemNow ? itemNow.cn : null,
        hitNew: A.find('缓存探针改名QQQ', false).length,
        hitOld: A.find(oldCn, false).length,
      };
    })()`);
    if (cacheFresh.skip) {
      check('保存纠错后新值立即可搜（缓存已失效）', false, '筛不出可改名的条目，用例为 0');
    } else {
      check('保存纠错后新值立即可搜（缓存已失效）',
        cacheFresh.cnAfterSave === '缓存探针改名QQQ' &&
        cacheFresh.hitNew >= 1 && cacheFresh.hitOld === 0,
        JSON.stringify(cacheFresh));
    }
    // 复位：保存后 metaEditing 已置 false，面板 innerHTML 被清空，reset 按钮此时并不存在。
    // 所以不能靠点「恢复上游」，必须重新打开面板再点；否则探针的纠错会残留在 localStorage 里，
    // 让后续依赖纠错计数的断言对不上（实测每两次就挂一次）。
    await cdp.evaluate(`(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); })()`);
    await sleep(250);
    const probeReset = cacheFresh.skip ? { clicked: false, stillThere: false } : await cdp.evaluate(`(async () => {
      location.hash = 'd=' + ${JSON.stringify(cacheFresh.id || '')};
      await new Promise((r) => setTimeout(r, 450));
      document.getElementById('detailEdit').click();
      await new Promise((r) => setTimeout(r, 300));
      const b = document.querySelector('#detailMetaEdit [data-meta-act="reset"]');
      if (!b) return { clicked: false };
      b.click();
      await new Promise((r) => setTimeout(r, 300));
      const map = JSON.parse(localStorage.getItem('yuc_ln_meta_v1') || '{}');
      return { clicked: true, stillThere: !!map[${JSON.stringify(cacheFresh.id || '')}] };
    })()`);
    if (!cacheFresh.skip) {
      check('探针纠错已清理（不污染后续断言）',
        probeReset.clicked === true && probeReset.stillThere === false,
        JSON.stringify(probeReset));
    }
    await cdp.evaluate(`(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      location.hash = '';
    })()`);
    await sleep(400);
    await cdp.send('Page.reload', { ignoreCache: true });
    for (let i = 0; i < 80; i += 1) {
      if ((await cdp.evaluate("document.querySelectorAll('.card').length").catch(() => 0)) > 0) break;
      await sleep(150);
    }
    const metaReload = await cdp.evaluate(`(() => {
      const x = (window.LN_DATA || []).find((v) => String(v.i) === ${JSON.stringify(editPick.id)});
      return { au: x ? x.au || '' : '', al: x && x.al ? x.al : [], mo: !!(x && x.mo) };
    })()`);
    check('纠错与别名刷新后仍生效',
      metaReload.au === '本地作者甲' && metaReload.al.includes('测试别名') && metaReload.mo === true,
      JSON.stringify(metaReload));
    await cdp.evaluate(`(() => { location.hash = 'd=' + ${JSON.stringify(editPick.id)}; })()`);
    await sleep(450);
    // 等详情包到位：作者 / 出版社等上游字段随包加载，恢复上游才有值可回。
    // 等「作者的字段真正到位」而不是只等 ready 标志，见 waitAuthor 的注释。
    const extraOkReset = await waitAuthor(editPick.id);
    if (!extraOkReset) {
      check('详情包已就绪（恢复上游的前置条件）', false, '等了 18 秒仍未拿到作者字段');
    }
    await click('#detailEdit');
    await sleep(200);
    await click('#detailMetaEdit [data-meta-act="reset"]');
    await sleep(300);
    const metaReset = await cdp.evaluate(`(() => {
      const x = (window.LN_DATA || []).find((v) => String(v.i) === ${JSON.stringify(editPick.id)});
      return {
        rec: JSON.parse(localStorage.getItem('yuc_ln_meta_v1') || '{}')[${JSON.stringify(editPick.id)}] || null,
        au: x ? x.au || '' : null,
        badge: !!document.querySelector('#detailMeta .chip.local'),
        metaText: document.getElementById('detailMeta').textContent,
      };
    })()`);
    check('恢复上游清除覆盖与别名',
      metaReset.rec === null && metaReset.au === editPick.au && !metaReset.badge &&
      !metaReset.metaText.includes('测试别名'),
      JSON.stringify(metaReset));
    await cdp.evaluate(`(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))()`);
    await sleep(200);
    await cdp.evaluate(`(() => { location.hash = ''; })()`);
    await sleep(200);

    // ---- 阅读格式与藏书 ----
    const fmtPick = await cdp.evaluate(`(() => {
      const s = (window.LN_DATA || []).find((x) => !x.rn && !x.ver && !x.c && !x.gn);
      return s ? { id: String(s.i) } : null;
    })()`);
    await cdp.evaluate(`(() => { location.hash = 'd=' + ${JSON.stringify(fmtPick.id)}; })()`);
    await sleep(450);
    await cdp.evaluate(`(() => {
      const b = document.getElementById('detailToggle');
      if (b && b.textContent.indexOf('加入') >= 0) b.click();
    })()`);
    await sleep(300);
    await click('#detailFormat [data-fmt="ebook"]');
    await click('#detailFormat [data-owned]');
    const fmtSaved = await cdp.evaluate(`(() => {
      const e = JSON.parse(localStorage.getItem('yuc_ln_mine_v1') || '{}')[${JSON.stringify(fmtPick.id)}] || null;
      const box = document.getElementById('detailFormat');
      return {
        fm: e && e.fm, ow: e && e.ow, mu: e && e.mu,
        hidden: box.hidden,
        activeFmt: !!box.querySelector('[data-fmt="ebook"].active'),
        own: !!box.querySelector('[data-owned].active'),
      };
    })()`);
    check('详情可标记格式与藏书',
      !!fmtSaved && fmtSaved.fm === 'ebook' && fmtSaved.ow === 1 && fmtSaved.mu > 0 &&
      fmtSaved.hidden === false && fmtSaved.activeFmt && fmtSaved.own,
      JSON.stringify(fmtSaved));
    await cdp.evaluate(`(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))()`);
    await sleep(250);
    await cdp.evaluate(`(() => { location.hash = 'tab=mine'; })()`);
    await sleep(400);
    await cdp.evaluate(`(() => {
      const s = document.getElementById('fmtFilter');
      s.value = 'ebook';
      s.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await sleep(400);
    const fmtFiltered = await cdp.evaluate(`(() => {
      const map = JSON.parse(localStorage.getItem('yuc_ln_mine_v1') || '{}');
      const expected = Object.keys(map).filter((id) => map[id].fm === 'ebook');
      const cards = [...document.querySelectorAll('.card')].map((c) => c.dataset.id);
      return { cards: cards, expected: expected };
    })()`);
    check('我的阅读可按格式筛选',
      fmtFiltered.expected.length > 0 && fmtFiltered.cards.length === fmtFiltered.expected.length &&
      fmtFiltered.cards.every((id) => fmtFiltered.expected.includes(id)),
      JSON.stringify({ cards: fmtFiltered.cards.length, expected: fmtFiltered.expected.length }));
    await click('#ownedBtn');
    await sleep(300);
    const ownedFiltered = await cdp.evaluate(`(() => {
      const map = JSON.parse(localStorage.getItem('yuc_ln_mine_v1') || '{}');
      const expected = Object.keys(map).filter((id) => map[id].fm === 'ebook' && map[id].ow);
      const cards = [...document.querySelectorAll('.card')].map((c) => c.dataset.id);
      return {
        cards: cards, expected: expected,
        pressed: document.getElementById('ownedBtn').getAttribute('aria-pressed'),
      };
    })()`);
    check('只看藏书收窄到已标记条目',
      ownedFiltered.pressed === 'true' && ownedFiltered.cards.length === ownedFiltered.expected.length &&
      ownedFiltered.cards.every((id) => ownedFiltered.expected.includes(id)),
      JSON.stringify(ownedFiltered));
    // 还原筛选，避免影响后续统计与移动端用例
    await cdp.evaluate(`(() => {
      const s = document.getElementById('fmtFilter');
      s.value = 'all';
      s.dispatchEvent(new Event('change', { bubbles: true }));
      document.getElementById('ownedBtn').click();
    })()`);
    await sleep(300);
    await cdp.evaluate(`(() => { location.hash = 'tab=stats'; })()`);
    await sleep(500);
    const fmtStats = await cdp.evaluate(`(() => {
      const panel = document.getElementById('statsPanel');
      return {
        text: panel ? panel.textContent : '',
        cards: document.querySelectorAll('#statsPanel .stat-card').length,
      };
    })()`);
    check('统计页显示藏书与格式',
      fmtStats.text.includes('藏书与格式') && fmtStats.text.includes('电子') && fmtStats.cards >= 10,
      `cards=${fmtStats.cards}`);
    await cdp.evaluate(`(() => { location.hash = 'tab=all'; })()`);
    await sleep(300);

    // ---- 移动端 375×812 ----
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 375, height: 812, deviceScaleFactor: 2, mobile: true,
    });
    await cdp.send('Page.reload', { ignoreCache: false });
    await sleep(1500);
    const mobile = await cdp.evaluate(`(() => {
      const doc = document.documentElement;
      const btns = [...document.querySelectorAll('.btn, .tab, .pill')];
      const heights = btns.map((b) => b.getBoundingClientRect().height).filter((n) => n > 0);
      return {
        overflow: doc.scrollWidth - doc.clientWidth,
        minBtn: heights.length ? Math.min(...heights) : 0,
        filterVisible: !!document.getElementById('filterToggle').offsetParent,
      };
    })()`);
    check('移动端无横向滚动', mobile.overflow <= 1, `${mobile.overflow}px`);
    check('移动端筛选入口可见', mobile.filterVisible === true);
    check('移动端触控目标不小于 32px', mobile.minBtn >= 32, `${mobile.minBtn}px`);
    await click('#filterToggle');
    check('移动端筛选抽屉可打开',
      (await cdp.evaluate(`(() => !document.getElementById('filterSheet').hidden)()`)) === true);
    const sheetTrap = await cdp.evaluate(`(() => {
      const panel = document.getElementById('filterPanel');
      const nodes = [...document.querySelectorAll('#filterSheet button, #filterSheet a[href], #filterSheet input, #filterSheet select, #filterSheet textarea, #filterSheet [tabindex]:not([tabindex="-1"])')]
        .filter((n) => !n.disabled && n.offsetParent !== null);
      if (nodes.length < 2) return { nodes: nodes.length };
      const first = nodes[0];
      nodes[nodes.length - 1].focus();
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
      return {
        nodes: nodes.length,
        inPanel: panel.contains(document.activeElement),
        wrapped: document.activeElement === first,
      };
    })()`);
    check('筛选抽屉 Tab 焦点在面板内循环',
      sheetTrap.nodes >= 2 && sheetTrap.inPanel && sheetTrap.wrapped, JSON.stringify(sheetTrap));
    const sheetShot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    if (sheetShot.result?.data) {
      await writeFile(path.join(SHOT_DIR, 'mobile.png'), Buffer.from(sheetShot.result.data, 'base64'));
    }
    await click('#filterDone');
    const sheetFocus = await cdp.evaluate(`(() => ({
      hidden: document.getElementById('filterSheet').hidden,
      focus: document.activeElement ? document.activeElement.id : '',
    }))()`);
    check('关闭筛选抽屉归还焦点',
      sheetFocus.hidden && sheetFocus.focus === 'filterToggle', JSON.stringify(sheetFocus));
    await cdp.send('Emulation.clearDeviceMetricsOverride');

    // ---- 移动端统计页与不同宽度 ----
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 375, height: 812, deviceScaleFactor: 2, mobile: true,
    });
    await cdp.evaluate(`(() => { location.hash = 'tab=stats'; })()`);
    await sleep(400);
    const mobileStats = await cdp.evaluate(`(() => ({
      overflow: document.documentElement.scrollWidth - window.innerWidth,
      cards: document.querySelectorAll('#statsPanel .stat-card').length,
    }))()`);
    check('移动端统计页无横向滚动', mobileStats.overflow <= 1, `${mobileStats.overflow}px`);
    check('移动端统计页渲染卡片', mobileStats.cards >= 4, String(mobileStats.cards));
    const statsShot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    if (statsShot.result?.data) {
      await writeFile(path.join(SHOT_DIR, 'mobile-stats.png'), Buffer.from(statsShot.result.data, 'base64'));
    }
    await cdp.evaluate(`(() => { location.hash = 'tab=all'; })()`);
    await sleep(300);

    for (const width of [390, 430]) {
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width, height: 900, deviceScaleFactor: 2, mobile: true,
      });
      await sleep(250);
      const overflow = await cdp.evaluate(`(() => document.documentElement.scrollWidth - window.innerWidth)()`);
      check(`移动端 ${width}px 无横向滚动`, overflow <= 1, `${overflow}px`);
    }
    await cdp.send('Emulation.clearDeviceMetricsOverride');

    // ---- RanobeDB 扩展书目 ----
    // 先重载，避免前面移动端抽屉与筛选状态影响按钮点击与计数
    await reload();
    await click('.tab[data-tab="all"]');
    await setSearch('');
    await sleep(300);
    const rnBefore = await cdp.evaluate(`(() => ({
      count: Number(document.getElementById('resultCount').textContent),
      script: !!document.querySelector('script[src*="light-novels-rn"]'),
      ready: window.__LN_RN_READY === true,
    }))()`);
    await click('#showRnBtn');
    await sleep(500);
    const rnClick = await cdp.evaluate(`(async () => ({
      pressed: document.getElementById('showRnBtn').getAttribute('aria-pressed'),
      script: !!document.querySelector('script[src*="light-novels-rn"]'),
      src: document.querySelector('script[src*="light-novels-rn"]')?.src || '',
      fetchStatus: await fetch('data/light-novels-rn.js').then((r) => r.status).catch((e) => 'ERR:' + e.message),
      ready: window.__LN_RN_READY === true,
    }))()`);
    if (!rnClick.ready) {
      await cdp.evaluate('window.__lnLoadRn()');
      await sleep(2500);
    }
    for (let i = 0; i < 60; i += 1) {
      if (await cdp.evaluate('window.__LN_RN_READY === true')) break;
      await sleep(150);
    }
    const rnAfter = await cdp.evaluate(`(() => ({
      count: Number(document.getElementById('resultCount').textContent),
      expected: (window.LN_DATA || []).filter((x) => !x.c && !x.gn && !x.ver).length,
      meta: window.LN_RN_META || {},
      ready: window.__LN_RN_READY === true,
      pressed: document.getElementById('showRnBtn').getAttribute('aria-pressed'),
      sample: (window.LN_DATA || []).find((x) => x.rn) || null,
    }))()`);
    check('扩展书目默认隐藏并按需加载',
      rnBefore.script === false && rnBefore.ready === false &&
      rnAfter.meta.count > 8000 && rnAfter.count === rnAfter.expected && rnAfter.pressed === 'true',
      JSON.stringify({
        before: rnBefore.count, after: rnAfter.count, expected: rnAfter.expected,
        meta: rnAfter.meta.count, ready: rnAfter.ready, scriptBefore: rnBefore.script,
        click: rnClick,
      }));
    await click('#showRnBtn');
    const rnOff = await cdp.evaluate(`(() => ({
      count: Number(document.getElementById('resultCount').textContent),
      pressed: document.getElementById('showRnBtn').getAttribute('aria-pressed'),
    }))()`);
    check('关闭扩展书目后恢复原列表',
      rnOff.count === rnBefore.count && rnOff.pressed === 'false', `${rnOff.count}/${rnBefore.count}`);

    await click('#showRnBtn');
    const rnDetail = await cdp.evaluate(`(async () => {
      const x = (window.LN_DATA || []).find((v) => v.rn);
      if (!x) return { ok: false };
      const el = document.getElementById('search');
      el.value = x.n;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 400));
      const card = document.querySelector('.card[data-id="' + x.i + '"]');
      if (!card) return { ok: false, reason: 'no-card' };
      card.click();
      await new Promise((r) => setTimeout(r, 400));
      const link = document.getElementById('detailLink');
      return {
        ok: true,
        title: document.getElementById('modalTitle').textContent,
        href: link.href,
        label: link.textContent,
        source: document.getElementById('detailMeta').textContent,
      };
    })()`);
    check('扩展书目详情标注来源并链接 RanobeDB',
      rnDetail.ok === true && /ranobedb\.org\/series\//.test(rnDetail.href) &&
      rnDetail.label === 'RanobeDB' && rnDetail.source.includes('扩展书目'), JSON.stringify(rnDetail));
    await click('#modalClose');
    // 扩展条目补了 Bangumi 中文名后，应能用中文名直接搜到
    const cnSearch = await cdp.evaluate(`(async () => {
      const x = (window.LN_DATA || []).find((v) => v.rn && v.cn);
      if (!x) return { skip: true };
      const el = document.getElementById('search');
      el.value = x.cn;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 500));
      const card = document.querySelector('.card[data-id="' + x.i + '"]');
      return {
        skip: false,
        cn: x.cn,
        ja: x.n,
        hit: !!card,
        count: Number(document.getElementById('resultCount').textContent),
      };
    })()`);
    if (cnSearch.skip) {
      console.log('SKIP  扩展条目可用中文名搜索（当前数据未含中文名映射）');
    } else {
      check('扩展条目可用中文名搜索', cnSearch.hit === true, JSON.stringify(cnSearch));
    }
    // 扩展条目补了作者 / 出版社后，详情应显示对应字段
    const rnAuthor = await cdp.evaluate(`(async () => {
      const x = (window.LN_DATA || []).find((v) => v.rn && v.au);
      if (!x) return { skip: true };
      const el = document.getElementById('search');
      el.value = x.n;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 400));
      const card = document.querySelector('.card[data-id="' + x.i + '"]');
      if (!card) return { skip: false, ok: false, reason: 'no-card', au: x.au };
      card.click();
      await new Promise((r) => setTimeout(r, 400));
      const meta = document.getElementById('detailMeta').textContent;
      document.getElementById('modalClose').click();
      return { skip: false, ok: meta.includes(String(x.au).split(' / ')[0]), au: x.au, meta: meta.slice(0, 90) };
    })()`);
    if (rnAuthor.skip) {
      console.log('SKIP  扩展条目详情显示作者（当前数据未含作者字段）');
    } else {
      check('扩展条目详情显示作者', rnAuthor.ok === true, JSON.stringify(rnAuthor));
    }
    await click('#showRnBtn');
    await setSearch('');

    // ---- 控制台错误 ----
    const jsErrors = cdp.events.filter(
      (e) =>
        e.method === 'Runtime.exceptionThrown' ||
        (e.method === 'Runtime.consoleAPICalled' && e.params?.type === 'error'),
    );
    // 只截 200 字时，未捕获的 Promise 拒绝只会显示 "Uncaught (in promise)"，
    // 后续的异常描述与调用栈全被切掉——报了警却不给线索，等于无法定位。
    // 这里改为把异常描述与首条调用栈单独拼出来，长度上限只约束在展示上。
    const describeJsError = (evt) => {
      const p = evt.params || {};
      if (evt.method === 'Runtime.consoleAPICalled') {
        return 'console.error: ' + (p.args || []).map((a) => a.value || a.description || a.type).join(' ');
      }
      const d = p.exceptionDetails || {};
      const desc = d.exception?.description || d.text || '(无描述)';
      const frame = (d.stackTrace?.callFrames || [])[0];
      const where = frame ? ` @ ${frame.functionName || '(anon)'} ${frame.url}:${frame.lineNumber + 1}` : '';
      return desc.split('\n').slice(0, 3).join(' | ') + where;
    };
    check('无 JS 异常', jsErrors.length === 0,
      jsErrors.length ? `${jsErrors.length} 条：${describeJsError(jsErrors[0])}`.slice(0, 300) : '');

    // ---- 旧常量残留 ----
    const legacy = await cdp.evaluate(`(() => ({
      animeData: !!window.ANIME_DATA,
      animeMeta: !!window.ANIME_META,
      animeLite: !!window.ANIME_LITE,
    }))()`);
    check('未残留番剧全局数据', !legacy.animeData && !legacy.animeMeta && !legacy.animeLite,
      JSON.stringify(legacy));

    // ---- 离线 ----
    const swReady = await cdp.evaluate(`navigator.serviceWorker.ready.then(() => true).catch(() => false)`);
    check('Service Worker 已激活', swReady === true);
    await cdp.send('Network.enable');
    await cdp.send('Network.emulateNetworkConditions', {
      offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0,
    });
    await cdp.send('Page.reload', { ignoreCache: false });
    await sleep(1200);
    await cdp.evaluate('window.__lnLoadRest()').catch(() => {});
    await sleep(1200);
    const offlineState = await cdp.evaluate(`(() => ({
      cards: document.querySelectorAll('.card').length,
      data: (window.LN_DATA || []).length,
      rest: window.__LN_REST_READY === true,
      metaCount: Number((window.LN_META || {}).count) || 0,
    }))()`).catch(() => null);
    check('离线重开仍可浏览全库',
      !!offlineState && offlineState.cards > 0 && offlineState.rest === true &&
      offlineState.data === offlineState.metaCount,
      JSON.stringify(offlineState));
    await cdp.send('Network.emulateNetworkConditions', {
      offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1,
    });

    // ---- 全库未就绪：搜索不得假报「没有找到」，就绪后自动刷新 ----
    // 取一条只在 rest 分片里、且默认隐藏（gn 一般小说）的条目做用例
    const restOnly = await cdp.evaluate(`(() => {
      const x = (window.LN_REST || []).find((v) => v.gn && !v.c && !v.ver);
      return x ? { n: String(x.n) } : null;
    })()`);

    const readEmpty = () => cdp.evaluate(`(() => {
      const e = document.getElementById('empty');
      return { hidden: e.hidden, text: (e.textContent || '').trim(),
               count: document.getElementById('resultCount').textContent,
               retry: !!document.getElementById('retryRest'),
               // 诊断字段：失败时要能自己说明原因，而不是只报 hidden/count 让人再猜一遍。
               // 本条断言的失败形态是 count="0" 且 empty 可见 —— 那是「搜了但没结果」，
               // 与「还在加载」完全不同，两者的修法也不一样。
               novel: (document.getElementById('includeNovelBtn') || {}).getAttribute
                 ? document.getElementById('includeNovelBtn').getAttribute('aria-pressed') : null,
               q: (document.getElementById('search') || {}).value,
               fullReady: window.__FULL_DATA_READY === true,
               dataLen: (window.LN_DATA || []).length };
    })()`);

    if (restOnly) {
      // 场景 1：rest 慢 4 秒，打开「含一般小说」后立刻搜索
      await clearShellGlobal();
      fault.restDelay = 6000;
      await reloadToLiteGlobal();
      await cdp.evaluate(`(() => {
        const b = document.getElementById('includeNovelBtn');
        if (b.getAttribute('aria-pressed') !== 'true') b.click();
      })()`);
      await setSearch(restOnly.n);
      const loadingState = await readEmpty();
      check('全库未就绪时搜索提示「正在加载」而非「没有找到」',
        loadingState.hidden === false &&
        loadingState.text.includes('全库数据正在加载') &&
        !loadingState.text.includes('没有找到'),
        JSON.stringify(loadingState.text.slice(0, 40)));

      // 等 rest 到位，验证无需重搜即自动出结果
      for (let i = 0; i < 80; i += 1) {
        if (await cdp.evaluate('window.__FULL_DATA_READY === true').catch(() => false)) break;
        await sleep(150);
      }
      // 不能只等固定时长：数据就绪到结果区重渲染之间还有一次异步刷新，
      // 固定 sleep 会随机读到旧状态，表现为「偶发失败」（实测跑 2 次挂 1 次）。
      // 改为轮询到结果真正出现为止，超时才判失败。
      let afterReady = await readEmpty();
      for (let i = 0; i < 40; i += 1) {
        if (afterReady.hidden === true && String(afterReady.count) !== '0') break;
        await sleep(150);
        afterReady = await readEmpty();
      }
      check('全库就绪后按当前关键词自动刷新结果',
        afterReady.hidden === true && String(afterReady.count) !== '0',
        JSON.stringify({
          hidden: afterReady.hidden, count: afterReady.count,
          novel: afterReady.novel, fullReady: afterReady.fullReady,
          dataLen: afterReady.dataLen,
        }));
      fault.restDelay = 0;

      // 场景 2：rest 持续返回 503（模拟网络仍不可用），应提示加载失败并可重试
      await clearShellGlobal();
      fault.restFail = 999;
      await reloadToLiteGlobal();
      await setSearch(restOnly.n);
      await sleep(400);
      const failState = await readEmpty();
      check('全库加载失败时区分「失败」且提供重试入口',
        failState.hidden === false && failState.text.includes('加载失败') && failState.retry === true,
        JSON.stringify(failState.text.slice(0, 40)));

      // 网络恢复后点重试，应补齐全库并出结果
      fault.restFail = 0;
      await click('#retryRest');
      for (let i = 0; i < 80; i += 1) {
        if (await cdp.evaluate('window.__FULL_DATA_READY === true').catch(() => false)) break;
        await sleep(150);
      }
      await sleep(600);
      const retried = await readEmpty();
      check('点击重试后恢复全库检索',
        retried.hidden === true && String(retried.count) !== '0',
        JSON.stringify({ hidden: retried.hidden, count: retried.count }));
      fault.restFail = 0;

      // 复位：清空搜索与「含一般小说」
      await cdp.evaluate(`(() => {
        const b = document.getElementById('includeNovelBtn');
        if (b.getAttribute('aria-pressed') === 'true') b.click();
      })()`);
      await setSearch('');
      await sleep(200);
    }


  } finally {
    try { ws?.close(); } catch {}
    try { child?.kill(); } catch {}
    await new Promise((resolve) => server.close(resolve));
    if (!KEEP) await rm(profileDir, { recursive: true, force: true }).catch(() => {});
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} 通过`);
  if (failed.length) {
    console.log('失败项：');
    failed.forEach((r) => console.log(`- ${r.name} ${r.detail}`));
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
