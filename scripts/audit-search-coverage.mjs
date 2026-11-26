// 全量覆盖率审计：不重跑既有断言，而是对全库 5076 条逐条验证「每种写法都必须能搜到」。
// 调用页面内产品代码本体（__lnAudit），审计判据由本脚本独立给出。
// 用法：node scripts/audit-search-coverage.mjs
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';

const ROOT = path.resolve(import.meta.dirname, '..');
const PORT = 8821;
const CDP_PORT = 9381;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.json': 'application/json; charset=utf-8',
};

const BROWSERS = [
  process.env.CHROME_PATH,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium',
].filter(Boolean);

function startServer() {
  const server = http.createServer(async (req, res) => {
    try {
      let p = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
      if (p === '/') p = '/index.html';
      // 不提供 sw.js：避免缓存干扰，保证走真实文件
      if (p === '/sw.js') { res.writeHead(404).end('no sw'); return; }
      const body = await readFile(path.join(ROOT, p));
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(p)] || 'application/octet-stream',
        'Cache-Control': 'no-store',
      });
      res.end(body);
    } catch { res.writeHead(404).end('nf'); }
  });
  return new Promise((r) => server.listen(PORT, '127.0.0.1', () => r(server)));
}

async function getPage() {
  for (let i = 0; i < 80; i += 1) {
    try {
      const l = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
      const p = l.find((t) => t.type === 'page');
      if (p) return p;
    } catch {}
    await sleep(250);
  }
  throw new Error('无法连接调试端口');
}

function cdp(ws) {
  let seq = 0; const pending = new Map();
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  };
  const send = (method, params = {}) => new Promise((res) => {
    const id = ++seq; pending.set(id, res);
    ws.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.result?.exceptionDetails) {
      throw new Error(String(r.result.exceptionDetails.exception?.description || 'eval error'));
    }
    return r.result?.result?.value;
  };
  return { send, evaluate };
}

const sections = [];
let current = null;
function section(name) {
  current = { name, checks: [], gaps: [] };
  sections.push(current);
}
function record(name, ok, detail, gapInfo) {
  current.checks.push({ name, ok, detail });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  → ' + detail : ''}`);
  if (!ok && gapInfo) current.gaps.push(gapInfo);
}

// 「筛样本再统计」类断言的统一出口。
//
// 为什么单独包一层：这类断言写成 `hit === tested` 时，一旦筛选条件把用例全过滤掉，
// 0 === 0 会一路报通过 —— 而它可能从写下当天起就没执行过。v1.24.1 的长音项就是这么
// 空跑了几天的（判据 `!/-/.test(rpyFull)`，而 rpyFull 早被清洗成纯字母）。
// 所以这里强制「用例数为 0 一律 FAIL」，并且不允许调用方绕过。
//
// 参数：
//   label  断言名（不含计数，计数由本函数拼）
//   r      { tested, hit, miss } 统计对象
//   empty  用例为 0 时的说明，写清「为什么筛不出样本」，便于判断是数据变了还是判据坏了
function recordCoverage(label, r, empty) {
  const { tested, hit, miss } = r || {};
  if (!tested) {
    record(`${label}（0/0）`, false, empty || '用例为 0，断言空跑 —— 判据可能已失效', []);
    return;
  }
  record(
    `${label}（${hit}/${tested}）`,
    hit === tested,
    miss && miss.length ? `漏 ${tested - hit} 条` : '全部命中',
    miss || [],
  );
}

const browser = BROWSERS.find((p) => existsSync(p));
if (!browser) throw new Error('未找到 Edge/Chrome');

const server = await startServer();
const profile = path.join(os.tmpdir(), 'ln-audit-' + Date.now());
let child, ws;

