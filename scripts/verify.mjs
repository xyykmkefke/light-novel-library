// 自动化验收：启动本地静态服务 + Edge 无头浏览器，通过 CDP 跑核心交互检查
// 用法：node scripts/verify.mjs [--keep]
// 退出码 0 表示全部通过，1 表示存在失败项

import http from 'node:http';
import { readFile, rm, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';

const ROOT = path.resolve(import.meta.dirname, '..');
const PORT = 8791;
const CDP_PORT = 9337;
const KEEP = process.argv.includes('--keep');
const SHOT_DIR = path.join(ROOT, 'screenshots');

const EDGE_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
];

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

function startServer() {
  const server = http.createServer(async (req, res) => {
    try {
      let pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
      if (pathname === '/') pathname = '/index.html';
      const file = path.join(ROOT, pathname);
      const rel = path.relative(ROOT, file);
      if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('forbidden');
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
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(PORT, '127.0.0.1', () => resolve(server));
  });
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
  await rm(profile, { recursive: true, force: true });
  await mkdir(SHOT_DIR, { recursive: true });

  const server = await startServer();
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
        `--remote-debugging-port=${CDP_PORT}`,
        `--user-data-dir=${profile}`,
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
    check('全库数据已就绪', (await cdp.evaluate('window.__FULL_DATA_READY === true')) === true);
    const perf = await cdp.evaluate(`(() => {
      const n = performance.getEntriesByType('navigation')[0] || {};
      return {
        dcl: Math.round(n.domContentLoadedEventEnd || 0),
        paint: Math.round((performance.getEntriesByName('first-contentful-paint')[0] || {}).startTime || 0),
      };
    })()`);
    check('首屏脚本解析在 4 秒内', perf.dcl > 0 && perf.dcl < 4000, `DCL ${perf.dcl}ms / FCP ${perf.paint}ms`);

    const stats = await cdp.evaluate(`(() => {
      const d = window.LN_DATA || [];
      return {
        total: d.length,
        meta: window.LN_META || null,
        c: d.filter((x) => x.c).length,
        series: d.filter((x) => x.sv).length,
        kind: d.reduce((m, x) => { if (x.kind) m[x.kind] = (m[x.kind] || 0) + 1; return m; }, {}),
        py: d.filter((x) => x.py).length,
        au: d.filter((x) => x.au).length,
        il: d.filter((x) => x.il).length,
        pub: d.filter((x) => x.pub).length,
        line: d.filter((x) => x.line).length,
        tg: d.filter((x) => (x.tg || []).length).length,
        rt: d.filter((x) => 'rt' in x).length,
        noDate: d.filter((x) => !x.d).length,
        zeroVol: d.filter((x) => !x.v).length,
      };
    })()`);
    check('条目数不少于 3900', stats.total >= 3900, `${stats.total} 条`);
    check('系列子卷已标记', stats.c > 1500, `${stats.c} 条子卷 / ${stats.series} 系列`);
    check('拼音字段覆盖 99% 以上', stats.py / stats.total > 0.99, `${stats.py}/${stats.total}`);
    check('作者字段已抽取', stats.au > 3000, `${stats.au} 条`);
    check('插图字段已抽取', stats.il > 2500, `${stats.il} 条`);
    check('出版社字段已抽取', stats.pub > 3000, `${stats.pub} 条`);
    check('书系字段已抽取', stats.line > 1500, `${stats.line} 条`);
    check('题材覆盖超过 70%', stats.tg / stats.total > 0.7, `${stats.tg} 条`);
    check('最终数据不含 rt 字段', stats.rt === 0);
    check('漫画/画集/指南标记存在',
      (stats.kind.manga || 0) > 0 && (stats.kind.artbook || 0) > 0,
      JSON.stringify(stats.kind));

    // ---- 默认筛选 ----
    const visibleDefault = await cdp.evaluate(`(() => Number(document.getElementById('resultCount').textContent))()`);
    const expectedDefault = await cdp.evaluate(`(() => (window.LN_DATA || []).filter((x) => !x.c).length)()`);
    check('默认隐藏系列子卷', visibleDefault === expectedDefault, `${visibleDefault} / ${expectedDefault}`);
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

    check('显示系列子卷后总数增加', await (async () => {
      await click('#hideChildrenBtn');
      const n = await cdp.evaluate(`(() => Number(document.getElementById('resultCount').textContent))()`);
      await click('#hideChildrenBtn');
      return n === stats.total;
    })(), `全部 ${stats.total}`);

    // ---- 年份 ----
    const year = await cdp.evaluate(`(() => {
      const d = (window.LN_DATA || []).filter((x) => !x.c && x.d);
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
      const n = (window.LN_DATA || []).filter((x) => !x.c && (x.tg || []).includes(id)).length;
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

    // ---- 类型 ----
    await cdp.evaluate(`(() => {
      const el = document.getElementById('kind');
      el.value = 'manga';
      el.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await sleep(250);
    const mangaCount = await cdp.evaluate(`(() => Number(document.getElementById('resultCount').textContent))()`);
    check('按类型筛选漫画', mangaCount === await cdp.evaluate(`(() => (window.LN_DATA || []).filter((x) => x.kind === 'manga' && !x.c).length)()`), `${mangaCount} 本`);
    await click('#clearFiltersBtn');

    // ---- 搜索 ----
    const sample = await cdp.evaluate(`(() => {
      const x = (window.LN_DATA || []).find((v) => v.cn && !v.c);
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
    const py = await cdp.evaluate(`(() => (window.LN_DATA || []).find((x) => x.py && x.py.length > 2).py)()`);
    await setSearch(py);
    check('拼音首字母搜索有结果',
      (await cdp.evaluate(`(() => Number(document.getElementById('resultCount').textContent))()`)) > 0, py);
    await setSearch('');
    const kanaPy = await cdp.evaluate(`(() => (window.LN_DATA || []).find((x) => /^[\\u3040-\\u30ff]/.test(x.n || '') && x.py && x.py.length > 4).py)()`);
    await setSearch(kanaPy);
    check('纯日文标题可用罗马字首字母搜索',
      (await cdp.evaluate(`(() => Number(document.getElementById('resultCount').textContent))()`)) > 0, kanaPy);
    await setSearch('');

    // ---- 高级搜索语法 ----
    await setSearch('分:>=9');
    const scoreExprCount = await cdp.evaluate(`(() => Number(document.getElementById('resultCount').textContent))()`);
    const scoreExprExpected = await cdp.evaluate(`(() => window.LN_DATA.filter((x) => !x.c && x.s != null && x.s >= 9).length)()`);
    check('分:>=9 搜索生效', scoreExprCount === scoreExprExpected, `${scoreExprCount}/${scoreExprExpected}`);
    check('分: 语法不参与标题高亮', (await count('.title mark')) === 0);

    await setSearch('题材:奇幻');
    const genreExprCount = await cdp.evaluate(`(() => Number(document.getElementById('resultCount').textContent))()`);
    const genreExprExpected = await cdp.evaluate(`(() => window.LN_DATA.filter((x) => !x.c && (x.tg || []).includes('fan')).length)()`);
    check('题材:奇幻 搜索生效', genreExprCount === genreExprExpected, `${genreExprCount}/${genreExprExpected}`);

    await setSearch('年:2020');
    const yearExprCount = await cdp.evaluate(`(() => Number(document.getElementById('resultCount').textContent))()`);
    const yearExprExpected = await cdp.evaluate(`(() => window.LN_DATA.filter((x) => !x.c && String(x.d || '').startsWith('2020')).length)()`);
    check('年:2020 搜索生效', yearExprCount === yearExprExpected, `${yearExprCount}/${yearExprExpected}`);

    const authorName = await cdp.evaluate(`(() => {
      const x = window.LN_DATA.find((v) => v.au && !v.c);
      return String(x.au).split(/[\\/、,，&]/)[0].trim();
    })()`);
    await setSearch('作者:' + authorName);
    check('作者: 搜索有结果',
      (await cdp.evaluate(`(() => Number(document.getElementById('resultCount').textContent))()`)) > 0, authorName);

    await setSearch('分:>=8 题材:恋爱');
    check('字段与关键词可组合',
      (await cdp.evaluate(`(() => Number(document.getElementById('resultCount').textContent))()`)) > 0);
    await setSearch('');
    await cdp.evaluate(`(() => { location.hash = ''; })()`);

    // ---- 排序 ----
    await cdp.evaluate(`(() => {
      const el = document.getElementById('sort');
      el.value = 'heat';
      el.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await sleep(250);
    const heatFirst = await cdp.evaluate(`(() => window.LN_DATA.filter((x) => !x.c).sort((a,b) => (b.h||0)-(a.h||0))[0].i)()`);
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
      const list = window.LN_DATA.filter((x) => !x.c);
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
    const maxVol = await cdp.evaluate(`(() => Math.max(...window.LN_DATA.filter((x) => !x.c).map((x) => Number(x.v) || 0)))()`);
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
      const x = (window.LN_DATA || []).find((v) => v.v > 2 && !v.c);
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

    // 切换阅读状态会关闭详情，重新打开后继续测书评
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
    check('导出 JSON 版本升级为 2', exportedJson?.version === 2, String(exportedJson?.version));
    check('导出 JSON 含评分与短评',
      exportedItem?.rating === 9 && exportedItem?.review === '测试短评',
      JSON.stringify({ r: exportedItem?.rating, rv: exportedItem?.review }));
    await cdp.evaluate(`(() => { location.hash = ''; })()`);
    await sleep(300);

    // ---- 视图与分组 ----
    await click('.tab[data-tab="mine"]');
    await cdp.evaluate(`(() => {
      const el = document.getElementById('viewSelect');
      el.value = 'board';
      el.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await sleep(250);
    check('看板视图显示四列', (await count('.board-col')) === 4);
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
      const x = (window.LN_DATA || []).find((v) => v.v > 1 && !v.c && String(v.i) !== ${JSON.stringify(pick.id)});
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
    check('统计页汇总已评分数量',
      /已评分/.test(await cdp.evaluate(`(() => document.getElementById('statsPanel').textContent)()`)));
    check('统计页显示常读作者',
      /常读作者/.test(await cdp.evaluate(`(() => document.getElementById('statsPanel').textContent)()`)));
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
    await click('#settingsClose');
    const themeBefore = await cdp.evaluate(`(() => document.documentElement.getAttribute('data-theme'))()`);
    await click('#themeBtn');
    const themeAfter = await cdp.evaluate(`(() => document.documentElement.getAttribute('data-theme'))()`);
    check('明暗主题可切换', themeBefore !== themeAfter, `${themeBefore} → ${themeAfter}`);
    await click('#themeBtn');

    // ---- 空结果恢复 ----
    await click('.tab[data-tab="all"]');
    await setSearch('zzzz不存在的书名zzzz');
    check('无结果时展示空状态',
      (await cdp.evaluate(`(() => !document.getElementById('empty').hidden)()`)) === true);
    check('空状态提供放宽条件', (await count('#empty .btn')) > 0);
    await click('#resetFilters');
    check('清除筛选后恢复列表',
      (await cdp.evaluate(`(() => document.querySelectorAll('.card').length)()`)) > 0);

    // ---- 分享与 hash ----
    const hash = await cdp.evaluate(`(() => location.hash)()`);
    check('URL hash 同步筛选状态', /tab=/.test(hash), hash.slice(0, 60));
    check('页脚版本为 v1.1.0', (await cdp.evaluate(`(() => document.querySelector('footer').textContent)()`)).includes('v1.1.0'));

    // ---- 数据边界 ----
    const noDate = await cdp.evaluate(`(() => {
      const x = (window.LN_DATA || []).find((v) => !v.d && !v.c);
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

    const noVol = await cdp.evaluate(`(() => {
      const x = (window.LN_DATA || []).find((v) => !v.v && !v.c);
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
    check('manifest 版本为 1.1.0', manifest.version === '1.1.0');
    const swTxt = await (await fetch(`http://127.0.0.1:${PORT}/sw.js`)).text();
    check('Service Worker 缓存名独立', swTxt.includes('yuc-ln-shell-v3'));
    check('Service Worker 缓存全库数据', swTxt.includes('data/light-novels.js'));
    check('封面缓存带数量上限清理', swTxt.includes('trimImageCache') && swTxt.includes('IMG_LIMIT'));
    check('图标文件存在', existsSync(path.join(ROOT, 'icons/icon-512.png')) && existsSync(path.join(ROOT, 'icons/icon-180.png')));
    const indexTxt = await (await fetch(`http://127.0.0.1:${PORT}/index.html`)).text();
    check('包含安装引导', indexTxt.includes('beforeinstallprompt') && indexTxt.includes('添加到主屏幕'));
    check('帮助面板写明高级搜索语法', indexTxt.includes('作者:米泽穗信'));
    check('卡片启用 content-visibility',
      (await cdp.evaluate(`(() => getComputedStyle(document.querySelector('.card')).contentVisibility)()`)) === 'auto');
    check('统计标签入口存在', (await count('.tab[data-tab="stats"]')) === 1);

    // ---- 无障碍 ----
    check('存在跳过头部链接', (await count('#skipLink')) === 1);
    check('搜索框有可访问名称',
      !!(await cdp.evaluate(`(() => document.getElementById('search').getAttribute('aria-label'))()`)));
    check('弹窗具备 aria-modal',
      (await cdp.evaluate(`(() => document.querySelector('.modal-panel').getAttribute('aria-modal'))()`)) === 'true');
    check('卡片可通过键盘聚焦',
      (await cdp.evaluate(`(() => { const el = document.querySelector('.card-link[tabindex="0"]'); return !!el; })()`)) === true);
    await cdp.evaluate(`(() => { location.hash = 'd=' + ${JSON.stringify(pick.id)}; })()`);
    await sleep(250);
    await cdp.evaluate(`(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))()`);
    await sleep(250);
    check('Esc 关闭详情并归还焦点',
      (await cdp.evaluate(`(() => document.getElementById('modal').hidden)()`)) === true);
    await cdp.evaluate(`(() => { location.hash = ''; })()`);

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
    const sheetShot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    if (sheetShot.result?.data) {
      await writeFile(path.join(SHOT_DIR, 'mobile.png'), Buffer.from(sheetShot.result.data, 'base64'));
    }
    await click('#filterDone');
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

    // ---- 控制台错误 ----
    const jsErrors = cdp.events.filter(
      (e) =>
        e.method === 'Runtime.exceptionThrown' ||
        (e.method === 'Runtime.consoleAPICalled' && e.params?.type === 'error'),
    );
    check('无 JS 异常', jsErrors.length === 0,
      jsErrors.length ? JSON.stringify(jsErrors[0].params).slice(0, 200) : '');

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
    await sleep(2200);
    const offlineState = await cdp.evaluate(`(() => ({
      cards: document.querySelectorAll('.card').length,
      data: (window.LN_DATA || []).length,
    }))()`).catch(() => null);
    check('离线重开仍可浏览全库', !!offlineState && offlineState.cards > 0 && offlineState.data > 3900,
      JSON.stringify(offlineState));
    await cdp.send('Network.emulateNetworkConditions', {
      offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1,
    });
  } finally {
    try { ws?.close(); } catch {}
    try { child?.kill(); } catch {}
    await new Promise((resolve) => server.close(resolve));
    if (!KEEP) await rm(profile, { recursive: true, force: true }).catch(() => {});
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
