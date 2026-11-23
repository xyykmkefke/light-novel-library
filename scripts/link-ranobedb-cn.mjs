// 为 RanobeDB 扩展书目回查 Bangumi 中文名（试点 / 全量共用）
// 用法：
//   node scripts/link-ranobedb-cn.mjs --limit=500 --min-volumes=5        // 单进程试点
//   node scripts/link-ranobedb-cn.mjs --shard=1 --shards=4                // 分片并行
//   node scripts/link-ranobedb-cn.mjs --merge                             // 合并分片
//   node scripts/link-ranobedb-cn.mjs --merge --out=data/ranobedb-cn.json // 产出线上映射
//
// 只读 RanobeDB 数据，不修改 data/light-novels-rn.js；映射产物默认落在
// data/build/ranobedb-cn-pilot/merged.json，确认质量后再用 --out 写正式文件。
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const RN_FILE = path.join(ROOT, 'data', 'light-novels-rn.js');
const WORK_DIR = path.join(ROOT, 'data', 'build', 'ranobedb-cn-pilot');
const CACHE_DIR = path.join(WORK_DIR, 'search');
const BASE = process.env.BGM_BASE || 'https://bgmapi.anibt.net';
const UA = 'yuc-light-novel-list/1.0';
const SITE = 'https://bgm.tv';

