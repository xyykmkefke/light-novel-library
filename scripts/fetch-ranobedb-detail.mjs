// 抓取 RanobeDB 系列详情（作者 / 出版社 / 文库），供 build-ranobedb.mjs 补字段
// 用法：
//   node scripts/fetch-ranobedb-detail.mjs --shard=1 --shards=4
//   node scripts/fetch-ranobedb-detail.mjs --limit=100
// 只读接口 + 本地缓存，缓存到 data/build/ranobedb-series-detail/{rid}.json（可中断续跑）
import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const RN_FILE = path.join(ROOT, 'data', 'light-novels-rn.js');
const CACHE_DIR = path.join(ROOT, 'data', 'build', 'ranobedb-series-detail');
const BASE = 'https://ranobedb.org/api/v0/series';
const UA = 'yuc-light-novel-list/1.0';

const arg = (name, fallback) => {
  const hit = process.argv.find((x) => x.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : fallback;
};
const SHARDS = Math.max(1, Number(arg('shards', 1)) || 1);
const SHARD = Math.min(SHARDS, Math.max(1, Number(arg('shard', 1)) || 1));
const LIMIT = Math.max(1, Number(arg('limit', 999999)) || 999999);
const DELAY_MS = Math.max(300, Number(arg('delay', 1100)) || 1100);
// --refresh：重抓并覆盖已有缓存（缓存结构升级时用）
const REFRESH = process.argv.includes('--refresh');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

// 只保留构建需要的字段，避免 8 千多个 10 KB 级原始响应占满磁盘
function trim(series) {
  const staff = (series.staff || []).map((x) => ({
    role: String(x.role_type || ''),
    name: String(x.name || ''),
  })).filter((x) => x.name);
  const publishers = (series.publishers || []).map((x) => ({
    type: String(x.publisher_type || ''),
    name: String(x.name || ''),
    lang: String(x.lang || ''),
  })).filter((x) => x.name);
  // 多语言标题：zh-Hant / zh-Hans 是官方中文名，比回查 Bangumi 更准
  const titles = (series.titles || []).map((x) => ({
    title: String(x.title || '').trim(),
    lang: String(x.lang || ''),
    official: Boolean(x.official),
  })).filter((x) => x.title);
  return {
    id: Number(series.id),
    fetchedAt: new Date().toISOString(),
    title: String(series.title_orig || ''),
    staff,
    publishers,
    titles,
  };
}

async function fetchSeries(id) {
  const url = `${BASE}/${id}`;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(30000) });
      if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      if (!json || !json.series) throw new Error('响应缺少 series');
      return trim(json.series);
    } catch (err) {
      if (attempt === 4) throw new Error(`抓取失败 ${id}：${err.message}`);
      await sleep(attempt * 2500);
    }
  }
}

const raw = await readFile(RN_FILE, 'utf8');
const entries = JSON.parse(raw.match(/window\.LN_RN\s*=\s*(\[[\s\S]*\]);?/)[1]);
const targets = entries
  .map((x) => Number(x.rid))
  .filter((id) => id > 0)
  .sort((a, b) => a - b)
  .slice(0, LIMIT)
  .filter((_, idx) => idx % SHARDS === SHARD - 1);

await mkdir(CACHE_DIR, { recursive: true });
console.log(`分片 ${SHARD}/${SHARDS}：目标 ${targets.length} 个系列（缓存目录 data/build/ranobedb-series-detail）`);

let done = 0;
let fetched = 0;
let skipped = 0;
for (const id of targets) {
  done += 1;
  const file = path.join(CACHE_DIR, `${id}.json`);
  if (!REFRESH && await exists(file)) {
    skipped += 1;
    continue;
  }
  const record = await fetchSeries(id);
  await writeFile(file, JSON.stringify(record), 'utf8');
  fetched += 1;
  if (done % 100 === 0) console.log(`  进度 ${done}/${targets.length}（新抓 ${fetched}，跳过 ${skipped}）`);
  await sleep(DELAY_MS);
}

console.log(`分片 ${SHARD} 完成：新抓 ${fetched}，缓存命中 ${skipped}，合计 ${targets.length}`);
