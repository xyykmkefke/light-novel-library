// 数据质量校验：重复 ID、非法日期、评分/卷数越界、题材越界、缓存字段泄漏
// 用法：node scripts/check-data.mjs
// 退出码 0 表示数据干净，1 表示存在问题
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { GENRES } from './genres.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const raw = await readFile(path.join(ROOT, 'data', 'light-novels.js'), 'utf8');
const metaMatch = raw.match(/window\.LN_META\s*=\s*(\{[\s\S]*?\});/);
const dataMatch = raw.match(/window\.LN_DATA\s*=\s*(\[[\s\S]*\]);?/);
if (!metaMatch || !dataMatch) {
  console.error('未找到 window.LN_META 或 window.LN_DATA');
  process.exit(1);
}
const meta = JSON.parse(metaMatch[1]);
const data = JSON.parse(dataMatch[1]);

const GENRE_IDS = new Set(GENRES.map((g) => g.id));
const label = {
  duplicate: '重复 ID',
  date: '非法日期',
  score: '评分越界',
  volumes: '卷数异常',
  title: '缺少标题',
  id: '非法 ID',
  genre: '题材字段异常',
  leak: '缓存字段泄漏',
  flags: '布尔字段异常',
  kind: '类型字段异常',
  meta: '元信息异常',
};
const issues = {
  duplicate: [], date: [], score: [], volumes: [], title: [], id: [],
  genre: [], leak: [], flags: [], kind: [], meta: [],
};
const seen = new Map();

data.forEach((x, idx) => {
  const id = Number(x.i);
  if (!Number.isInteger(id) || id <= 0) issues.id.push(`${idx}:${x.i}`);
  if (seen.has(String(x.i))) issues.duplicate.push(`${x.i}（#${seen.get(String(x.i))} 与 #${idx}）`);
  else seen.set(String(x.i), idx);

  const d = String(x.d || '');
  if (d && !/^\d{4}-\d{2}-\d{2}$/.test(d)) issues.date.push(`${x.i}:${d}`);
  if (x.s != null && (Number(x.s) < 0 || Number(x.s) > 10)) issues.score.push(`${x.i}:${x.s}`);
  if (x.v != null && (!Number.isInteger(Number(x.v)) || Number(x.v) < 0)) issues.volumes.push(`${x.i}:${x.v}`);
  if (!String(x.cn || '').trim() && !String(x.n || '').trim()) issues.title.push(String(x.i));
  if (x.rt) issues.leak.push(String(x.i));
  if (typeof x.sv !== 'boolean' || typeof x.c !== 'boolean' || typeof x.ns !== 'boolean') {
    issues.flags.push(`${x.i}:sv=${x.sv},c=${x.c},ns=${x.ns}`);
  }
  if (x.c && x.sv) issues.flags.push(`${x.i}:系列条目不能是子卷`);
  if (x.py != null && typeof x.py !== 'string') issues.flags.push(`${x.i}:py 类型错误`);
  if (x.kind != null && !['manga', 'artbook', 'guide'].includes(x.kind)) {
    issues.kind.push(`${x.i}:${x.kind}`);
  }
  if (x.tg != null) {
    if (!Array.isArray(x.tg) || !x.tg.length) {
      issues.genre.push(`${x.i}:${JSON.stringify(x.tg)}`);
    } else {
      const bad = x.tg.filter((g) => !GENRE_IDS.has(g));
      if (bad.length) issues.genre.push(`${x.i}:${bad.join('/')}`);
      if (new Set(x.tg).size !== x.tg.length) issues.genre.push(`${x.i}:重复`);
    }
  }
});

if (Number(meta.count) !== data.length) {
  issues.meta.push(`count=${meta.count}，实际=${data.length}`);
}
const dates = data.map((x) => x.d).filter(Boolean).sort();
const minDate = dates[0] || '';
const maxDate = dates[dates.length - 1] || '';
if (meta.minDate && meta.minDate !== minDate) issues.meta.push(`minDate=${meta.minDate}，实际=${minDate}`);
if (meta.maxDate && meta.maxDate !== maxDate) issues.meta.push(`maxDate=${meta.maxDate}，实际=${maxDate}`);

const total = Object.values(issues).reduce((n, arr) => n + arr.length, 0);
Object.keys(issues).forEach((key) => {
  const arr = issues[key];
  if (arr.length) console.log(`FAIL ${label[key]}：${arr.length} 条，示例 ${arr.slice(0, 5).join(', ')}`);
});

const series = data.filter((x) => x.sv).length;
const singles = data.filter((x) => !x.sv).length;
const children = data.filter((x) => x.c).length;
const withGenre = data.filter((x) => Array.isArray(x.tg) && x.tg.length).length;
const genreCounts = {};
data.forEach((x) => (x.tg || []).forEach((g) => { genreCounts[g] = (genreCounts[g] || 0) + 1; }));
const dist = GENRES.filter((g) => genreCounts[g.id])
  .map((g) => `${g.label} ${genreCounts[g.id]}`).join(' · ');

const missing = {
  au: data.filter((x) => !String(x.au || '').trim()).length,
  il: data.filter((x) => !String(x.il || '').trim()).length,
  pub: data.filter((x) => !String(x.pub || '').trim()).length,
  line: data.filter((x) => !String(x.line || '').trim()).length,
  img: data.filter((x) => !String(x.img || '').trim()).length,
  d: data.filter((x) => !String(x.d || '').trim()).length,
  vSeries: data.filter((x) => x.sv && !Number(x.v)).length,
  vSingles: data.filter((x) => !x.sv && !Number(x.v)).length,
};
const kinds = { manga: 0, artbook: 0, guide: 0 };
data.forEach((x) => { if (x.kind) kinds[x.kind] += 1; });

function matches(x, keyword) {
  return String(x.cn || '').includes(keyword) || String(x.n || '').includes(keyword);
}

console.log(`条目总数：${data.length}；系列 ${series} / 单册 ${singles} / 子卷 ${children} / 默认可见 ${data.length - children}`);
console.log(`日期范围：${minDate || '—'} ~ ${maxDate || '—'}`);
console.log(`题材覆盖：${withGenre}/${data.length}（${(withGenre / data.length * 100).toFixed(1)}%）`);
console.log(`题材分布：${dist || '无'}`);
console.log(`字段缺失：作者 ${missing.au} / 插图 ${missing.il} / 出版社 ${missing.pub} / 书系 ${missing.line} / 封面 ${missing.img} / 日期 ${missing.d}`);
console.log(`无卷数：单册 ${missing.vSingles} / 未完结或未知系列 ${missing.vSeries}`);
console.log(`类型标记：漫画 ${kinds.manga} / 画集 ${kinds.artbook} / 指南 ${kinds.guide}`);

for (const keyword of ['文学少女', '无职转生', '白夜行', '人间失格']) {
  const visible = data.filter((x) => !x.c && matches(x, keyword));
  const sample = visible.slice(0, 5)
    .map((x) => `${x.i} ${x.cn || x.n}${x.sv ? ' [系列]' : ''}`)
    .join(' / ');
  console.log(`抽查「${keyword}」默认可见 ${visible.length} 条：${sample || '无'}`);
}

console.log(`问题总数：${total}`);
process.exitCode = total ? 1 : 0;