const arg = (name, fallback) => {
  const hit = process.argv.find((x) => x.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : fallback;
};
const flag = (name) => process.argv.includes(`--${name}`);

const SHARDS = Math.max(1, Number(arg('shards', 1)) || 1);
const SHARD = Math.min(SHARDS, Math.max(1, Number(arg('shard', 1)) || 1));
const LIMIT = Math.max(1, Number(arg('limit', 500)) || 500);
const MIN_VOLUMES = Math.max(2, Number(arg('min-volumes', 5)) || 5);
const DELAY_MS = Math.max(300, Number(arg('delay', 1200)) || 1200);
const MERGE = flag('merge');
// 首轮查不到时，用「去副标题 / 去括号 / 去シリーズ」的变体再查一次（只提高召回，匹配仍按原题判定）
const FALLBACK = flag('fallback');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function norm(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s"'“”‘’「」『』【】\[\]()（）:：\-–—~〜!?！？,，.。·、・/／]/g, '');
}

function yearOf(value) {
  const m = String(value || '').match(/(19|20)\d{2}/);
  return m ? Number(m[0]) : null;
}

function bigrams(s) {
  const out = new Map();
  for (let i = 0; i < s.length - 1; i += 1) {
    const g = s.slice(i, i + 2);
    out.set(g, (out.get(g) || 0) + 1);
  }
  return out;
}

function dice(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const A = bigrams(a);
  const B = bigrams(b);
  let inter = 0;
  let total = 0;
  for (const [g, n] of A) {
    total += n;
    const m = B.get(g);
    if (m) inter += Math.min(n, m);
  }
  for (const n of B.values()) total += n;
  return total ? (2 * inter) / total : 0;
}

// 单卷条目（"标题 (3)" / "第2巻" / "上巻"）不是系列，回查中文名时应排除
const VOLUME_ENTRY_RE = /(?:[(（]\s*\d{1,3}\s*[)）]|第\s*\d{1,3}\s*[巻卷]|(?:上|中|下)\s*巻)\s*$/;
// 外传 / 短篇集 / 公式书等，标题相同也可能不是同一部作品
const SPINOFF_RE = /(外伝|番外|短編集|短篇集|アンソロジー|公式|画集|イラスト集|ガイドブック|設定資料|ファンブック|総集編|選集|ベスト|サイドストーリー|スピンオフ|remix|re:?mix)/i;

function titleRelation(rnName, bgmName) {
  const a = norm(rnName);
  const b = norm(bgmName);
  if (!a || !b) return null;
  if (a === b) return 'exact';
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  if (short.length >= 5 && long.includes(short) && short.length / long.length >= 0.6) return 'contain';
  if (dice(a, b) >= 0.82) return 'near';
  return null;
}

const REL_SCORE = { exact: 3, contain: 2, near: 1 };

function platformFlags(candidate) {
  const platform = String(candidate.platform || '');
  const tags = (candidate.tags || []).map((t) => String(t && t.name ? t.name : ''));
  const novel = /小说|小說|轻小说|輕小說|novel/i.test(platform) ||
    tags.some((t) => /^(轻小说|輕小說|小说|小說)$/.test(t));
  const manga = /漫画|漫畫|manga|comic/i.test(platform) ||
    tags.some((t) => /^(漫画|漫畫|manga|comic)$/i.test(t));
  return { novel, manga, platform };
}

function infoboxValue(infobox, key) {
  if (!Array.isArray(infobox)) return '';
  const hit = infobox.find((x) => x && String(x.key || '').trim() === key);
  if (!hit) return '';
  const v = hit.value;
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.map((x) => (x && typeof x === 'object' ? x.v : x)).filter(Boolean).join(' / ');
  if (v && typeof v === 'object') return String(v.v || '');
  return '';
}

function pickMatch(entry, candidates) {
  const rnYear = yearOf(entry.d);
  const scored = [];

  for (const c of candidates) {
    const cn = String(c.name_cn || '').trim();
    const name = String(c.name || '').trim();
    if (!cn || !name) continue;
    if (VOLUME_ENTRY_RE.test(name)) continue;

    const rel = titleRelation(entry.n, name);
    if (!rel) continue;
    if (rel !== 'exact' && SPINOFF_RE.test(name.replace(entry.n, ''))) continue;
    // 扩展条目本身是外传/短篇集时，不允许挂到不含同一标记的正传条目上
    if (SPINOFF_RE.test(entry.n) && !SPINOFF_RE.test(name)) continue;

    const tol = rel === 'exact' ? 5 : 3;
    const bgmYear = yearOf(c.date);
    if (rnYear && bgmYear && Math.abs(rnYear - bgmYear) > tol) continue;

    const { novel, manga, platform } = platformFlags(c);
    const bgmVolumes = Number(c.volumes) || 0;
    const volumeOk = bgmVolumes && entry.v
      ? bgmVolumes >= Math.max(1, Math.floor(entry.v * 0.4)) && bgmVolumes <= Math.ceil(entry.v * 2.5)
      : null;
    if (volumeOk === false && rel !== 'exact') continue;

    const ratingTotal = Number(c.rating && c.rating.total) || 0;
    const ratingScore = Number(c.rating && c.rating.score) || 0;
    let score = REL_SCORE[rel] * 100;
    if (novel) score += 25;
    if (manga && !novel) score -= 15;
    if (volumeOk === true) score += 10;
    if (rnYear && bgmYear) score += Math.max(0, 5 - Math.abs(rnYear - bgmYear));
    score += Math.min(9, ratingTotal / 60) + ratingScore / 2;

    scored.push({
      cn,
      bgm: Number(c.id),
      how: rel,
      manga: manga && !novel,
      bgmName: name,
      bgmDate: c.date || '',
      platform,
      bgmVolumes,
      ratingTotal,
      score: Math.round(score * 10) / 10,
      url: `${SITE}/subject/${c.id}`,
    });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored[0] || null;
}

function cacheKey(title) {
  return createHash('sha1').update(title).digest('hex').slice(0, 16);
}

// 副标题、尾部括号、系列名后缀会拖累 Bangumi 搜索召回，首轮无果时退化为主标题再查
function titleVariants(title) {
  const source = String(title || '').trim();
  const out = [];
  const push = (value) => {
    const v = String(value || '').trim();
    if (v.length >= 4 && v !== source && !out.includes(v)) out.push(v);
  };
  push(source.replace(/[（(][^（）()]{1,40}[）)]\s*$/, ''));
  push(source.split(/[〜～―—]|\s-\s/)[0]);
  push(source.replace(/\s*シリーズ\s*$/, ''));
  return out.slice(0, 3);
}

let lastRequestAt = 0;
async function throttle() {
  const wait = DELAY_MS - (Date.now() - lastRequestAt);
  if (wait > 0) await sleep(wait);
  lastRequestAt = Date.now();
}

async function searchSubject(title) {
  const file = path.join(CACHE_DIR, `${cacheKey(title)}.json`);
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch { /* 未缓存，走网络 */ }

  const url = `${BASE}/v0/search/subjects?limit=10`;
  const body = JSON.stringify({ keyword: title, sort: 'match', filter: { type: [1] } });
  let payload = null;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    await throttle();
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': UA },
        body,
        signal: AbortSignal.timeout(30000),
      });
      if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      payload = await res.json();
      break;
    } catch (err) {
      if (attempt === 4) throw new Error(`查询失败 ${title}：${err.message}`);
      await sleep(attempt * 2500);
    }
  }

  const list = Array.isArray(payload && payload.data) ? payload.data : [];
  const candidates = list.map((c) => ({
    id: Number(c.id),
    name: String(c.name || ''),
    name_cn: String(c.name_cn || ''),
    date: c.date || '',
    platform: c.platform || '',
    volumes: Number(c.volumes) || 0,
    rating: { total: Number(c.rating && c.rating.total) || 0, score: Number(c.rating && c.rating.score) || 0 },
    tags: (c.tags || []).slice(0, 12).map((t) => ({ name: String(t && t.name ? t.name : '') })),
    infobox: Array.isArray(c.infobox)
      ? c.infobox.slice(0, 12).map((x) => ({ key: String(x.key || ''), value: x.value }))
      : [],
  }));
  const record = { title, fetchedAt: new Date().toISOString(), total: Number(payload && payload.total) || 0, candidates };
  await writeFile(file, JSON.stringify(record), 'utf8');
  return record;
}

