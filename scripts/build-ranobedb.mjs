// 生成 RanobeDB 扩展书目：≥2 卷、日文原名、与现有库去重
// 用法：node scripts/build-ranobedb.mjs
// 数据来源：https://ranobedb.org（ODbL），目录缓存在 data/build/ranobedb-catalog/
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { initials } from './build-pinyin.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const CACHE_DIR = path.join(ROOT, 'data', 'build', 'ranobedb-catalog');
const OUT_FILE = path.join(ROOT, 'data', 'light-novels-rn.js');
const BASE = 'https://ranobedb.org/api/v0/series';
const UA = 'yuc-light-novel-list/1.0';
const LIMIT = 250;
const DELAY_MS = 1100;
const MIN_VOLUMES = 2;
const ID_BASE = 800000000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function norm(value) {
  return String(value || '').normalize('NFKC').toLowerCase()
    .replace(/[\s"'“”‘’「」『』【】\[\]()（）:：\-–—~〜!?！？,，.。·、・]/g, '');
}

function fmtDate(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 19000101 || n >= 99999999) return '';
  const s = String(n);
  const month = Number(s.slice(4, 6));
  const day = Number(s.slice(6, 8));
  if (month < 1 || month > 12 || day < 1 || day > 31) return '';
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
}

function excludedTitle(title) {
  return /(画集|イラスト集|公式ガイド|ガイドブック|設定資料|アンソロジー|ファンブック|ふぁんぶっく)/.test(title);
}

// 与本地标题比对：完全同名，或本地标题只是在系列名后追加卷号/「シリーズ」
const VOLUME_SUFFIX_RE = /^(?:第?\d+|[上中下]|vol\.?\d*|no\.?\d*|シリーズ|series|全集)/i;

function buildDuplicateChecker(titles) {
  const exact = new Set(titles);
  const sorted = [...titles].sort((a, b) => b.length - a.length);
  return function isDuplicate(title) {
    const key = norm(title);
    if (!key) return true;
    if (exact.has(key)) return true;
    for (const local of sorted) {
      if (local.length <= key.length) continue;
      if (!local.startsWith(key)) continue;
      if (VOLUME_SUFFIX_RE.test(local.slice(key.length))) return true;
    }
    for (const local of sorted) {
      if (key.length <= local.length) continue;
      if (!key.startsWith(local)) continue;
      if (VOLUME_SUFFIX_RE.test(key.slice(local.length))) return true;
    }
    return false;
  };
}

async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

async function loadCatalog() {
  await mkdir(CACHE_DIR, { recursive: true });
  let meta = null;
  try {
    meta = await readJson(path.join(CACHE_DIR, 'meta.json'));
  } catch { /* 首次抓取 */ }

  if (!meta) {
    const first = await fetchJson(`${BASE}?limit=${LIMIT}&page=1`);
    meta = { count: first.count, totalPages: first.totalPages, fetched: 1 };
    await writeFile(path.join(CACHE_DIR, 'page-0001.json'), JSON.stringify(first.series || []), 'utf8');
    await writeFile(path.join(CACHE_DIR, 'meta.json'), JSON.stringify(meta), 'utf8');
    await sleep(DELAY_MS);
    console.log(`RanobeDB 目录：${meta.count} 个系列，共 ${meta.totalPages} 页`);
  }

  for (let page = (meta.fetched || 1) + 1; page <= meta.totalPages; page += 1) {
    const file = path.join(CACHE_DIR, `page-${String(page).padStart(4, '0')}.json`);
    try {
      await readFile(file);
      continue;
    } catch { /* 继续抓取 */ }
    const json = await fetchJson(`${BASE}?limit=${LIMIT}&page=${page}`);
    await writeFile(file, JSON.stringify(json.series || []), 'utf8');
    meta.fetched = page;
    await writeFile(path.join(CACHE_DIR, 'meta.json'), JSON.stringify(meta), 'utf8');
    if (page % 10 === 0) console.log(`RanobeDB 目录进度 ${page}/${meta.totalPages}`);
    await sleep(DELAY_MS);
  }

  const series = [];
  for (const file of (await readdir(CACHE_DIR)).filter((x) => /^page-\d+\.json$/.test(x)).sort()) {
    series.push(...await readJson(path.join(CACHE_DIR, file)));
  }
  return series;
}

async function fetchJson(url) {
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
      await sleep(attempt * 2000);
    }
  }
}

const coreRaw = await readFile(path.join(ROOT, 'data', 'light-novels.js'), 'utf8');
const core = JSON.parse(coreRaw.match(/window\.LN_DATA\s*=\s*(\[[\s\S]*\]);?/)[1]);
const volumeRaw = await readFile(path.join(ROOT, 'data', 'light-novels-volumes.js'), 'utf8');
const volumes = JSON.parse(volumeRaw.match(/window\.LN_VOLUMES\s*=\s*(\[[\s\S]*\]);?/)[1]);

const localTitles = [];
[...core, ...volumes].forEach((x) => {
  const n = norm(x.n);
  const cn = norm(x.cn);
  if (n) localTitles.push(n);
  if (cn) localTitles.push(cn);
});
const isDuplicate = buildDuplicateChecker(localTitles);

const catalog = await loadCatalog();
const seenTitles = new Set();
const picked = [];

for (const s of catalog) {
  if (!s || s.hidden) continue;
  const title = String(s.title_orig || '').trim();
  if (!title || !/[\u3040-\u30ff]/.test(title)) continue;
  if (!(Number(s.c_num_books) >= MIN_VOLUMES)) continue;
  if (excludedTitle(title)) continue;
  if (isDuplicate(title)) continue;
  const key = norm(title);
  if (!key || seenTitles.has(key)) continue;
  seenTitles.add(key);
  picked.push(s);
}

picked.sort((a, b) => (Number(b.c_start_date) || 0) - (Number(a.c_start_date) || 0) ||
  (Number(b.c_num_books) || 0) - (Number(a.c_num_books) || 0));

const entries = picked.map((s) => {
  const filename = s.book && s.book.image && s.book.image.filename;
  return {
    i: ID_BASE + Number(s.id),
    n: String(s.title_orig).trim(),
    en: String(s.title || '').trim(),
    d: fmtDate(s.c_start_date),
    v: Number(s.c_num_books) || 0,
    sv: true,
    c: false,
    ns: false,
    img: filename ? `https://images.ranobedb.org/${filename}` : '',
    py: initials(s.title_orig),
    rn: true,
    rid: Number(s.id),
  };
});

const dates = entries.map((x) => x.d).filter(Boolean).sort();
const meta = {
  generatedAt: new Date().toISOString(),
  count: entries.length,
  volumes: entries.reduce((n, x) => n + (Number(x.v) || 0), 0),
  minDate: dates[0] || '',
  maxDate: dates[dates.length - 1] || '',
  minVolumes: MIN_VOLUMES,
  source: 'RanobeDB',
  sourceUrl: 'https://ranobedb.org',
  license: 'ODbL',
};

const content = '// 由 scripts/build-ranobedb.mjs 生成，请勿手动修改\n' +
  '// 数据来源：RanobeDB（https://ranobedb.org），ODbL 授权\n' +
  `window.LN_RN_META = ${JSON.stringify(meta)};\n` +
  `window.LN_RN = ${JSON.stringify(entries)};\n`;
await writeFile(OUT_FILE, content, 'utf8');

console.log(`RanobeDB 扩展书目：${entries.length} 个系列 / ${meta.volumes} 卷`);
console.log(`日期范围：${meta.minDate || '—'} ~ ${meta.maxDate || '—'}`);
console.log(`输出：${OUT_FILE}`);
