// 用 RanobeDB 目录缓存补缺失的系列册数与首卷发售日（离线，零请求）
// 用法：node scripts/fill-ranobedb-counts.mjs
// 读取 data/build/ranobedb-catalog/page-*.json（由 build-ranobedb.mjs 抓取），
// 按日文原名精确匹配核心条目，产物写入 data/ranobedb-counts.json，由 clean-series 应用。
// 只填空值；册数取 max(RanobeDB 卷数, 本地子卷数)，避免比实际子卷少而提前触发「读完」。
import { readFile, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const CATALOG_DIR = path.join(ROOT, 'data', 'build', 'ranobedb-catalog');
const CORE_FILE = path.join(ROOT, 'data', 'light-novels.js');
const OUT_FILE = path.join(ROOT, 'data', 'ranobedb-counts.json');

function norm(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s"'“”‘’「」『』【】\[\]()（）:：\-–—~〜!?！？,，.。·、]/g, '');
}

function dateFromCompact(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0 || n >= 99999999) return '';
  const s = String(Math.trunc(n)).padStart(8, '0');
  const y = Number(s.slice(0, 4));
  const m = Number(s.slice(4, 6));
  const d = Number(s.slice(6, 8));
  if (y < 1700 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return '';
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return '';
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

const coreRaw = await readFile(CORE_FILE, 'utf8');
const coreMatch = coreRaw.match(/window\.LN_DATA\s*=\s*(\[[\s\S]*\]);?/);
if (!coreMatch) throw new Error('未找到 window.LN_DATA');
const core = JSON.parse(coreMatch[1]);

let files = [];
try {
  files = (await readdir(CATALOG_DIR)).filter((f) => /^page-.+\.json$/.test(f)).sort();
} catch {
  throw new Error('未找到 RanobeDB 目录缓存，请先运行 npm run build-rn');
}
if (!files.length) throw new Error('RanobeDB 目录缓存为空，请先运行 npm run build-rn');

const byTitle = new Map();
for (const file of files) {
  const list = JSON.parse(await readFile(path.join(CATALOG_DIR, file), 'utf8'));
  for (const series of Array.isArray(list) ? list : []) {
    const key = norm(series.title_orig);
    if (!key || byTitle.has(key)) continue;
    byTitle.set(key, series);
  }
}

const counts = {};
const stats = { catalog: byTitle.size, matched: 0, vFilled: 0, dFilled: 0 };
for (const item of core) {
  const series = byTitle.get(norm(item.n));
  if (!series) continue;
  stats.matched += 1;
  const entry = {};
  const chn = Number(item.chn) || (Array.isArray(item.ch) ? item.ch.length : 0);
  const rnCount = Math.max(0, Number(series.c_num_books) || 0);
  if (!Number(item.v) && rnCount > 0) {
    entry.v = Math.max(rnCount, chn);
    stats.vFilled += 1;
  }
  if (!item.d) {
    const d = dateFromCompact(series.c_start_date);
    if (d) {
      entry.d = d;
      stats.dFilled += 1;
    }
  }
  if (Object.keys(entry).length) counts[String(item.i)] = entry;
}

await writeFile(OUT_FILE, `${JSON.stringify({ generatedAt: new Date().toISOString(), stats, counts })}\n`, 'utf8');
console.log(`RanobeDB 册数：目录 ${stats.catalog} 个系列，同名命中 ${stats.matched} 条，补册数 ${stats.vFilled}、首发日 ${stats.dFilled} → ${path.relative(ROOT, OUT_FILE)}`);
