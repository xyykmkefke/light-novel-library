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

const fault = { extraFail: 0, chFail: 0, volumesFail: 0, rnFail: 0, idxFail: 0, idxDelay: 0 };

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
      if (p.includes('light-novels-volumes.js') && fault.volumesFail > 0) {
        fault.volumesFail -= 1;
        res.writeHead(503, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
        res.end('service unavailable');
        return;
      }
      if (p.includes('light-novels-rn.js') && fault.rnFail > 0) {
        fault.rnFail -= 1;
        res.writeHead(503, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
        res.end('service unavailable');
        return;
      }
      // 搜索索引包：作者 / 全拼 / 罗马字
      if (/light-novels-(pyf|rpy|au)\.js/.test(p) && fault.idxFail > 0) {
        fault.idxFail -= 1;
        res.writeHead(503, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
        res.end('service unavailable');
        return;
      }
      if (/light-novels-(pyf|rpy|au)\.js/.test(p) && fault.idxDelay > 0) {
        await sleep(fault.idxDelay);
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

// 等一个页面侧条件成立；超时**明确返回 false 并打印**，不静默继续。
//
// 原来这里是一串裸循环：
//   for (let i = 0; i < 40; i += 1) { if (await c.evaluate(...)) break; await sleep(150); }
// 超时后直接往下跑断言。后果是「没等到」被伪装成「功能坏了」——
// 2026-11-27 实测到一次：`volumes 失败时卷清单提示「卷信息加载失败」` 报 FAIL，
// 详情里显示的是「卷信息加载中…」，即失败标志还没置位就开始断言了。
// 重跑一次就 23/23 全过，属于典型的时序假失败，但报告里看不出来，
// 只会让人以为功能有 bug。
//
// 现在超时会打印一行「等待超时」，且调用方可以据此把「没等到」和「等到了但结果不对」
// 分开判断——这两者的排查方向完全不同。
async function waitFor(c, expr, { tries = 40, interval = 150, label = '' } = {}) {
  for (let i = 0; i < tries; i += 1) {
    if (await c.evaluate(expr).catch(() => false)) return true;
    await sleep(interval);
  }
  console.log(`  等待超时：${label || expr}（${(tries * interval / 1000).toFixed(1)}s）`);
  return false;
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
    const extraFailReady = await waitFor(c, 'window.__lnExtraFailed === true',
      { tries: 40, label: 'extra 失败标志置位' });
    await sleep(400);
    const extraFail = await c.evaluate(`(() => {
      const m = document.getElementById('detailMeta');
      const t = (m ? m.textContent : '').replace(/\\s+/g, ' ').trim();
      return { open: !document.getElementById('modal').hidden, text: t,
               retry: !!document.querySelector('[data-retry-extra]') };
    })()`);
    // 前置条件单独报：没等到失败标志时，下面两条断言的结果说明不了 UI 好坏。
    check('extra 失败标志已置位（后续断言的前置条件）', extraFailReady === true,
      extraFailReady ? '' : '未在 6s 内观察到 __lnExtraFailed');
    check('extra 失败时详情提示「字段加载失败」',
      extraFail.open && /字段加载失败/.test(extraFail.text),
      JSON.stringify(extraFail.text.slice(0, 44)));
    check('extra 失败时提供重试入口', extraFail.retry === true);

    // ---- extra 重试成功 ----
    fault.extraFail = 0;
    await c.evaluate(`(() => { const b = document.querySelector('[data-retry-extra]'); if (b) b.click(); })()`);
    const extraRetryOk = await waitFor(c, 'window.__LN_EXTRA_READY === true',
      { tries: 60, label: 'extra 重试后就绪' });
    await sleep(400);
    const extraOk = await c.evaluate(`(() => {
      const m = document.getElementById('detailMeta');
      const t = (m ? m.textContent : '').replace(/\\s+/g, ' ').trim();
      return { text: t, hasFail: /字段加载失败/.test(t), hasAuthor: /作者/.test(t) };
    })()`);
    check('extra 重试后作者补上且失败提示消失',
      extraRetryOk === true && extraOk.hasFail === false && extraOk.hasAuthor,
      (extraRetryOk ? '' : '重试后仍未见 __LN_EXTRA_READY · ') + JSON.stringify(extraOk.text.slice(0, 44)));

    // ---- ch 失败 ----
    fault.chFail = 999;
    const seriesId = await c.evaluate(`(() => {
      const s = (window.LN_DATA || []).find(x => x.sv && !Array.isArray(x.ch) && x.i);
      return s ? String(s.i) : '';
    })()`);
    await c.evaluate(`location.hash = ''`);
    await sleep(200);
    await c.evaluate(`location.hash = 'd=' + ${JSON.stringify(seriesId)}`);
    const chFailReady = await waitFor(c, 'window.__lnChFailed === true',
      { tries: 40, label: 'ch 失败标志置位' });
    await sleep(400);
    const chFail = await c.evaluate(`(() => {
      const b = document.getElementById('detailVolumes');
      const t = (b ? b.textContent : '').replace(/\\s+/g, ' ').trim();
      return { text: t, retry: !!document.querySelector('[data-retry-ch]') };
    })()`);
    check('ch 失败标志已置位（后续断言的前置条件）', chFailReady === true,
      chFailReady ? '' : '未在 6s 内观察到 __lnChFailed');
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
    const chRetryOk = await waitFor(c, 'window.__LN_CH_READY === true',
      { tries: 60, label: 'ch 重试后就绪' });
    await sleep(400);
    const chOk = await c.evaluate(`(() => {
      const b = document.getElementById('detailVolumes');
      const t = (b ? b.textContent : '').replace(/\\s+/g, ' ').trim();
      return { text: t, hasFail: /卷清单加载失败/.test(t) };
    })()`);
    check('ch 重试后卷清单恢复且失败提示消失',
      chRetryOk === true && chOk.hasFail === false,
      (chRetryOk ? '' : '重试后仍未见 __LN_CH_READY · ') + JSON.stringify(chOk.text.slice(0, 44)));

    // ---- volumes 失败：卷包（卷名 / 封面 / 日期）没到位，不能渲染成「卷 51736」裸 ID ----
    // 选一个子卷只存在于 volumes 包的系列（豹头王传说 151 卷，子卷全不在 lite/rest 里）
    fault.volumesFail = 999;
    await c.evaluate(`location.hash = ''`);
    await sleep(200);
    await c.evaluate(`location.hash = 'd=51735'`);
    await sleep(400);
    // 先展开卷清单触发请求，再等失败标志。
    //
    // 顺序不能反：`window.__lnVolumesFailed` 只在 `script.onerror` 里置位，
    // 而卷包请求是由「展开卷清单」这一步触发的。把等待放在展开之前，
    // 只在页面恰好提前发过请求时才会成功——实测会稳定超时 6 秒，
    // 然后报「未观察到 __lnVolumesFailed」，而页面此时已经显示着
    // 「卷信息加载失败，重试」，看起来像标志丢了，其实是等错了时机。
    await c.evaluate(`(() => {
      const b = document.getElementById('detailVolumes');
      const btn = b && b.querySelector('[data-vol-expand]');
      if (btn && btn.getAttribute('aria-expanded') === 'false') btn.click();
    })()`);
    // 再确认失败标志真的置位了，然后才去断言 UI。
    // 这一步是「前置条件」，不是「被测功能」：没等到就说明这次的样本不成立，
    // 不能说 UI 提示坏了。
    const volFailReady = await waitFor(c, 'window.__lnVolumesFailed === true',
      { tries: 40, label: 'volumes 失败标志置位' });
    await sleep(600);
    const volFail = await c.evaluate(`(() => {
      const b = document.getElementById('detailVolumes');
      const t = (b ? b.textContent : '').replace(/\\s+/g, ' ').trim();
      return { text: t, retry: !!document.querySelector('[data-retry-volumes]'),
               failedFlag: window.__lnVolumesFailed === true };
    })()`);
    // 先报前置条件：失败标志没置位时，下面三条断言的结果没有意义。
    // 分开报的好处是报告能直接说明「这次样本没成立」，而不是让人以为 UI 坏了。
    check('volumes 失败标志已置位（后续断言的前置条件）', volFailReady === true,
      volFailReady ? '' : `未在 6s 内观察到 __lnVolumesFailed，页面当前为「${volFail.text.slice(0, 30)}」`);
    check('volumes 失败时卷清单提示「卷信息加载失败」',
      /卷信息加载失败/.test(volFail.text), JSON.stringify(volFail.text.slice(0, 50)));
    check('volumes 失败时提供重试入口', volFail.retry === true);
    check('volumes 失败时不渲染裸 ID 当书名',
      !/卷 51736/.test(volFail.text), JSON.stringify(volFail.text.slice(0, 50)));

    // ---- volumes 重试成功 ----
    fault.volumesFail = 0;
    await c.evaluate(`(() => { const b = document.querySelector('[data-retry-volumes]'); if (b) b.click(); })()`);
    const volRetryOk = await waitFor(c, 'window.__LN_VOLUMES_READY === true',
      { tries: 60, label: 'volumes 重试后就绪' });
    await sleep(600);
    const volOk = await c.evaluate(`(() => {
      const b = document.getElementById('detailVolumes');
      const t = (b ? b.textContent : '').replace(/\\s+/g, ' ').trim();
      const first = b ? (b.querySelector('[data-vol-toggle]') || {}).textContent : '';
      return { text: t, hasFail: /卷信息加载失败/.test(t),
               firstRow: String(first || '').replace(/\\s+/g, ' ').trim().slice(0, 40) };
    })()`);
    check('volumes 重试后卷名恢复且失败提示消失',
      volRetryOk === true && volOk.hasFail === false && !/卷 5173\\d/.test(volOk.firstRow),
      (volRetryOk ? '' : '重试后仍未见 __LN_VOLUMES_READY · ') + JSON.stringify(volOk.firstRow));

    // ---- rn 失败：开关显示「已开启」却一本书都没多，必须说明 ----
    // 先等全库到位，贴近真实场景（用户通常在列表稳定后才去点扩展书目开关）
    const restReady = await waitFor(c, 'window.__LN_REST_READY === true',
      { tries: 80, interval: 200, label: '全库（rest）就绪' });
    if (!restReady) {
      check('全库已就绪（rn 用例的前置条件）', false, 'rest 未就绪，rn 失败态断言的结果不可信');
    }
    fault.rnFail = 999;
    await c.evaluate(`location.hash = ''`);
    await sleep(300);
    await c.evaluate(`(() => {
      const b = document.getElementById('showRnBtn');
      if (b && b.getAttribute('aria-pressed') !== 'true') b.click();
    })()`);
    const rnFailReady = await waitFor(c, 'window.__lnRnFailed === true',
      { tries: 40, label: 'rn 失败标志置位' });
    await sleep(500);
    const rnFail = await c.evaluate(`(() => {
      const h = document.getElementById('dataHint');
      return { text: (h ? h.textContent : '').replace(/\\s+/g, ' ').trim(),
               retry: !!document.querySelector('#retryRn'),
               pressed: (document.getElementById('showRnBtn') || {}).getAttribute
                 ? document.getElementById('showRnBtn').getAttribute('aria-pressed') : null };
    })()`);
    check('rn 失败标志已置位（后续断言的前置条件）', rnFailReady === true,
      rnFailReady ? '' : '未在 6s 内观察到 __lnRnFailed');
    check('rn 失败时页脚提示「扩展书目加载失败」',
      /扩展书目加载失败/.test(rnFail.text), JSON.stringify(rnFail.text.slice(-40)));
    check('rn 失败时提供重试入口', rnFail.retry === true && rnFail.pressed === 'true');

    // ---- rn 重试成功 ----
    fault.rnFail = 0;
    await c.evaluate(`(() => { const b = document.getElementById('retryRn'); if (b) b.click(); })()`);
    for (let i = 0; i < 80; i += 1) {
      if (await c.evaluate('window.__LN_RN_READY === true').catch(() => false)) break;
      await sleep(200);
    }
    await sleep(600);
    const rnOk = await c.evaluate(`(() => {
      const h = document.getElementById('dataHint');
      return { text: (h ? h.textContent : '').replace(/\\s+/g, ' ').trim(),
               count: window.__LN_RN_COUNT || 0 };
    })()`);
    check('rn 重试后扩展书目进入列表且失败提示消失',
      /扩展书目加载失败/.test(rnOk.text) === false && rnOk.count > 0,
      `新增 ${rnOk.count} 部`);

    // ---- 搜索索引包失败：作者名只存在于此，失败时不能谎报「没有找到」 ----
    const setSearch = async (q) => {
      await c.evaluate(`(() => {
        const el = document.getElementById('search');
        el.value = ${JSON.stringify(q)};
        el.dispatchEvent(new Event('input', { bubbles: true }));
      })()`);
      await sleep(500);
    };

    // 先测「加载中」：索引包慢 3 秒，此时搜作者名必须说加载中，不能说没有
    await c.evaluate(`(() => { window.__lnResetIdxForTest('au'); return true; })()`);
    fault.idxDelay = 3000;
    await setSearch('zzzz不存在的作者zzzz');
    const idxPending = await c.evaluate(`(() => {
      const e = document.getElementById('empty');
      const t = (e ? e.textContent : '').replace(/\\s+/g, ' ').trim();
      return { text: t, retry: !!document.getElementById('retryAuIdx'),
               state: window.__lnIdxState() };
    })()`);
    check('索引加载中时提示「正在加载」而非「没有找到」',
      /正在加载.*索引/.test(idxPending.text) && !/没有找到/.test(idxPending.text),
      JSON.stringify(idxPending.text.slice(0, 50)));
    check('索引加载中时提供立即加载入口', idxPending.retry === true);
    fault.idxDelay = 0;

    // 等这次慢请求落地，再测失败态（否则两个用例会互相干扰）
    // 这一步不是断言，只为让上一个用例收尾；但超时仍要留痕，
    // 否则「上一个用例还没结束就开始下一个」会变成莫名其妙的连锁失败。
    const idxSettled = await waitFor(c, 'window.__lnIdxState().au.ready === true',
      { tries: 60, label: '慢请求落地（索引就绪）' });
    if (!idxSettled) {
      check('慢索引请求已落地（用例隔离的前置条件）', false, '上一个用例未收尾，后续索引断言可能互相干扰');
    }

    // 再测失败：复位后注入 503
    await c.evaluate(`(() => { window.__lnResetIdxForTest('au'); return true; })()`);
    fault.idxFail = 999;
    await setSearch('zzzz不存在的作者zzzz');
    const idxFail = await c.evaluate(`(() => {
      const e = document.getElementById('empty');
      const t = (e ? e.textContent : '').replace(/\\s+/g, ' ').trim();
      return { text: t, retry: !!document.getElementById('retryAuIdx'),
               state: window.__lnIdxState() };
    })()`);
    check('索引失败时提示「索引加载失败」而非「没有找到」',
      /索引加载失败/.test(idxFail.text) && !/没有找到/.test(idxFail.text),
      JSON.stringify(idxFail.text.slice(0, 50)));
    check('索引失败时提供重试入口', idxFail.retry === true);
    check('索引失败状态被记录（未与「未加载」混淆）',
      idxFail.state.au.failed === true && idxFail.state.au.ready === false,
      JSON.stringify(idxFail.state.au));

    // ---- 索引重试成功 ----
    fault.idxFail = 0;
    await c.evaluate(`(() => { const b = document.getElementById('retryAuIdx'); if (b) b.click(); })()`);
    const idxRetryOk = await waitFor(c, 'window.__lnIdxState().au.ready === true',
      { tries: 60, label: '索引重试后就绪' });
    await sleep(400);
    const idxOk = await c.evaluate(`(() => {
      const s = window.__lnIdxState();
      const withAu = (window.LN_DATA || []).filter((x) => x.au).length;
      return { ready: s.au.ready, withAu };
    })()`);
    check('索引重试后作者包就绪并挂上字段',
      idxRetryOk === true && idxOk.ready === true && idxOk.withAu > 3000,
      (idxRetryOk ? '' : '重试后仍未见 au.ready · ') + JSON.stringify(idxOk));

    // 作者名恢复可搜：用真实作者名验证「重试后真的能搜到」
    const realAuthor = await c.evaluate(`(() => {
      const x = (window.LN_DATA || []).find((v) => v.au && !v.c && !v.gn && !v.ver);
      return x ? String(x.au).split(/[\\/、,，&]/)[0].trim() : '';
    })()`);
    await setSearch(realAuthor);
    const authorHit = await c.evaluate(`(() => ({
      count: Number(document.getElementById('resultCount').textContent),
      empty: document.getElementById('empty').hidden,
    }))()`);
    check('索引重试后作者名可搜到', authorHit.count > 0,
      `${realAuthor} → ${authorHit.count} 条`);

    // ---- 索引包不会被重复请求（防死循环） ----
    const idxBefore = await c.evaluate(`document.querySelectorAll('script[src*="light-novels-au"]').length`);
    await sleep(1200);
    const idxAfter = await c.evaluate(`document.querySelectorAll('script[src*="light-novels-au"]').length`);
    check('索引就绪后不再重复请求', idxBefore === idxAfter, `${idxBefore} → ${idxAfter}`);
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
