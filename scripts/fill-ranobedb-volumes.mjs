// 用 RanobeDB 补齐现有日文系列的缺失卷，输出 data/ranobedb-volume-fixes.json
// 用法：node scripts/fill-ranobedb-volumes.mjs [--dry]
// 只接受系列标题精确同名；卷目按日文原名与发售日筛选，不修改 Bangumi 数据。
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { initials } from './build-pinyin.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const SEARCH_CACHE = path.join(ROOT, 'data', 'build', 'ranobedb-series');
const DETAIL_CACHE = path.join(ROOT, 'data', 'build', 'ranobedb-series-detail');
const OUT_FILE = path.join(ROOT, 'data', 'ranobedb-volume-fixes.json');
const BASE = 'https://ranobedb.org/api/v0';
const UA = 'yuc-light-novel-list/1.0';
const DELAY_MS = 1100;
const DRY = process.argv.includes('--dry');
const VOLUME_ID_BASE = 810000000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

async function cachedFetch(url, file, key) {
  try {
    return await readJson(file);
  } catch { /* 继续请求 */ }
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(30000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      await writeFile(file, JSON.stringify(data), 'utf8');
      await sleep(DELAY_MS);
      return data;
    } catch (err) {
      if (attempt === 3) throw new Error(`${key}: ${err.message}`);
      await sleep(attempt * 2000);
    }
  }
}

function cacheKey(value) {
  return createHash('sha1').update(value).digest('hex').slice(0, 16);
}

async function searchSeries(title) {
  const key = cacheKey(title);
  const data = await cachedFetch(
    `${BASE}/series?q=${encodeURIComponent(title)}`,
    path.join(SEARCH_CACHE, `${key}.json`),
    title,
  );
  return Array.isArray(data?.series) ? data.series : [];
}

async function seriesDetail(id) {
  return cachedFetch(`${BASE}/series/${id}`, path.join(DETAIL_CACHE, `${id}.json`), `series/${id}`);
}

function pickSeries(list, title) {
  const base = norm(title);
  if (!base) return null;
  return list.find((s) => norm(s.title_orig) === base) || null;
}

await mkdir(SEARCH_CACHE, { recursive: true });
await mkdir(DETAIL_CACHE, { recursive: true });

const data = JSON.parse((await readFile(path.join(ROOT, 'data', 'light-novels.js'), 'utf8'))
  .match(/window\.LN_DATA\s*=\s*(\[[\s\S]*\]);?/)[1]);
const volumes = JSON.parse((await readFile(path.join(ROOT, 'data', 'light-novels-volumes.js'), 'utf8'))
  .match(/window\.LN_VOLUMES\s*=\s*(\[[\s\S]*\]);?/)[1]);
const byId = new Map([...data, ...volumes].map((x) => [String(x.i), x]));

const targets = data.filter((x) => x.sv && !x.ver && /[\u3040-\u30ff]/.test(x.n || '')
  && ((x.v || 0) > (x.ch || []).length || !(x.ch || []).length));
targets.sort((a, b) => (b.h || 0) - (a.h || 0));

// 已生成的补卷保留下来，重复运行只做增量，避免目标已被补齐后被空结果覆盖
let previous = {};
try {
  previous = JSON.parse(await readFile(OUT_FILE, 'utf8')).parents || {};
} catch { /* 首次生成 */ }
const parents = { ...previous };
const unmatched = [];
let added = 0;
let kept = Object.values(previous).reduce((n, p) => n + (p.volumes?.length || 0), 0);

for (let index = 0; index < targets.length; index += 1) {
  const item = targets[index];
  const title = String(item.n || '').trim();
  const list = await searchSeries(title);
  const hit = pickSeries(list, title);
  if (!hit) {
    if (parents[String(item.i)]) console.log(`进度 ${index + 1}/${targets.length}：${title} 未匹配，保留已有补卷`);
    else unmatched.push(`${item.i} ${item.cn || item.n}`);
    console.log(`进度 ${index + 1}/${targets.length}：${title} 未匹配`);
    continue;
  }
  const detail = await seriesDetail(hit.id);
  const series = detail?.series || {};
  const books = (Array.isArray(series.books) ? series.books : [])
    .filter((b) => b && String(b.title_orig || '').trim())
    .filter((b) => !b.book_type || b.book_type === 'main')
    .filter((b) => {
      const d = b.c_release_dates?.ja || b.c_release_date;
      return Number(d) >= 19000101 && Number(d) < 99999999;
    })
    .sort((a, b) => Number(a.sort_order || 0) - Number(b.sort_order || 0) ||
      Number(a.c_release_dates?.ja || a.c_release_date || 0) -
      Number(b.c_release_dates?.ja || b.c_release_date || 0));

  const existing = new Set((item.ch || []).map((id) => norm(byId.get(String(id))?.n)).filter(Boolean));
  const missing = books.filter((b) => !existing.has(norm(b.title_orig)));
  const cap = item.v ? Math.max(0, Number(item.v) - (item.ch || []).length) : missing.length;
  const picked = missing.slice(0, cap).map((b) => {
    const filename = b.image && b.image.filename;
    return {
      i: VOLUME_ID_BASE + Number(b.id),
      n: String(b.title_orig).trim(),
      cn: '',
      d: fmtDate(b.c_release_dates?.ja || b.c_release_date),
      img: filename ? `https://images.ranobedb.org/${filename}` : '',
      sv: false,
      c: true,
      ns: false,
      py: initials(b.title_orig),
      rvol: true,
      rid: Number(b.id),
    };
  });
  if (!picked.length) {
    console.log(`进度 ${index + 1}/${targets.length}：${title} 无新增卷${parents[String(item.i)] ? '，保留已有补卷' : ''}`);
    continue;
  }
  parents[String(item.i)] = {
    name: item.cn || item.n,
    seriesId: hit.id,
    volumes: picked,
  };
  added += picked.length;
  console.log(`进度 ${index + 1}/${targets.length}：${title} 补 ${picked.length} 卷`);
}

const payload = {
  generatedAt: new Date().toISOString(),
  source: 'RanobeDB',
  sourceUrl: 'https://ranobedb.org',
  license: 'ODbL',
  parents,
};
if (!DRY) await writeFile(OUT_FILE, JSON.stringify(payload, null, 2) + '\n', 'utf8');

console.log(`目标系列 ${targets.length}；本次新增 ${added} 卷；累计 ${Object.keys(parents).length} 个系列 / ${kept + added} 卷`);
console.log(`未匹配 ${unmatched.length} 个：${unmatched.slice(0, 12).join('；')}`);
console.log(DRY ? '（dry-run，未写入）' : `输出：${OUT_FILE}`);