async function loadTargets() {
  const raw = await readFile(RN_FILE, 'utf8');
  const data = JSON.parse(raw.match(/window\.LN_RN\s*=\s*(\[[\s\S]*\]);?/)[1]);
  return data
    .filter((x) => (Number(x.v) || 0) >= MIN_VOLUMES && /[\u3040-\u30ff]/.test(String(x.n || '')))
    .sort((a, b) => (Number(b.v) || 0) - (Number(a.v) || 0) ||
      String(b.d || '').localeCompare(String(a.d || '')) ||
      String(a.n || '').localeCompare(String(b.n || '')))
    .slice(0, LIMIT);
}

async function runShard() {
  await mkdir(CACHE_DIR, { recursive: true });
  const all = await loadTargets();
  const targets = all.filter((_, idx) => idx % SHARDS === SHARD - 1);
  const outFile = path.join(WORK_DIR, `shard-${SHARD}.json`);
  let state = { shard: SHARD, shards: SHARDS, limit: LIMIT, minVolumes: MIN_VOLUMES, checked: 0, matched: 0, total: targets.length, updatedAt: '', done: false, results: {} };
  try {
    const prev = JSON.parse(await readFile(outFile, 'utf8'));
    if (prev && prev.results && prev.limit === LIMIT && prev.minVolumes === MIN_VOLUMES &&
      (Number(prev.shards) || 1) === SHARDS) state = prev;
  } catch { /* 首次运行 */ }

  console.log(`分片 ${SHARD}/${SHARDS}：目标 ${targets.length} 条（v>=${MIN_VOLUMES}，前 ${LIMIT} 条内）`);
  let done = 0;
  for (const entry of targets) {
    const rid = Number(entry.rid);
    done += 1;
    const prev = state.results[rid];
    // --fallback 模式下，之前判定为未命中的条目要重试一次
    if (prev !== undefined && !(FALLBACK && prev === null)) continue;
    let record = null;
    try {
      record = await searchSubject(String(entry.n).trim());
    } catch (err) {
      console.log(`  ! ${entry.n}：${err.message}`);
      await writeFile(outFile, JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 1), 'utf8');
      throw err;
    }
    let hit = pickMatch(entry, record.candidates);
    if (!hit && FALLBACK) {
      for (const variant of titleVariants(String(entry.n).trim())) {
        const alt = await searchSubject(variant);
        const altHit = pickMatch(entry, alt.candidates);
        if (altHit) { hit = { ...altHit, via: variant }; break; }
      }
    }
    state.results[rid] = hit;
    // 计数从 results 重算，--fallback 重试时不会重复累加
    state.checked = Object.keys(state.results).length;
    state.matched = Object.values(state.results).filter(Boolean).length;
    state.updatedAt = new Date().toISOString();
    if (hit) {
      console.log(`  ${done}/${targets.length} ✓ ${entry.n} → ${hit.cn}（${hit.how}${hit.manga ? '，漫画版' : ''}${hit.via ? '，变体查询' : ''}，bgm ${hit.bgm}）`);
    } else if (done % 20 === 0) {
      console.log(`  ${done}/${targets.length} 已查，命中 ${state.matched}`);
    }
    if (done % 25 === 0 || done === targets.length) {
      await writeFile(outFile, JSON.stringify(state, null, 1), 'utf8');
    }
  }
  state.done = true;
  state.updatedAt = new Date().toISOString();
  state.checked = Object.keys(state.results).length;
  state.matched = Object.values(state.results).filter(Boolean).length;
  await writeFile(outFile, JSON.stringify(state, null, 1), 'utf8');
  console.log(`分片 ${SHARD} 完成：检查 ${state.checked} 条，命中 ${state.matched} 条`);
}

