// 为卷包补齐发售日与缺失封面：逐卷查 Bangumi 详情，候选写入 data/volume-fills.json
// 用法：node scripts/enrich-volume-dates.mjs [--limit=8000] [--delay=900] [--concurrency=3]
// 只读查询；详情缓存复用 data/build/bgm-subject/，可中断续跑（已查过的 ID 记在 checked 里）。
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const VOLUME_FILE = path.join(ROOT, 'data', 'light-novels-volumes.js');
const CACHE_DIR = path.join(ROOT, 'data', 'build', 'bgm-subject');
const OUT_FILE = path.join(ROOT, 'data', 'volume-fills.json');
const BASE = 'https://bgmapi.anibt.net/v0/subjects';
const UA = 'yuc-light-novel-list/1.0';
const IMG_BASE_RE = /^https?:\/\/bgmimg\.anibt\.net\/r\/400\//;

const arg = (name, fallback) => {
  const hit = process.argv.find((x) => x.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : fallback;
};
const LIMIT = Math.max(1, Number(arg('limit', 8000)) || 8000);
const DELAY = Math.max(200, Number(arg('delay', 900)) || 900);
const CONC = Math.max(1, Math.min(6, Number(arg('concurrency', 3)) || 3));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseArray(text, name) {
  const match = text.match(new RegExp(`window\\.${name}\\s*=\\s*(\\[[\\s\\S]*\\]);?`));
  if (!match) throw new Error(`未找到 window.${name}`);
  return JSON.parse(match[1]);
}

function normalizeDate(raw) {
  const s = String(raw || '').trim().replace(/\s+/g, ' ');
  if (!s) return '';
  const m = s.match(/^(\d{4})(?:[-年/.](\d{1,2}))?(?:[-月/.](\d{1,2}))?日?/);
  if (!m) return '';
  const y = Number(m[1]);
  const mo = m[2] ? Number(m[2]) : 0;
  const d = m[3] ? Number(m[3]) : 0;
  if (y < 1700 || y > 2100) return '';
  if (mo && (mo < 1 || mo > 12)) return '';
  if (d) {
    if (!mo || d < 1 || d > 31) return '';
    const dt = new Date(Date.UTC(y, mo - 1, d));
    if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return '';
    return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }
  return mo ? `${y}-${String(mo).padStart(2, '0')}` : String(y);
}

function pickInfo(info, keys) {
  for (const key of keys) {
    const hit = (info || []).find((it) => String(it?.key || '').trim() === key);
    if (hit && String(hit.value || '').trim()) return String(hit.value).trim();
  }
  return '';
}

function coverPath(url) {
  const s = String(url || '').trim();
  if (!s) return '';
  if (s.includes('bgmimg.anibt.net')) return s.replace(IMG_BASE_RE, '').replace(/^https?:\/\/bgmimg\.anibt\.net\//, '');
  return s;
}

async function fetchSubject(id) {
  const file = path.join(CACHE_DIR, `${id}.json`);
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch { /* 继续查询 */ }
  const url = `${BASE}/${id}`;
  let data = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(20000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      data = await res.json();
      break;
    } catch (err) {
      if (attempt === 3) throw err;
      await sleep(attempt * 1500);
    }
  }
  await mkdir(CACHE_DIR, { recursive: true });
  await writeFile(file, JSON.stringify(data), 'utf8');
  await sleep(DELAY);
  return data;
}

await mkdir(CACHE_DIR, { recursive: true });
const volumes = parseArray(await readFile(VOLUME_FILE, 'utf8'), 'LN_VOLUMES');

// 续跑：载入已有候选与已查询 ID
let prev = { fills: {}, checked: [] };
try {
  prev = JSON.parse(await readFile(OUT_FILE, 'utf8'));
} catch { /* 首次运行 */ }
const fills = prev.fills && typeof prev.fills === 'object' ? prev.fills : {};
const checked = new Set(Array.isArray(prev.checked) ? prev.checked : Object.keys(fills).map(String));

const targets = volumes
  .filter((v) => !v.d)
  .filter((v) => !checked.has(String(v.i)))
  .slice(0, LIMIT);

console.log(`卷包 ${volumes.length} 条，缺日期 ${volumes.filter((v) => !v.d).length} 条，本轮待查 ${targets.length} 条`);

const stats = { queried: 0, hitDate: 0, hitImg: 0, empty: 0 };
let flushChain = Promise.resolve();
function flush() {
  // 串行写盘，避免多个 worker 同时写同一文件
  flushChain = flushChain.then(() => writeFile(OUT_FILE, `${JSON.stringify({
    generatedAt: new Date().toISOString(),
    stats,
    checked: [...checked],
    fills,
  })}\n`, 'utf8')).catch(() => {});
  return flushChain;
}

let cursor = 0;
let done = 0;
async function worker() {
  while (true) {
    const index = cursor;
    cursor += 1;
    if (index >= targets.length) return;
    const v = targets[index];
    let subject = null;
    try {
      subject = await fetchSubject(v.i);
    } catch (err) {
      console.log(`${v.n} 查询失败 ${err.message}`);
      continue;
    }
    checked.add(String(v.i));
    stats.queried += 1;
    done += 1;
    if (!subject || typeof subject !== 'object') {
      stats.empty += 1;
    } else {
      const info = Array.isArray(subject.infobox) ? subject.infobox : [];
      const date = normalizeDate(subject.date || pickInfo(info, ['发售日', '发行日期', '出版日期']));
      const img = coverPath(subject.images && subject.images.common);
      const hit = {};
      if (date) {
        hit.d = date;
        stats.hitDate += 1;
      }
      if (img && !v.img) {
        hit.img = img;
        stats.hitImg += 1;
      }
      if (Object.keys(hit).length) fills[String(v.i)] = hit;
      else stats.empty += 1;
    }
    if (done % 100 === 0) {
      await flush();
      console.log(`进度 ${done}/${targets.length}：日期 ${stats.hitDate} / 封面 ${stats.hitImg}`);
    }
  }
}

await Promise.all(Array.from({ length: CONC }, () => worker()));

await flush();
console.log(`卷日期补全：查询 ${stats.queried} 条，补日期 ${stats.hitDate}，补封面 ${stats.hitImg}，无数据 ${stats.empty}`);
