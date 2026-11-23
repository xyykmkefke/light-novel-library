// 用 openBD 补日文书志：レーベル、出版社、发售日、ISBN
// 用法：node scripts/enrich-openbd.mjs
// 读取 data/light-novels-extra.js，按 ISBN 批量查询 openBD，把结果写回 extra 包。
// 结果按 ISBN 缓存在 data/build/openbd/，可重复运行增量补齐。
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const EXTRA_FILE = path.join(ROOT, 'data', 'light-novels-extra.js');
const CACHE_DIR = path.join(ROOT, 'data', 'build', 'openbd');
const BATCH = 100;
const DELAY_MS = 500;
const UA = 'yuc-light-novel-list/1.0';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function toIsbn13(code) {
  const raw = String(code || '').replace(/[^0-9Xx]/g, '').toUpperCase();
  if (raw.length === 13) return /^\d{13}$/.test(raw) ? raw : '';
  if (raw.length !== 10) return '';
  const body = '978' + raw.slice(0, 9);
  const sum = body.split('').reduce((n, d, i) => n + Number(d) * (i % 2 ? 3 : 1), 0);
  return body + ((10 - (sum % 10)) % 10);
}

function cleanSeries(value) {
  return String(value || '').split(':')[0].split('：')[0].trim();
}

// openBD 的 pubdate 可能是 201702 / 2017-02 / 2017，统一成 YYYY-MM 或 YYYY-MM-DD
function normalizeDate(value) {
  const s = String(value || '').trim();
  if (/^\d{6}$/.test(s)) return `${s.slice(0, 4)}-${s.slice(4)}`;
  if (/^\d{8}$/.test(s)) return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6)}`;
  const m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  if (/^\d{4}-\d{2}$/.test(s) || /^\d{4}$/.test(s)) return s;
  return '';
}

async function requestBatch(isbns) {
  const url = `https://api.openbd.jp/v1/get?isbn=${isbns.join(',')}`;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': UA },
        signal: AbortSignal.timeout(30000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      if (attempt === 3) throw err;
      console.warn(`  重试 ${attempt}/2：${err.message}`);
      await sleep(attempt * 2000);
    }
  }
}

await mkdir(CACHE_DIR, { recursive: true });
const raw = await readFile(EXTRA_FILE, 'utf8');
const match = raw.match(/window\.LN_EXTRA\s*=\s*(\{[\s\S]*\});?/);
if (!match) throw new Error('未找到 window.LN_EXTRA');
const extra = JSON.parse(match[1]);

const targets = [];
for (const [id, fields] of Object.entries(extra)) {
  const isbn = toIsbn13(fields.isbn);
  if (isbn) targets.push({ id, isbn });
}
console.log(`待补条目：${targets.length}`);

const cacheFile = (isbn) => path.join(CACHE_DIR, `${isbn}.json`);
let queried = 0;
let found = 0;
let lineFilled = 0;
let pubFilled = 0;
let coverCount = 0;

for (let i = 0; i < targets.length; i += BATCH) {
  const batch = targets.slice(i, i + BATCH);
  const missing = [];
  for (const t of batch) {
    try {
      t.data = JSON.parse(await readFile(cacheFile(t.isbn), 'utf8'));
    } catch {
      missing.push(t);
    }
  }

  if (missing.length) {
    const data = await requestBatch(missing.map((x) => x.isbn));
    queried += missing.length;
    for (let k = 0; k < missing.length; k += 1) {
      const item = Array.isArray(data) ? data[k] : null;
      const summary = item?.summary || null;
      const record = summary ? {
        isbn: summary.isbn || missing[k].isbn,
        line: cleanSeries(summary.series),
        pub: String(summary.publisher || '').trim(),
        d: normalizeDate(summary.pubdate),
        img: String(summary.cover || '').trim(),
      } : null;
      missing[k].data = record;
      await writeFile(cacheFile(missing[k].isbn), JSON.stringify(record), 'utf8');
    }
    await sleep(DELAY_MS);
  }

  for (const t of batch) {
    if (!t.data) continue;
    found += 1;
    const fields = extra[t.id];
    fields.isbn = t.isbn;
    if (!fields.line && t.data.line) {
      fields.line = t.data.line;
      lineFilled += 1;
    }
    if (!fields.pub && t.data.pub) {
      fields.pub = t.data.pub;
      pubFilled += 1;
    }
    if (t.data.d) {
      const jd = normalizeDate(t.data.d);
      if (jd) fields.jd = jd;
    }
    if (t.data.img) coverCount += 1;
  }
  console.log(`进度 ${Math.min(i + BATCH, targets.length)}/${targets.length}，命中 ${found}`);
}

const header = '// 由 scripts/fetch-books.mjs / clean-series.mjs 生成，请勿手动修改\n';
await writeFile(EXTRA_FILE, header + `window.LN_EXTRA = ${JSON.stringify(extra)};\n`, 'utf8');
console.log(`openBD 完成：查询 ${queried} 条，命中 ${found} 条，补书系 ${lineFilled}、出版社 ${pubFilled}，有封面 ${coverCount}`);
console.log(`已写回 ${path.relative(ROOT, EXTRA_FILE)}`);
