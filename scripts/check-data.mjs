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

// 详情字段拆包：读取 extra 并在校验时合并，确保字段覆盖统计仍然准确
const extraRaw = await readFile(path.join(ROOT, 'data', 'light-novels-extra.js'), 'utf8').catch(() => '');
const extraMatch = extraRaw.match(/window\.LN_EXTRA\s*=\s*(\{[\s\S]*\});?/);
const extra = extraMatch ? JSON.parse(extraMatch[1]) : {};
const EXTRA_KEYS = ['au', 'il', 'pub', 'line', 'isbn', 'fisbn', 'jd'];
const merged = data.map((x) => ({ ...x, ...(extra[String(x.i)] || {}) }));

// 懒加载卷包：核心包只保留系列与独立作品，新卷单独校验
const volumeRaw = await readFile(path.join(ROOT, 'data', 'light-novels-volumes.js'), 'utf8').catch(() => '');
const volumeMatch = volumeRaw.match(/window\.LN_VOLUMES\s*=\s*(\[[\s\S]*\]);?/);
const volumes = volumeMatch ? JSON.parse(volumeMatch[1]) : [];
const rnRaw = await readFile(path.join(ROOT, 'data', 'light-novels-rn.js'), 'utf8').catch(() => '');
const rnMetaMatch = rnRaw.match(/window\.LN_RN_META\s*=\s*(\{[\s\S]*?\});/);
const rnDataMatch = rnRaw.match(/window\.LN_RN\s*=\s*(\[[\s\S]*\]);?/);
const rnMeta = rnMetaMatch ? JSON.parse(rnMetaMatch[1]) : {};
const rn = rnDataMatch ? JSON.parse(rnDataMatch[1]) : [];
const liteRaw = await readFile(path.join(ROOT, 'data', 'light-novels-lite.js'), 'utf8').catch(() => '');
const liteDataMatch = liteRaw.match(/window\.LN_DATA\s*=\s*(\[[\s\S]*\]);?/);
const liteData = liteDataMatch ? JSON.parse(liteDataMatch[1]) : [];
const restRaw = await readFile(path.join(ROOT, 'data', 'light-novels-rest.js'), 'utf8').catch(() => '');
const restDataMatch = restRaw.match(/window\.LN_REST\s*=\s*(\[[\s\S]*\]);?/);
const restData = restDataMatch ? JSON.parse(restDataMatch[1]) : [];
const chRaw = await readFile(path.join(ROOT, 'data', 'light-novels-ch.js'), 'utf8').catch(() => '');
const chMatch = chRaw.match(/window\.LN_CH\s*=\s*(\{[\s\S]*\});?/);
const chPack = chMatch ? JSON.parse(chMatch[1]) : null;
const coreIds = new Set(data.map((x) => String(x.i)));