async function mergeShards() {
  await mkdir(WORK_DIR, { recursive: true });
  const files = (await readdirSafe(WORK_DIR)).filter((f) => /^shard-\d+\.json$/.test(f)).sort();
  if (!files.length) throw new Error('没有分片文件，先跑一次 link-ranobedb-cn.mjs');

  // 人工复核后的剔除清单：[{ rid, reason }]，按 rid 排除；优先读仓库内文件（可随版本追踪）
  let blocked = [];
  for (const file of [path.join(ROOT, 'data', 'ranobedb-cn-blocklist.json'), path.join(WORK_DIR, 'blocklist.json')]) {
    try {
      blocked = JSON.parse(await readFile(file, 'utf8'));
      break;
    } catch { /* 尝试下一个位置 */ }
  }
  const blockedRids = new Set((Array.isArray(blocked) ? blocked : []).map((x) => String(x.rid)));

  const raw = await readFile(RN_FILE, 'utf8');
  const data = JSON.parse(raw.match(/window\.LN_RN\s*=\s*(\[[\s\S]*\]);?/)[1]);
  const byRid = new Map(data.map((x) => [Number(x.rid), x]));

  const matches = {};
  const details = [];
  const seen = new Map();
  const seenRid = new Set();
  let checked = 0;
  const stats = { exact: 0, contain: 0, near: 0, manga: 0, dupBgm: 0, blocked: 0 };

  for (const file of files) {
    const part = JSON.parse(await readFile(path.join(WORK_DIR, file), 'utf8'));
    for (const [rid, hit] of Object.entries(part.results || {})) {
      // 分片数变过时同一个 rid 会出现在多个分片里，按 rid 去重
      if (seenRid.has(rid)) continue;
      seenRid.add(rid);
      checked += 1;
      if (!hit) continue;
      if (blockedRids.has(String(rid))) { stats.blocked += 1; continue; }
      const entry = byRid.get(Number(rid));
      if (!entry) continue;
      if (seen.has(hit.bgm)) {
        stats.dupBgm += 1;
        continue;
      }
      seen.set(hit.bgm, rid);
      matches[rid] = { cn: hit.cn, bgm: hit.bgm, how: hit.how, manga: Boolean(hit.manga) };
      stats[hit.how] = (stats[hit.how] || 0) + 1;
      if (hit.manga) stats.manga += 1;
      details.push({
        rid: Number(rid),
        ja: entry.n,
        en: entry.en || '',
        v: entry.v,
        d: entry.d || '',
        cn: hit.cn,
        how: hit.how,
        manga: Boolean(hit.manga),
        bgm: hit.bgm,
        bgmName: hit.bgmName,
        bgmDate: hit.bgmDate,
        bgmVolumes: hit.bgmVolumes,
        platform: hit.platform,
        ratingTotal: hit.ratingTotal,
        score: hit.score,
        url: hit.url,
      });
    }
  }

  details.sort((a, b) => String(a.d || '').localeCompare(String(b.d || '')) || a.ja.localeCompare(b.ja));
  const out = {
    source: 'Bangumi',
    mode: LIMIT <= 500 ? 'pilot' : 'full',
    generatedAt: new Date().toISOString(),
    minVolumes: MIN_VOLUMES,
    limit: LIMIT,
    checked,
    matched: Object.keys(matches).length,
    stats,
    matches,
  };
  const outPath = path.resolve(ROOT, arg('out', path.join('data', 'build', 'ranobedb-cn-pilot', 'merged.json')));
  await mkdir(path.dirname(outPath), { recursive: true });
  await writeFile(outPath, `${JSON.stringify(out, null, 1)}\n`, 'utf8');
  await writeFile(path.join(WORK_DIR, 'merged-details.json'), `${JSON.stringify(details, null, 1)}\n`, 'utf8');

  console.log(`合并完成：检查 ${checked} 条，命中 ${out.matched} 条（${((out.matched / Math.max(1, checked)) * 100).toFixed(1)}%）`);
  console.log(`  完全同名 ${stats.exact} / 包含 ${stats.contain} / 近似 ${stats.near}；漫画版 ${stats.manga}；重复 bgm ${stats.dupBgm}${stats.blocked ? `；人工剔除 ${stats.blocked}` : ''}`);
  console.log(`  输出：${outPath}`);
  console.log(`  明细：${path.join(WORK_DIR, 'merged-details.json')}`);
}

async function readdirSafe(dir) {
  try {
    const { readdir } = await import('node:fs/promises');
    return await readdir(dir);
  } catch {
    return [];
  }
}

if (MERGE) {
  await mergeShards();
} else {
  await runShard();
}
