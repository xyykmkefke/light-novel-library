// 用 Bangumi 详情接口补搜索页缺失的字段（日期 / 作者 / 出版社 / 封面等）
// 用法：node scripts/enrich-bgm-detail.mjs [--fields=date,author,publisher,cover] [--all] [--limit=1000] [--delay=900] [--refresh]
// 只读查询；原始结果缓存在 data/build/bgm-subject/，候选写入 data/bgm-detail-fills.json（随仓库提交）
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const CACHE_DIR = path.join(ROOT, 'data', 'build', 'bgm-subject');
const OUT_FILE = path.join(ROOT, 'data', 'bgm-detail-fills.json');
const BASE = 'https://bgmapi.anibt.net/v0/subjects';
const UA = 'yuc-light-novel-list/1.0';

const arg = (name, fallback) => {
  const hit = process.argv.find((x) => x.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : fallback;
};
const FIELDS = arg('fields', 'date,author,publisher,cover').split(',').map((x) => x.trim()).filter(Boolean);
const ALL = process.argv.includes('--all');
const LIMIT = Math.max(1, Number(arg('limit', 1000)) || 1000);
const DELAY = Math.max(200, Number(arg('delay', 900)) || 900);
const REFRESH = process.argv.includes('--refresh');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const val = (v) => v !== undefined && v !== null && v !== '' && v !== 0;

function parseArray(text, name) {
  const match = text.match(new RegExp(`window\\.${name}\\s*=\\s*(\\[[\\s\\S]*\\]);?`));
  if (!match) throw new Error(`未找到 window.${name}`);
  return JSON.parse(match[1]);
}

function parseObject(text, name) {
  const match = text.match(new RegExp(`window\\.${name}\\s*=\\s*(\\{[\\s\\S]*\\});?`));
  if (!match) throw new Error(`未找到 window.${name}`);
  return JSON.parse(match[1]);
}

function normalizeDate(raw) {
  const original = String(raw || '').trim().replace(/\s+/g, ' ');
  if (!original) return '';
  // 同一条目出现多个年份（不同版本 / 首版与修订版）时不猜，留给人工
  if ((original.match(/\d{4}/g) || []).length > 1) return '';
  const s = original.replace(/\s+/g, '');
  const pad = (n) => String(n).padStart(2, '0');
  const monthOk = (m) => Number(m) >= 1 && Number(m) <= 12;
  const dayOk = (m, d) => monthOk(m) && Number(d) >= 1 && Number(d) <= 31;
  const yearOk = (y) => Number(y) >= 1700 && Number(y) <= 2100;
  let m;
  if ((m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/)) && yearOk(m[1]) && dayOk(m[2], m[3])) return `${m[1]}-${pad(m[2])}-${pad(m[3])}`;
  if ((m = s.match(/^(\d{4})[/.](\d{1,2})[/.](\d{1,2})$/)) && yearOk(m[1]) && dayOk(m[2], m[3])) return `${m[1]}-${pad(m[2])}-${pad(m[3])}`;
  if ((m = s.match(/^(\d{4})年(\d{1,2})月(\d{1,2})日?$/)) && yearOk(m[1]) && dayOk(m[2], m[3])) return `${m[1]}-${pad(m[2])}-${pad(m[3])}`;
  if ((m = s.match(/^(\d{4})-(\d{1,2})$/)) && yearOk(m[1]) && monthOk(m[2])) return `${m[1]}-${pad(m[2])}`;
  if ((m = s.match(/^(\d{4})[/.](\d{1,2})$/)) && yearOk(m[1]) && monthOk(m[2])) return `${m[1]}-${pad(m[2])}`;
  if ((m = s.match(/^(\d{4})年(\d{1,2})月?$/)) && yearOk(m[1]) && monthOk(m[2])) return `${m[1]}-${pad(m[2])}`;
  if ((m = s.match(/^(\d{4})年?$/)) && yearOk(m[1])) return m[1];
  // 带英文 / 版本说明的尾部：只取开头明确的年月
  if ((m = original.match(/^(\d{4})年(\d{1,2})月/)) && yearOk(m[1]) && monthOk(m[2])) return `${m[1]}-${pad(m[2])}`;
  if ((m = original.match(/^(\d{4})年/)) && yearOk(m[1])) return m[1];
  return '';
}

function pickInfo(info, keys) {
  for (const key of keys) {
    const hit = info.find((x) => x.key === key);
    if (hit && val(hit.value)) return String(hit.value).replace(/\s+/g, ' ').trim();
  }
  return '';
}