const GENRE_IDS = new Set(GENRES.map((g) => g.id));
function validDate(value) {
  // 允许 YYYY / YYYY-MM / YYYY-MM-DD 三种精度，具体到日时再做日历回验
  const s = String(value || '');
  if (!/^\d{4}(-\d{2}){0,2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  if (m != null && (m < 1 || m > 12)) return false;
  if (d != null) {
    const dt = new Date(Date.UTC(y, m - 1, d));
    return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
  }
  return true;
}
function validIsbn13(code) {
  if (!/^\d{13}$/.test(code)) return false;
  const sum = code.slice(0, 12).split('').reduce((n, d, i) => n + Number(d) * (i % 2 ? 3 : 1), 0);
  return (10 - (sum % 10)) % 10 === Number(code[12]);
}
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
  children: '系列子卷索引异常',
  version: '重复版本标记异常',
  split: '册/故事卷统计异常',
  extra: '详情拆包异常',
  rn: '扩展书目异常',
  splitcore: '核心拆包异常',
  img: '封面字段异常',
  source: '来源标记异常',
  volume: '卷包异常',
  meta: '元信息异常',
};
const issues = {
  duplicate: [], date: [], score: [], volumes: [], title: [], id: [],
  genre: [], leak: [], flags: [], kind: [], children: [], extra: [], img: [], source: [], volume: [], meta: [],
  version: [], split: [], rn: [], splitcore: [],
};
const seen = new Map();
const byIdAll = new Map(data.map((x) => [String(x.i), x]));
volumes.forEach((v) => {
  if (v && v.i != null) byIdAll.set(String(v.i), v);
});
const refIds = new Set();
data.forEach((x) => (x.ch || []).forEach((cid) => refIds.add(String(cid))));

data.forEach((x, idx) => {
  const id = Number(x.i);
  if (!Number.isInteger(id) || id <= 0) issues.id.push(`${idx}:${x.i}`);
  if (seen.has(String(x.i))) issues.duplicate.push(`${x.i}（#${seen.get(String(x.i))} 与 #${idx}）`);
  else seen.set(String(x.i), idx);

  const d = String(x.d || '');
  if (d && !validDate(d)) issues.date.push(`${x.i}:${d}`);
  if (x.s != null && (Number(x.s) < 0 || Number(x.s) > 10)) issues.score.push(`${x.i}:${x.s}`);
  if (x.v != null && (!Number.isInteger(Number(x.v)) || Number(x.v) < 0)) issues.volumes.push(`${x.i}:${x.v}`);
  if (!String(x.cn || '').trim() && !String(x.n || '').trim()) issues.title.push(String(x.i));
  if (x.rt) issues.leak.push(String(x.i));
  EXTRA_KEYS.forEach((key) => {
    if (key in x) issues.extra.push(`${x.i}:核心包不应包含 ${key}`);
  });
  if (x.img && !/^https?:\/\//.test(x.img) && !/^(pic\/cover\/|\d{2}\/\d{2}\/)/.test(x.img)) {
    issues.img.push(`${x.i}:${x.img}`);
  }
  if (typeof x.sv !== 'boolean' || typeof x.c !== 'boolean' || typeof x.ns !== 'boolean') {
    issues.flags.push(`${x.i}:sv=${x.sv},c=${x.c},ns=${x.ns}`);
  }
  if (x.c && x.sv) issues.flags.push(`${x.i}:系列条目不能是子卷`);
  if (x.py != null && typeof x.py !== 'string') issues.flags.push(`${x.i}:py 类型错误`);
  if (x.kind != null && !['manga', 'artbook', 'guide'].includes(x.kind)) {
    issues.kind.push(`${x.i}:${x.kind}`);
  }
  if (x.gn != null && x.gn !== true) issues.source.push(`${x.i}:gn=${x.gn}`);
  if (x.tg != null) {
    if (!Array.isArray(x.tg) || !x.tg.length) {
      issues.genre.push(`${x.i}:${JSON.stringify(x.tg)}`);
    } else {
      const bad = x.tg.filter((g) => !GENRE_IDS.has(g));
      if (bad.length) issues.genre.push(`${x.i}:${bad.join('/')}`);
      if (new Set(x.tg).size !== x.tg.length) issues.genre.push(`${x.i}:重复`);
    }
  }
  if (x.ch != null) {
    if (!x.sv || !Array.isArray(x.ch) || !x.ch.length) {
      issues.children.push(`${x.i}:ch 只能出现在系列条目且不能为空`);
    } else {
      if (new Set(x.ch).size !== x.ch.length) issues.children.push(`${x.i}:ch 重复`);
      if (x.ch.includes(String(x.i))) issues.children.push(`${x.i}:ch 含自身`);
      x.ch.forEach((cid) => {
        const child = byIdAll.get(String(cid));
        if (!child) issues.children.push(`${x.i}:子卷 ${cid} 不存在`);
        else if (!child.c) issues.children.push(`${x.i}:${cid} 未标记为子卷`);
      });
    }
  }
  if (x.chn != null) {
    if (!x.sv || !Number.isInteger(x.chn) || x.chn <= 0) {
      issues.children.push(`${x.i}:chn 必须是系列的正整数子卷数`);
    } else if (Array.isArray(x.ch) && x.chn !== x.ch.length) {
      issues.children.push(`${x.i}:chn=${x.chn} 与 ch=${x.ch.length} 不一致`);
    }
  }
  if (x.ver != null) {
    const primary = byIdAll.get(String(x.ver));
    if (!x.sv || !primary || !primary.sv) issues.version.push(`${x.i}:主条目 ${x.ver} 不存在或不是系列`);
    else if (String(x.ver) === String(x.i)) issues.version.push(`${x.i}:不能指向自身`);
    else if (primary.ver != null) issues.version.push(`${x.i}:主条目 ${x.ver} 仍是版本`);
  }
  if (x.chs != null) {
    if (!x.sv || !Array.isArray(x.ch) || !x.ch.length) {
      issues.split.push(`${x.i}:chs 只能出现在有子卷的系列`);
    } else if (!Number.isInteger(x.chs) || x.chs <= 0 || x.chs > x.ch.length) {
      issues.split.push(`${x.i}:chs=${x.chs}，ch=${x.ch.length}`);
    }
  }
});

// 子卷索引包：与完整核心的 ch 必须逐条一致，运行时 lite/rest 不再携带 ch
if (!chPack) {
  issues.children.push('未找到 window.LN_CH');
} else {
  data.forEach((x) => {
    const list = chPack[String(x.i)];
    if (Array.isArray(x.ch)) {
      if (!Array.isArray(list)) issues.children.push(`${x.i}:缺少子卷索引包条目`);
      else if (list.length !== x.ch.length || list.some((id, i) => String(id) !== String(x.ch[i]))) {
        issues.children.push(`${x.i}:子卷索引包与核心不一致`);
      }
    } else if (list) {
      issues.children.push(`${x.i}:子卷索引包多出条目`);
    }
  });
  Object.entries(chPack).forEach(([id, list]) => {
    const parent = byIdAll.get(id);
    if (!parent || !parent.sv) issues.children.push(`${id}:子卷索引包条目不是系列`);
    if (!Array.isArray(list) || !list.length) issues.children.push(`${id}:子卷索引包为空`);
    else if (new Set(list.map(String)).size !== list.length) issues.children.push(`${id}:子卷索引包重复`);
  });
}

if (!volumeMatch) issues.volume.push('未找到 window.LN_VOLUMES');
const seenVolume = new Set();
volumes.forEach((v) => {
  const id = String(v && v.i);
  if (!/^\d+$/.test(id)) issues.volume.push(`非法 ID：${id}`);
  if (coreIds.has(id)) issues.volume.push(`${id}:卷包与核心包重复`);
  if (seenVolume.has(id)) issues.volume.push(`${id}:卷包内重复`);
  seenVolume.add(id);
  if (!String(v.cn || '').trim() && !String(v.n || '').trim()) issues.volume.push(`${id}:缺少标题`);
  if (v.sv !== false || v.c !== true || v.ns !== false) {
    issues.volume.push(`${id}:sv=${v.sv},c=${v.c},ns=${v.ns}`);
  }
  if (v.img && !/^https?:\/\//.test(v.img) && !/^(pic\/cover\/|\d{2}\/\d{2}\/)/.test(v.img)) {
    issues.volume.push(`${id}:封面 ${v.img}`);
  }
  if (!refIds.has(id)) issues.volume.push(`${id}:未被任何系列 ch 引用`);
  if (v.d && !validDate(v.d)) issues.volume.push(`${id}:日期 ${v.d}`);
});

if (!rnMetaMatch || !rnDataMatch) {
  issues.rn.push('未找到 window.LN_RN_META 或 window.LN_RN');
} else {
  const RN_ID_BASE = 800000000;
  const seenRn = new Set();
  rn.forEach((x) => {
    const id = String(x && x.i);
    if (!/^\d+$/.test(id) || Number(id) < RN_ID_BASE) issues.rn.push(`非法 ID：${id}`);
    if (coreIds.has(id) || seenVolume.has(id)) issues.rn.push(`${id}:与核心包或卷包重复`);
    if (seenRn.has(id)) issues.rn.push(`${id}:扩展包内重复`);
    seenRn.add(id);
    if (!String(x.n || '').trim()) issues.rn.push(`${id}:缺少标题`);
    if (!/[\u3040-\u30ff]/.test(String(x.n || ''))) issues.rn.push(`${id}:标题不是日文`);
    if (x.rn !== true || x.sv !== true || x.c !== false || x.ns !== false) {
      issues.rn.push(`${id}:rn=${x.rn},sv=${x.sv},c=${x.c},ns=${x.ns}`);
    }
    if (!Number.isInteger(Number(x.rid)) || Number(x.rid) <= 0) issues.rn.push(`${id}:rid 非法`);
    else if (Number(id) !== RN_ID_BASE + Number(x.rid)) issues.rn.push(`${id}:ID 与 rid 不匹配`);
    if (!Number.isInteger(Number(x.v)) || Number(x.v) < 2) issues.rn.push(`${id}:v=${x.v}`);
    if (x.d && !validDate(x.d)) issues.rn.push(`${id}:日期 ${x.d}`);
    if (x.img && !/^https:\/\/images\.ranobedb\.org\//.test(x.img)) issues.rn.push(`${id}:封面 ${x.img}`);
    if (x.ch != null) issues.rn.push(`${id}:扩展系列不应有 ch`);
    if (x.en != null && typeof x.en !== 'string') issues.rn.push(`${id}:en 类型错误`);
    if (x.au != null && (!String(x.au).trim() || typeof x.au !== 'string')) issues.rn.push(`${id}:au 异常`);
    if (x.pub != null && (!String(x.pub).trim() || typeof x.pub !== 'string')) issues.rn.push(`${id}:pub 异常`);
    if (x.line != null && (!String(x.line).trim() || typeof x.line !== 'string')) issues.rn.push(`${id}:line 异常`);
    if (x.cn != null) {
      const cn = String(x.cn).trim();
      if (!cn) issues.rn.push(`${id}:cn 为空字符串`);
      if (cn === String(x.n || '').trim()) issues.rn.push(`${id}:cn 与日文标题相同`);
      if (x.bgm != null && (!Number.isInteger(Number(x.bgm)) || Number(x.bgm) <= 0)) {
        issues.rn.push(`${id}:bgm=${x.bgm}`);
      }
    } else if (x.bgm != null) {
      issues.rn.push(`${id}:有 bgm 但缺少 cn`);
    }
  });
  if (Number(rnMeta.count) !== rn.length) issues.rn.push(`meta.count=${rnMeta.count}，实际=${rn.length}`);
  const rnVolumes = rn.reduce((n, x) => n + (Number(x.v) || 0), 0);
  if (Number(rnMeta.volumes) !== rnVolumes) issues.rn.push(`meta.volumes=${rnMeta.volumes}，实际=${rnVolumes}`);
  if (rnMeta.cnMapped != null) {
    const mapped = rn.filter((x) => x.cn).length;
    if (Number(rnMeta.cnMapped) !== mapped) issues.rn.push(`meta.cnMapped=${rnMeta.cnMapped}，实际=${mapped}`);
  }
  if (rnMeta.source !== 'RanobeDB' || rnMeta.license !== 'ODbL') issues.rn.push('来源或授权标记缺失');
}

if (!liteDataMatch || !restDataMatch) {
  issues.splitcore.push('未找到轻量核心或剩余核心');
} else {
  const union = [...liteData, ...restData];
  const ids = new Set();
  union.forEach((x) => {
    const id = String(x && x.i);
    if (ids.has(id)) issues.splitcore.push(`${id}:轻量/剩余核心重复`);
    ids.add(id);
  });
  if (union.length !== data.length) issues.splitcore.push(`合计 ${union.length}，完整核心 ${data.length}`);
  const missing = data.filter((x) => !ids.has(String(x.i)));
  if (missing.length) issues.splitcore.push(`缺少 ${missing.length} 条，示例 ${missing.slice(0, 3).map((x) => x.i).join('/')}`);
  liteData.forEach((x) => {
    if (x.c || x.gn || x.ver) issues.splitcore.push(`${x.i}:轻量核心不应包含隐藏条目`);
  });
  restData.forEach((x) => {
    if (!x.c && !x.gn && !x.ver) issues.splitcore.push(`${x.i}:剩余核心不应包含默认可见条目`);
  });
}

Object.keys(extra).forEach((id) => {
  if (!byIdAll.has(id)) issues.extra.push(`${id}:extra 指向不存在的条目`);
  const fields = extra[id];
  if (!fields || typeof fields !== 'object') {
    issues.extra.push(`${id}:字段格式错误`);
    return;
  }
  Object.keys(fields).forEach((key) => {
    if (!EXTRA_KEYS.includes(key)) issues.extra.push(`${id}:未知字段 ${key}`);
    if (typeof fields[key] !== 'string' || !fields[key].trim()) issues.extra.push(`${id}:${key} 为空`);
    if ((key === 'isbn' || key === 'fisbn') && !validIsbn13(fields[key])) {
      issues.extra.push(`${id}:${key} 校验失败 ${fields[key]}`);
    }
    if (key === 'jd' && !/^\d{4}(-\d{2}){0,2}$/.test(fields[key])) issues.extra.push(`${id}:日文版日期异常 ${fields[key]}`);
  });
});
if (!extraMatch) issues.extra.push('未找到 window.LN_EXTRA');

if (Number(meta.count) !== data.length) {
  issues.meta.push(`count=${meta.count}，实际=${data.length}`);
}
const general = data.filter((x) => x.gn).length;
if (Number(meta.general) !== general) {
  issues.meta.push(`general=${meta.general}，实际=${general}`);
}
if (Number(meta.volumes) !== volumes.length) {
  issues.meta.push(`volumes=${meta.volumes}，实际=${volumes.length}`);
}
if (Number(meta.versions) !== data.filter((x) => x.ver != null).length) {
  issues.meta.push(`versions=${meta.versions}，实际=${data.filter((x) => x.ver != null).length}`);
}
const physical = data.reduce((n, x) => n + (Array.isArray(x.ch) ? x.ch.length : 0), 0);
const story = data.reduce((n, x) => n + (Array.isArray(x.ch) ? (x.chs || x.ch.length) : 0), 0);
if (Number(meta.physicalVolumes) !== physical) issues.meta.push(`physicalVolumes=${meta.physicalVolumes}，实际=${physical}`);
if (Number(meta.storyVolumes) !== story) issues.meta.push(`storyVolumes=${meta.storyVolumes}，实际=${story}`);
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
const indexed = data.filter((x) => Array.isArray(x.ch)).length;
const indexedRefs = data.reduce((n, x) => n + (Array.isArray(x.ch) ? x.ch.length : 0), 0);
const withGenre = data.filter((x) => Array.isArray(x.tg) && x.tg.length).length;
const genreCounts = {};
data.forEach((x) => (x.tg || []).forEach((g) => { genreCounts[g] = (genreCounts[g] || 0) + 1; }));
const dist = GENRES.filter((g) => genreCounts[g.id])
  .map((g) => `${g.label} ${genreCounts[g.id]}`).join(' · ');

const missing = {
  au: merged.filter((x) => !String(x.au || '').trim()).length,
  il: merged.filter((x) => !String(x.il || '').trim()).length,
  pub: merged.filter((x) => !String(x.pub || '').trim()).length,
  line: merged.filter((x) => !String(x.line || '').trim()).length,
  img: merged.filter((x) => !String(x.img || '').trim()).length,
  d: merged.filter((x) => !String(x.d || '').trim()).length,
  vSeries: merged.filter((x) => x.sv && !Number(x.v)).length,
  vSingles: merged.filter((x) => !x.sv && !Number(x.v)).length,
};
const kinds = { manga: 0, artbook: 0, guide: 0 };
data.forEach((x) => { if (x.kind) kinds[x.kind] += 1; });

function matches(x, keyword) {
  return String(x.cn || '').includes(keyword) || String(x.n || '').includes(keyword);
}

const visibleDefault = data.filter((x) => !x.c && !x.gn && !x.ver).length;
console.log(`条目总数：${data.length}；系列 ${series} / 单册 ${singles} / 子卷 ${children} / 默认可见 ${visibleDefault}`);
console.log(`来源：轻小说 ${data.length - general} / 一般小说 ${general}；默认可见轻小说 ${visibleDefault}`);
console.log(`日期范围：${minDate || '—'} ~ ${maxDate || '—'}`);
console.log(`题材覆盖：${withGenre}/${data.length}（${(withGenre / data.length * 100).toFixed(1)}%）`);
console.log(`题材分布：${dist || '无'}`);
console.log(`字段缺失：作者 ${missing.au} / 插图 ${missing.il} / 出版社 ${missing.pub} / 书系 ${missing.line} / 封面 ${missing.img} / 日期 ${missing.d}`);
console.log(`无卷数：单册 ${missing.vSingles} / 未完结或未知系列 ${missing.vSeries}`);
console.log(`类型标记：漫画 ${kinds.manga} / 画集 ${kinds.artbook} / 指南 ${kinds.guide}`);
console.log(`子卷索引：${indexed} 个系列 / ${indexedRefs} 条子卷引用`);
console.log(`子卷索引包：${chPack ? Object.keys(chPack).length : 0} 个系列 / ${chPack ? Object.values(chPack).reduce((n, list) => n + (Array.isArray(list) ? list.length : 0), 0) : 0} 条引用`);
console.log(`懒加载卷包：${volumes.length} 条；全部条目 ${data.length + volumes.length} 条`);
console.log(`核心拆包：轻量 ${liteData.length} 条 / 剩余 ${restData.length} 条`);
console.log(`扩展书目：${rn.length} 个系列 / ${(Number(rnMeta.volumes) || 0)} 卷（RanobeDB，默认隐藏）`);
console.log(`拆包：详情 ${Object.keys(extra).length} 条 / 封面路径 ${data.filter((x) => x.img && !/^https?:/.test(x.img)).length} 条`);

for (const keyword of ['文学少女', '无职转生', '白夜行', '人间失格']) {
  const visible = data.filter((x) => !x.c && matches(x, keyword));
  const sample = visible.slice(0, 5)
    .map((x) => `${x.i} ${x.cn || x.n}${x.sv ? ' [系列]' : ''}`)
    .join(' / ');
  console.log(`抽查「${keyword}」默认可见 ${visible.length} 条：${sample || '无'}`);
}

console.log(`问题总数：${total}`);
process.exitCode = total ? 1 : 0;
