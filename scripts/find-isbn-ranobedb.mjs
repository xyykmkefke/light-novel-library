// 用 RanobeDB 公共 API 为缺少 ISBN 的条目补 ISBN
// 用法：node scripts/find-isbn-ranobedb.mjs [--limit=300]
// 单册补 isbn；系列补首卷 isbn（fisbn）。只读查询，结果按标题缓存在 data/build/ranobedb/。
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const EXTRA_FILE = path.join(ROOT, 'data', 'light-novels-extra.js');
const CACHE_DIR = path.join(ROOT, 'data', 'build', 'ranobedb');
const BASE = 'https://ranobedb.org/api/v0';
const DELAY_MS = 1100;
const UA = 'yuc-light-novel-list/1.0';
const limitArg = process.argv.find((x) => x.startsWith('--limit='));
const LIMIT = limitArg ? Math.max(1, Number(limitArg.split('=')[1]) || 1000) : 1000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function norm(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s"'“”‘’「」『』【】\[\]()（）:：\-–—~〜!?！？,，.。·、]/g, '');
}

const SPINOFF_RE = /(AA|SP|公式|ガイド|アンソロジー|短編集|外伝|番外|画集|設定|オフィシャル|ベスト|選集|総集編|ストーリーズ|学園物語|盤外編|side|if|artworks)/i;

function pickRelease(list, base, forSeries) {
  const exact = list.find((r) => norm(r.title) === base);
  if (exact) return exact;
  if (!forSeries) return list.find((r) => norm(r.title).startsWith(base) && base.length >= 4) || null;
  const main = list.filter((r) => {
    const n = norm(r.title);
    if (!n.startsWith(base)) return false;
    const suffix = String(r.title || '').slice(String(r.title || '').length - 20);
    return !SPINOFF_RE.test(suffix);
  });
  main.sort((a, b) => String(a.release_date_parsed || '').localeCompare(String(b.release_date_parsed || '')));
  return main[0] || null;
}

function validIsbn(code) {
  if (!/^\d{13}$/.test(String(code || ''))) return false;
  const c = String(code);
  const sum = c.slice(0, 12).split('').reduce((n, d, i) => n + Number(d) * (i % 2 ? 3 : 1), 0);
  return (10 - (sum % 10)) % 10 === Number(c[12]);
}

async function searchReleases(title) {
  const key = createHash('sha1').update(title).digest('hex').slice(0, 16);
  const file = path.join(CACHE_DIR, `${key}.json`);
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch { /* 继续查询 */ }
  const url = `${BASE}/releases?q=${encodeURIComponent(title)}`;
  let data = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(30000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      data = await res.json();
      break;
    } catch (err) {
      if (attempt === 3) throw err;
      await sleep(attempt * 2000);
    }
  }
  const releases = Array.isArray(data?.releases) ? data.releases : [];
  await writeFile(file, JSON.stringify({ title, releases }), 'utf8');
  await sleep(DELAY_MS);
  return { title, releases };
}

await mkdir(CACHE_DIR, { recursive: true });
const raw = await readFile(EXTRA_FILE, 'utf8');
const match = raw.match(/window\.LN_EXTRA\s*=\s*(\{[\s\S]*\});?/);
if (!match) throw new Error('未找到 window.LN_EXTRA');
const extra = JSON.parse(match[1]);
const dataRaw = await readFile(path.join(ROOT, 'data', 'light-novels.js'), 'utf8');
const data = JSON.parse(dataRaw.match(/window\.LN_DATA\s*=\s*(\[[\s\S]*\]);?/)[1]);

const targets = data
  .filter((x) => {
    const fields = extra[String(x.i)] || {};
    if (x.gn) return false;
    // RanobeDB 只覆盖日文书志；中文 / 英文标题不再逐条查询
    if (!/[\u3040-\u30ff]/.test(x.n || '')) return false;
    if (x.sv) return !fields.isbn && !fields.fisbn;
    return !fields.isbn;
  })
  .sort((a, b) => (b.h || 0) - (a.h || 0))
  .slice(0, LIMIT);

let singleFilled = 0;
let seriesFilled = 0;
let matched = 0;
const header = '// 由 scripts/fetch-books.mjs / clean-series.mjs 生成，请勿手动修改\n';
// 每 20 条写回一次，长任务中断也不会丢掉已查到的 ISBN
async function flush() {
  await writeFile(EXTRA_FILE, header + `window.LN_EXTRA = ${JSON.stringify(extra)};\n`, 'utf8');
}

for (let i = 0; i < targets.length; i += 1) {
  const item = targets[i];
  const title = String(item.n || item.cn || '').trim();
  if (!title) continue;
  const { releases } = await searchReleases(title);
  const valid = releases.filter((r) => validIsbn(r.isbn13));
  if (!valid.length) {
    console.log(`进度 ${i + 1}/${targets.length}：${title} 无 ISBN`);
    continue;
  }
  matched += 1;
  const base = norm(title);
  const fields = extra[String(item.i)] || (extra[String(item.i)] = {});
  if (item.sv) delete fields.fisbn;
  if (!item.sv) {
    const hit = pickRelease(valid, base, false);
    if (hit) {
      fields.isbn = hit.isbn13;
      singleFilled += 1;
    }
  } else {
    const hit = pickRelease(valid, base, true);
    if (hit) {
      fields.fisbn = hit.isbn13;
      seriesFilled += 1;
    }
  }
  console.log(`进度 ${i + 1}/${targets.length}：${title} ${fields.isbn || fields.fisbn || '未匹配'}`);
  if ((i + 1) % 20 === 0) await flush();
}

await flush();
console.log(`RanobeDB 完成：查询 ${targets.length} 条，有 ISBN 结果 ${matched} 条，单册补 ${singleFilled}，系列补首卷 ${seriesFilled}`);