function coverPath(url) {
  const s = String(url || '');
  if (s.startsWith('pic/cover/')) return s;
  const hit = s.match(/^(?:https?:\/\/[^/]+)?(\/pic\/cover\/[^?#]+)/);
  return hit ? hit[1].replace(/^\//, '') : '';
}

async function fetchSubject(id) {
  const file = path.join(CACHE_DIR, `${id}.json`);
  if (!REFRESH) {
    try {
      return JSON.parse(await readFile(file, 'utf8'));
    } catch { /* 继续查询 */ }
  }
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
  await writeFile(file, JSON.stringify(data), 'utf8');
  await sleep(DELAY);
  return data;
}

await mkdir(CACHE_DIR, { recursive: true });
const core = parseArray(await readFile(path.join(ROOT, 'data', 'light-novels.js'), 'utf8'), 'LN_DATA');
const ex = parseObject(await readFile(path.join(ROOT, 'data', 'light-novels-extra.js'), 'utf8'), 'LN_EXTRA');
const data = core;

const missing = {
  date: (x) => !val(x.d),
  author: (x) => !val((ex[String(x.i)] || {}).au),
  publisher: (x) => !val((ex[String(x.i)] || {}).pub),
  line: (x) => !val((ex[String(x.i)] || {}).line),
  illustrator: (x) => !val((ex[String(x.i)] || {}).il),
  cover: (x) => !val(x.img),
};

const targets = data
  .filter((x) => (ALL || !x.gn) && FIELDS.some((f) => missing[f] && missing[f](x)))
  .sort((a, b) => (b.h || 0) - (a.h || 0))
  .slice(0, LIMIT);

const fills = {};
const stats = Object.fromEntries(FIELDS.map((f) => [f, { needed: 0, filled: 0 }]));
const datePrecision = { y: 0, m: 0, d: 0 };
const unparsed = [];

for (let i = 0; i < targets.length; i += 1) {
  const x = targets[i];
  const need = FIELDS.filter((f) => missing[f] && missing[f](x));
  need.forEach((f) => { stats[f].needed += 1; });
  let subject;
  try {
    subject = await fetchSubject(x.i);
  } catch (err) {
    console.log(`进度 ${i + 1}/${targets.length}：${x.cn || x.n} 查询失败 ${err.message}`);
    continue;
  }
  const info = subject.infobox || [];
  const got = {};
  if (need.includes('date')) {
    const raw = String(subject.date || pickInfo(info, ['发售日', '发行日期', '出版日期']) || '').trim();
    const date = normalizeDate(raw);
    if (date) {
      got.date = date;
      stats.date.filled += 1;
      if (date.length === 4) datePrecision.y += 1;
      else if (date.length === 7) datePrecision.m += 1;
      else datePrecision.d += 1;
    } else if (raw) {
      unparsed.push(`${x.i}:${raw}`);
    }
  }
  if (need.includes('author')) {
    const au = pickInfo(info, ['作者', '原作', '著者', '作者名']);
    if (au) { got.author = au; stats.author.filled += 1; }
  }
  if (need.includes('publisher')) {
    const pub = pickInfo(info, ['出版社', '发行', '出版商', '発行']);
    if (pub) { got.publisher = pub; stats.publisher.filled += 1; }
  }
  if (need.includes('line')) {
    const line = pickInfo(info, ['文库', '书系', 'レーベル', '丛书', '图书品牌']);
    if (line) { got.line = line; stats.line.filled += 1; }
  }
  if (need.includes('illustrator')) {
    const il = pickInfo(info, ['插图', '插画', 'イラスト', '作画', '人物原案']);
    if (il) { got.illustrator = il; stats.illustrator.filled += 1; }
  }
  if (need.includes('cover')) {
    const img = coverPath(subject.images && subject.images.common);
    if (img) { got.cover = img; stats.cover.filled += 1; }
  }
  if (Object.keys(got).length) fills[String(x.i)] = got;
  if ((i + 1) % 20 === 0) {
    await writeFile(OUT_FILE, JSON.stringify({ generatedAt: new Date().toISOString(), checked: i + 1, stats, datePrecision, fills }, null, 0), 'utf8');
    console.log(`进度 ${i + 1}/${targets.length}：已补 ${Object.keys(fills).length} 条`);
  }
}

await writeFile(OUT_FILE, JSON.stringify({ generatedAt: new Date().toISOString(), checked: targets.length, stats, datePrecision, unparsed, fills }, null, 0), 'utf8');
console.log(`详情补全完成：查询 ${targets.length} 条，候选 ${Object.keys(fills).length} 条`);
console.log('字段命中：', JSON.stringify(stats));
console.log('日期精度：', JSON.stringify(datePrecision), unparsed.length ? `未解析 ${unparsed.length} 条` : '');
