// 为缺中文名的核心条目回查中文名
// 用法：node scripts/fill-bgm-cn.mjs [--limit=300] [--delay=900]
// 两个来源：
//   1) RanobeDB 系列详情缓存里的繁中标题（离线、零请求），按日文原名精确匹配后转简体；
//   2) Bangumi 搜索：同一条目名（日文原名完全一致）的另一个条目若带 name_cn，则采纳。
// 产物 data/cn-fills.json（由 clean-series 应用，只填空值），缓存可续跑。
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import OpenCC from 'opencc-js';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const CORE_FILE = path.join(ROOT, 'data', 'light-novels.js');
const RN_DETAIL_DIR = path.join(ROOT, 'data', 'build', 'ranobedb-series-detail');
const CACHE_DIR = path.join(ROOT, 'data', 'build', 'bgm-cn-search');
const OUT_FILE = path.join(ROOT, 'data', 'cn-fills.json');
const BASE = 'https://bgmapi.anibt.net';
const UA = 'yuc-light-novel-list/1.0';

const arg = (name, fallback) => {
  const hit = process.argv.find((x) => x.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : fallback;
};
const LIMIT = Math.max(1, Number(arg('limit', 300)) || 300);
const DELAY = Math.max(300, Number(arg('delay', 900)) || 900);

const toHans = OpenCC.Converter({ from: 'tw', to: 'cn' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function norm(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s"'“”‘’「」『』【】\[\]()（）:：\-–—~〜!?！？,，.。·、;；]/g, '');
}
function isJpTitle(s) {
  return /[\u3040-\u30ff]/.test(String(s || ''));
}

const coreRaw = await readFile(CORE_FILE, 'utf8');
const core = JSON.parse(coreRaw.match(/window\.LN_DATA\s*=\s*(\[[\s\S]*\]);?/)[1]);

let prev = { fills: {}, checked: [] };
try {
  prev = JSON.parse(await readFile(OUT_FILE, 'utf8'));
} catch { /* 首次运行 */ }
const fills = prev.fills && typeof prev.fills === 'object' ? prev.fills : {};
const checked = new Set(Array.isArray(prev.checked) ? prev.checked.map(String) : Object.keys(fills).map(String));

// ---- 1) RanobeDB 繁中标题（离线） ----
let rnFiles = [];
try {
  rnFiles = (await readdir(RN_DETAIL_DIR)).filter((f) => f.endsWith('.json'));
} catch { /* 没有缓存时跳过 */ }
const rnByTitle = new Map();
for (const file of rnFiles) {
  let d;
  try {
    d = JSON.parse(await readFile(path.join(RN_DETAIL_DIR, file), 'utf8'));
  } catch {
    continue;
  }
  const zh = (Array.isArray(d.titles) ? d.titles : [])
    .find((t) => /^zh/i.test(String(t?.lang || '')) && String(t?.title || '').trim());
  if (!zh) continue;
  const key = norm(d.title);
  if (!key) continue;
  const cn = toHans(String(zh.title).trim());
  if (cn && !rnByTitle.has(key)) rnByTitle.set(key, cn);
}
let rnFilled = 0;
for (const x of core) {
  if (x.cn || !isJpTitle(x.n)) continue;
  const cn = rnByTitle.get(norm(x.n));
  if (cn) {
    fills[String(x.i)] = { cn, src: 'ranobedb' };
    rnFilled += 1;
  }
}
console.log(`RanobeDB 繁中标题命中 ${rnFilled} 条（缓存 ${rnFiles.length} 个系列）`);

// ---- 2) Bangumi 搜索同名声优 ----
async function search(keyword) {
  const file = path.join(CACHE_DIR, `${createHash('sha1').update(keyword).digest('hex').slice(0, 16)}.json`);
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch { /* 继续请求 */ }
  let data = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const res = await fetch(`${BASE}/v0/search/subjects?limit=10&offset=0`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': UA },
        body: JSON.stringify({ keyword, sort: 'heat', filter: { type: [1] } }),
        signal: AbortSignal.timeout(20000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      data = await res.json();
      break;
    } catch (err) {
      if (attempt === 3) throw err;
      await sleep(attempt * 2000);
    }
  }
  const list = Array.isArray(data?.data) ? data.data : [];
  await mkdir(CACHE_DIR, { recursive: true });
  await writeFile(file, JSON.stringify(list), 'utf8');
  await sleep(DELAY);
  return list;
}

const targets = core
  .filter((x) => !x.cn && isJpTitle(x.n) && !fills[String(x.i)] && !checked.has(String(x.i)))
  .sort((a, b) => (b.h || 0) - (a.h || 0))
  .slice(0, LIMIT);

console.log(`Bangumi 搜索待查 ${targets.length} 条`);
let hit = 0;
let missed = 0;
const samples = [];

for (let i = 0; i < targets.length; i += 1) {
  const x = targets[i];
  checked.add(String(x.i));
  let list = [];
  try {
    list = await search(x.n);
  } catch (err) {
    console.log(`进度 ${i + 1}/${targets.length}：${x.n} 失败 ${err.message}`);
    continue;
  }
  const same = list.find((r) => String(r.name_cn || '').trim() &&
    norm(r.name) === norm(x.n) && String(r.id) !== String(x.i));
  if (same) {
    hit += 1;
    fills[String(x.i)] = { cn: String(same.name_cn).trim(), src: 'bangumi:' + same.id };
    if (samples.length < 8) samples.push(`${x.n} → ${same.name_cn}`);
  } else {
    missed += 1;
  }
  if ((i + 1) % 25 === 0) {
    await writeFile(OUT_FILE, `${JSON.stringify({ generatedAt: new Date().toISOString(), stats: { limit: LIMIT, hit, missed }, checked: [...checked], fills })}\n`, 'utf8');
    console.log(`进度 ${i + 1}/${targets.length}：命中 ${hit}`);
  }
}

await writeFile(OUT_FILE, `${JSON.stringify({ generatedAt: new Date().toISOString(), stats: { limit: LIMIT, hit, missed }, checked: [...checked], fills })}\n`, 'utf8');
console.log(`中文名补全：RanobeDB ${rnFilled} 条，Bangumi 搜索命中 ${hit} / ${targets.length}，累计候选 ${Object.keys(fills).length} 条`);
if (samples.length) console.log('样例：\n' + samples.join('\n'));