try {
  child = spawn(browser, ['--headless=new', '--disable-gpu', '--no-first-run',
    ...(process.platform === 'linux' ? ['--no-sandbox', '--disable-dev-shm-usage'] : []),
    `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`,
    '--window-size=1440,1100', `http://127.0.0.1:${PORT}/`], { stdio: 'ignore' });

  const page = await getPage();
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  const c = cdp(ws);
  await c.send('Runtime.enable'); await c.send('Page.enable');
  await c.send('Network.setCacheDisabled', { cacheDisabled: true });

  for (let i = 0; i < 100; i += 1) {
    if (await c.evaluate('window.__LN_LITE_READY === true').catch(() => false)) break;
    await sleep(200);
  }

  // 等全库 + 三个索引包 + 繁简表全部就绪
  await c.evaluate(`(async () => {
    await window.__lnLoadRest();
    await window.__lnLoadIdx('au');
    await window.__lnLoadIdx('pyf');
    await window.__lnLoadIdx('rpy');
    return true;
  })()`);
  for (let i = 0; i < 80; i += 1) {
    if (await c.evaluate('window.__lnT2CNReady && window.__lnT2CNReady()').catch(() => false)) break;
    await sleep(150);
  }
  await sleep(500);

  const total = await c.evaluate('window.__lnAudit.count()');
  console.log(`\n全库 ${total} 条，开始逐条审计\n`);

  // ============ 1. 繁 → 简 全量 ============
  section('繁简互通（全量逐条）');
  // id 列表：从页面 DATA 取
  const ids = await c.evaluate(`(() => {
    const out = [];
    window.LN_DATA.forEach((x) => out.push(String(x.i)));
    return out;
  })()`);

  // 逐条：只挑「真正的繁体」用例。判据不能用「normalize 后与原文不同」——
  // 那会把片假名折叠、全角折半也一并算进来，把三种能力混成一个数。
  // 正确判据：把 normalize 里除 t2cn 以外的步骤（NFC / 全角折半 / 小写 / 假名折叠）
  // 单独重做一遍，若结果与 normalize 完全相同，说明 t2cn 什么都没改 —— 不是繁简用例。
  const simplReport = await c.evaluate(`(() => {
    const A = window.__lnAudit;
    const ids = ${JSON.stringify(ids)};
    function foldNoT2(s) {
      let v = String(s == null ? '' : s);
      if (v.normalize) v = v.normalize('NFC');
      v = v.replace(/[\\uFF01-\\uFF5E\\u3000]/g, (c) =>
        c === '\\u3000' ? ' ' : String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
      v = v.toLowerCase();
      v = v.replace(/[\\u30A1-\\u30F6]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
      return v;
    }
    let tested = 0, hit = 0; const miss = [];
    for (const id of ids) {
      const it = A.item(id);
      if (!it || it.c || it.gn || it.ver) continue;
      const src = String(it.cn || it.n || '');
      if (!src) continue;
      const simplified = A.normalize(src);
      if (simplified === foldNoT2(src)) continue;   // 差异不来自繁简，跳过
      tested += 1;
      const found = A.find(simplified);
      if (found.includes(id)) hit += 1;
      else if (miss.length < 10) miss.push({ id, src, q: simplified });
    }
    return { tested, hit, miss };
  })()`);
  recordCoverage('简体写法可命中繁体书名', simplReport,
    '全库无「含繁体字且 t2cn 确实改动」的用例 —— 繁简表可能未就绪');

  // ============ 2. 全角 → 半角 全量 ============
  section('全角折半（全量逐条）');
  const fwReport = await c.evaluate(`(() => {
    const A = window.__lnAudit;
    const ids = ${JSON.stringify(ids)};
    let tested = 0, hit = 0; const miss = [];
    for (const id of ids) {
      const it = A.item(id);
      if (!it || it.c || it.gn || it.ver) continue;
      const src = String(it.cn || it.n || '');
      if (!/[\\uFF01-\\uFF5E]/.test(src)) continue;
      // 把全角 ASCII 折成半角，作为「用户敲半角」的查询
      const half = src.replace(/[\\uFF01-\\uFF5E]/g, (ch) =>
        String.fromCharCode(ch.charCodeAt(0) - 0xFEE0));
      tested += 1;
      const found = A.find(half);
      if (found.includes(id)) hit += 1;
      else if (miss.length < 10) miss.push({ id, src, q: half });
    }
    return { tested, hit, miss };
  })()`);
  recordCoverage('半角写法可命中全角书名', fwReport,
    '全库无含全角 ASCII 的书名 —— 该维度无样本可验');

  // 反向：全角查询必须能命中半角书名
  const fwReverse = await c.evaluate(`(() => {
    const A = window.__lnAudit;
    const ids = ${JSON.stringify(ids)};
    let tested = 0, hit = 0; const miss = [];
    for (const id of ids) {
      const it = A.item(id);
      if (!it || it.c || it.gn || it.ver) continue;
      const src = String(it.cn || it.n || '');
      if (!/[A-Za-z0-9]/.test(src)) continue;
      const full = src.replace(/[A-Za-z0-9]/g, (ch) =>
        String.fromCharCode(ch.charCodeAt(0) + 0xFEE0));
      tested += 1;
      if (A.find(full).includes(id)) hit += 1;
      else if (miss.length < 10) miss.push({ id, src, q: full });
    }
    return { tested, hit, miss };
  })()`);
  recordCoverage('全角写法可命中半角书名', fwReverse,
    '全库无含半角字母/数字的书名 —— 该维度无样本可验');

  // ============ 3. 全拼 全量 ============
  section('全拼命中（全量逐条）');
  const pyReport = await c.evaluate(`(() => {
    const A = window.__lnAudit;
    const ids = ${JSON.stringify(ids)};
    let tested = 0, hit = 0; const miss = [];
    for (const id of ids) {
      const it = A.item(id);
      if (!it || it.c || it.gn || it.ver) continue;
      if (!it.pyFull || it.pyFull.length < 4) continue;
      tested += 1;
      if (A.find(it.pyFull).includes(id)) hit += 1;
      else if (miss.length < 10) miss.push({ id, src: it.cn || it.n, q: it.pyFull });
    }
    return { tested, hit, miss };
  })()`);
  recordCoverage('全拼查询可命中自身', pyReport,
    '全库无长度 ≥4 的全拼 —— 全拼索引包可能未加载');

  // ============ 4. 罗马字 全量 ============
  section('罗马字命中（全量逐条）');
  const rpyReport = await c.evaluate(`(() => {
    const A = window.__lnAudit;
    const ids = ${JSON.stringify(ids)};
    let tested = 0, hit = 0; const miss = [];
    for (const id of ids) {
      const it = A.item(id);
      if (!it || it.c || it.gn || it.ver) continue;
      if (!it.rpyFull || it.rpyFull.length < 4) continue;
      tested += 1;
      if (A.find(it.rpyFull).includes(id)) hit += 1;
      else if (miss.length < 10) miss.push({ id, src: it.cn || it.n, q: it.rpyFull });
    }
    return { tested, hit, miss };
  })()`);
  recordCoverage('罗马字查询可命中自身', rpyReport,
    '全库无长度 ≥4 的罗马字 —— 罗马字索引包可能未加载');

  // ============ 5. 作者 全量 ============
  section('作者名命中（全量逐条）');
  const auReport = await c.evaluate(`(() => {
    const A = window.__lnAudit;
    const ids = ${JSON.stringify(ids)};
    let tested = 0, hit = 0; const miss = [];
    for (const id of ids) {
      const it = A.item(id);
      if (!it || it.c || it.gn || it.ver) continue;
      if (!it.au) continue;
      // 逐个作者名都要能搜到（含多作者用 / 、 , 分隔）
      const names = String(it.au).split(/[\\/、,，&]/).map((s) => s.trim()).filter(Boolean);
      for (const name of names) {
        tested += 1;
        if (A.find(name).includes(id)) hit += 1;
        else if (miss.length < 10) miss.push({ id, src: it.cn || it.n, q: name, au: it.au });
      }
    }
    return { tested, hit, miss };
  })()`);
  recordCoverage('作者名查询可命中其作品', auReport,
    '全库无作者名 —— 作者索引包可能未加载，此时不该判定通过');

  // ============ 6. 插图 全量 ============
  section('插图名命中（全量逐条）');
  const ilReport = await c.evaluate(`(() => {
    const A = window.__lnAudit;
    const ids = ${JSON.stringify(ids)};
    let tested = 0, hit = 0; const miss = [];
    for (const id of ids) {
      const it = A.item(id);
      if (!it || it.c || it.gn || it.ver) continue;
      if (!it.il) continue;
      tested += 1;
      if (A.find(it.il).includes(id)) hit += 1;
      else if (miss.length < 10) miss.push({ id, src: it.cn || it.n, q: it.il });
    }
    return { tested, hit, miss };
  })()`);
  recordCoverage('插图名查询可命中其作品', ilReport,
    '全库无插图名 —— 作者索引包（含插图）可能未加载');

  // ============ 7. 省略标点 全量 ============
  section('省略标点/空格（全量逐条）');
  const compactReport = await c.evaluate(`(() => {
    const A = window.__lnAudit;
    const ids = ${JSON.stringify(ids)};
    let tested = 0, hit = 0; const miss = [];
    for (const id of ids) {
      const it = A.item(id);
      if (!it || it.c || it.gn || it.ver) continue;
      const src = String(it.cn || it.n || '');
      const compacted = A.compactOf(A.normalize(src));
      if (!compacted || compacted.length < 4) continue;
      if (compacted === A.normalize(src)) continue; // 没有可省略的标点
      tested += 1;
      // 严格搜不到时才走兜底，这里验「兜底开启后必中」
      if (A.find(compacted, true).includes(id)) hit += 1;
      else if (miss.length < 10) miss.push({ id, src, q: compacted });
    }
    return { tested, hit, miss };
  })()`);
  recordCoverage('省略标点后仍可命中', compactReport,
    '全库无「去掉标点后与原文不同」的书名 —— 该维度无样本可验');

  // ============ 8. 大小写 ============
  section('大小写不敏感（全量逐条）');
  const caseReport = await c.evaluate(`(() => {
    const A = window.__lnAudit;
    const ids = ${JSON.stringify(ids)};
    let tested = 0, hit = 0; const miss = [];
    for (const id of ids) {
      const it = A.item(id);
      if (!it || it.c || it.gn || it.ver) continue;
      const src = String(it.cn || it.n || '');
      if (!/[a-z]/.test(src)) continue;
      tested += 1;
      if (A.find(src.toUpperCase()).includes(id)) hit += 1;
      else if (miss.length < 10) miss.push({ id, src, q: src.toUpperCase() });
    }
    return { tested, hit, miss };
  })()`);
  recordCoverage('大写查询可命中原名', caseReport,
    '全库无含小写字母的书名 —— 该维度无样本可验');

  // ============ 9. 假名：片假名 ↔ 平假名 ============
  section('平假名 ↔ 片假名（全量逐条）');
  const kanaReport = await c.evaluate(`(() => {
    const A = window.__lnAudit;
    const ids = ${JSON.stringify(ids)};
    const toHira = (s) => s.replace(/[\\u30A1-\\u30F6]/g, (ch) =>
      String.fromCharCode(ch.charCodeAt(0) - 0x60));
    let tested = 0, hit = 0; const miss = [];
    for (const id of ids) {
      const it = A.item(id);
      if (!it || it.c || it.gn || it.ver) continue;
      const src = String(it.cn || it.n || '');
      if (!/[\\u30A1-\\u30F6]/.test(src)) continue;
      tested += 1;
      if (A.find(toHira(src)).includes(id)) hit += 1;
      else if (miss.length < 5) miss.push({ id, src: src.slice(0, 30), q: toHira(src).slice(0, 30) });
    }
    return { tested, hit, miss };
  })()`);
  recordCoverage('平假名查询可命中片假名书名', kanaReport,
    '全库无含片假名的书名 —— 该维度无样本可验');

  // ============ 10. 罗马字长音 ー ============
  // 库内把 ー 直接删掉（コーヒー→kohi、アーク→aku），按赫本式双写元音的用户会打
  // koohii / aaku。两个方向都要能命中。判据必须走兜底通道（loose），因为严格匹配下
  // 折叠式查询一本都命中不了，产品逻辑才会切到兜底。
  section('长音符号 ー 的两种写法（全量逐条）');
  const choonReport = await c.evaluate(`(() => {
    const A = window.__lnAudit;
    const ids = ${JSON.stringify(ids)};
    const fold = (s) => String(s || '').replace(/ou/g, 'o').replace(/([aiueo])\\1+/g, '$1');
    let tested = 0, hit = 0; const miss = [];
    for (const id of ids) {
      const it = A.item(id);
      if (!it || it.c || it.gn || it.ver) continue;
      const rpy = String(it.rpyFull || '');
      if (rpy.length < 4) continue;
      const folded = fold(rpy);
      if (folded === rpy) continue;   // 没有长音可折，不属于本项
      tested += 1;
      // 两个方向：用户打折叠式，以及用户打展开式，都必须命中
      const okFolded = A.find(folded, true).includes(id);
      const okRaw = A.find(rpy, true).includes(id);
      if (okFolded && okRaw) hit += 1;
      else if (miss.length < 10) miss.push({ id, rpy: rpy.slice(0, 40), q: folded.slice(0, 40), okFolded, okRaw });
    }
    return { tested, hit, miss };
  })()`);
  recordCoverage('长音折叠/展开两种写法都可命中', choonReport,
    '全库无「折叠后确有变化」的罗马字 —— 长音索引可能未加载');

  // ============ 11. 多关键词 AND ============
  section('多关键词交集（抽样）');
  const multiReport = await c.evaluate(`(() => {
    const A = window.__lnAudit;
    const ids = ${JSON.stringify(ids)};
    let tested = 0, hit = 0; const miss = [];
    for (const id of ids) {
      const it = A.item(id);
      if (!it || it.c || it.gn || it.ver) continue;
      const title = String(it.cn || it.n || '');
      // 取标题前 2 字 + 作者名首字，理论上必须同时命中
      if (title.length < 4 || !it.au) continue;
      const q1 = title.slice(0, 2);
      const q2 = String(it.au).split(/[\\/、,，&]/)[0].trim().slice(0, 2);
      if (q2.length < 2) continue;
      tested += 1;
      const a = A.find(q1);
      const both = a.filter((x) => A.find(q2).includes(x));
      if (both.includes(id)) hit += 1;
      else if (miss.length < 5) miss.push({ id, src: title, q: q1 + ' ' + q2 });
      if (tested >= 200) break;
    }
    return { tested, hit, miss };
  })()`);
  recordCoverage('多关键词交集可命中', multiReport,
    '全库无「标题≥4字且有作者」的样本 —— 作者索引可能未加载');

  // ============ 12. 无关查询必须 0 结果（防误报） ============
  section('无关查询不误报');
  const noiseReport = await c.evaluate(`(() => {
    const A = window.__lnAudit;
    const probes = ['zzzzqqqxxx', 'qwertyuiopasdf', '不存在的书名甲乙丙丁', 'ｑｚｚｚｚ'];
    return probes.map((p) => ({ q: p, n: A.find(p).length }));
  })()`);
  const noisy = noiseReport.filter((x) => x.n > 0);
  record('无关查询返回 0 条', noisy.length === 0,
    noisy.length ? JSON.stringify(noisy) : noiseReport.map((x) => x.q + '=0').join(', '),
    noisy);
} catch (e) {
  console.error('审计异常：', e.message);
  process.exitCode = 1;
} finally {
  try { ws?.close(); } catch {}
  try { child?.kill(); } catch {}
  server.close();
}

// 汇总
console.log('\n' + '='.repeat(70));
let totalChecks = 0, totalFail = 0;
for (const s of sections) {
  const f = s.checks.filter((x) => !x.ok).length;
  totalChecks += s.checks.length;
  totalFail += f;
  console.log(`${f ? 'FAIL' : 'OK  '}  ${s.name}  (${s.checks.length - f}/${s.checks.length})`);
}
console.log('='.repeat(70));
console.log(`\n${totalChecks - totalFail}/${totalChecks} 项通过`);

const gaps = sections.flatMap((s) => s.gaps);
if (gaps.length) {
  console.log('\n漏搜样本：');
  gaps.slice(0, 20).forEach((g) => console.log('  ' + JSON.stringify(g)));
}
if (totalFail) process.exitCode = 1;
