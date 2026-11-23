// 从 Bangumi 镜像抓取「轻小说」与「小说」标签下的书籍，分页缓存后生成 data/light-novels.js
// 用法：node scripts/fetch-books.mjs [--refresh] [--no-relations]
//
// 搜索接口单次最多只能翻到 offset=980（1000 条），因此按评分人数分区抓取；
// 单个分区仍超过 1000 时自动继续二分。两个标签合并去重，
// 只在「小说」标签出现、没有「轻小说」标签的条目标记为 gn（一般小说），默认隐藏。
// 已抓取的分页与系列关联会自动跳过，可重复运行增量补齐。

import { mkdir, writeFile, readFile, access, rm, readdir } from 'node:fs/promises';
import path from 'node:path';
import { initials } from './build-pinyin.mjs';
import { genreIdsFromNames, rawTagNames } from './genres.mjs';
import { buildData, buildMissingVolumes } from './clean-series.mjs';

const BASE = 'https://bgmapi.anibt.net';
const PAGE_SIZE = 20;
const DELAY_MS = 800;
const USER_AGENT = 'yuc-light-novel-list/1.0';
const REFRESH = process.argv.includes('--refresh');
// --refresh-pages：只重抓分页，保留已缓存的系列关联（用于新增字段后重算）
const REFRESH_PAGES = process.argv.includes('--refresh-pages');
const NO_RELATIONS = process.argv.includes('--no-relations');
const META_SCHEMA = 'tag-partitions-v2';

// 抓取顺序很重要：先轻小说，再小说，后者的重复条目会被跳过
const TAGS = [
  { key: 'ln', name: '轻小说' },
  { key: 'novel', name: '小说' },
];

// rating_count 分区：全部满足 >=min 且 <max，最后一段为开区间
const PARTITIONS = [
  { key: 'rc0', label: '0-9', min: 0, max: 10 },
  { key: 'rc10', label: '10-19', min: 10, max: 20 },
  { key: 'rc20', label: '20-29', min: 20, max: 30 },
  { key: 'rc30', label: '30-39', min: 30, max: 40 },
  { key: 'rc40', label: '40-49', min: 40, max: 50 },
  { key: 'rc50', label: '50-74', min: 50, max: 75 },
  { key: 'rc75', label: '75-99', min: 75, max: 100 },
  { key: 'rc100', label: '100-499', min: 100, max: 500 },
  { key: 'rc500', label: '500-999', min: 500, max: 1000 },
  { key: 'rc1000', label: '1000+', min: 1000, max: null },
];

const rootDir = path.resolve(import.meta.dirname, '..');
const buildDir = path.join(rootDir, 'data', 'build');
const metaFile = path.join(buildDir, 'meta.json');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// 轻小说沿用旧文件名，避免已有缓存全部重抓；小说单独加前缀
const pageFile = (tagKey, partition, index) => path.join(
  buildDir,
  `page-${tagKey === 'ln' ? '' : tagKey + '-'}${partition.key}-${String(index).padStart(4, '0')}.json`,
);
const relFile = (id) => path.join(buildDir, `rel-${id}.json`);

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

let lastRequestAt = 0;
async function throttle() {
  const wait = DELAY_MS - (Date.now() - lastRequestAt);
  if (wait > 0) await sleep(wait);
  lastRequestAt = Date.now();
}

function flattenValue(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value)) {
    return value
      .map((v) => {
        if (v == null) return '';
        if (typeof v === 'string') return v.trim();
        if (typeof v === 'object') return String(v.v ?? v.k ?? '').trim();
        return String(v).trim();
      })
      .filter(Boolean)
      .join(' / ');
  }
  if (typeof value === 'object') return String(value.v ?? value.k ?? '').trim();
  return String(value).trim();
}

function infoboxValue(infobox, keys) {
  if (!Array.isArray(infobox)) return '';
  for (const key of keys) {
    const hit = infobox.find((x) => x && String(x.key).trim() === key);
    if (!hit) continue;
    const text = flattenValue(hit.value);
    if (text) return text;
  }
  return '';
}

function isbnValue(infobox) {
  if (!Array.isArray(infobox)) return '';
  for (const entry of infobox) {
    if (!entry || !/isbn/i.test(String(entry.key || ''))) continue;
    const digits = flattenValue(entry.value).replace(/[^0-9Xx]/g, '');
    if (digits.length === 13) return digits;
    if (digits.length === 10) return digits.toUpperCase();
  }
  return '';
}

// 中文版/台版的书系常嵌在「版本:xxx」对象里
function nestedVersionValue(infobox, keys) {
  if (!Array.isArray(infobox)) return '';
  for (const entry of infobox) {
    if (!entry || !/^版本/.test(String(entry.key || ''))) continue;
    const list = Array.isArray(entry.value) ? entry.value : [];
    for (const kv of list) {
      if (!kv || typeof kv !== 'object') continue;
      if (keys.includes(String(kv.k || '').trim()) && kv.v) return String(kv.v).trim();
    }
  }
  return '';
}

function detectKind(item, tags, art, rawIllust) {
  const hay = `${item.name || ''} ${item.name_cn || ''} ${tags.join(' ')}`;
  if (/(画集|画册|art\s*book|artbook|visual\s*book|イラスト集|ビジュアルブック)/i.test(hay)) {
    return 'artbook';
  }
  if (/(公式书|公式集|设定集|設定集|ガイドブック|guide\s*book|fan\s*book|ファンブック|公式ガイド)/i.test(hay)) {
    return 'guide';
  }
  // 轻小说用「插图」，漫画用「作画」；有作画基本可判定为漫画/改编
  if (art) return 'manga';
  if (!rawIllust && /漫画|コミック/.test(tags.join(' '))) return 'manga';
  return '';
}

function slim(item) {
  // rt 只写入分页缓存，便于以后调整题材映射时离线重算；不会进入 light-novels.js
  const tags = rawTagNames(item.meta_tags, item.tags);
  const volumes = Number(item.volumes);
  const infobox = item.infobox;
  const rawAuthor = infoboxValue(infobox, ['作者', '著者', '作者名']);
  const original = infoboxValue(infobox, ['原作']);
  const rawIllust = infoboxValue(infobox, ['插图', '插画', 'イラスト', 'イラストレーター']);
  const art = infoboxValue(infobox, ['作画']);
  const line = infoboxValue(infobox, ['书系', '文库', 'レーベル', '丛书', '图书品牌', 'レーベル名'])
    || nestedVersionValue(infobox, ['书系', '文库', 'レーベル', '丛书', '图书品牌']);
  const kind = detectKind(item, tags, art, rawIllust);
  const out = {
    i: item.id,
    n: item.name || '',
    cn: item.name_cn || '',
    d: item.date || '',
    v: Number.isFinite(volumes) && volumes > 0 ? volumes : 0,
    sv: item.series === true,
    c: false,
    s: Number(item.rating?.score) || 0,
    rk: Number(item.rating?.rank) || 0,
    h: Number(item.collection?.collect) || 0,
    img: item.images?.common || item.images?.large || '',
    py: initials(item.name_cn || item.name || ''),
    tg: genreIdsFromNames(tags),
    // 作者/插图优先用标准键，缺失时退回原作/作画，避免漫画改编被记为空
    au: rawAuthor || original,
    il: rawIllust || art || infoboxValue(infobox, ['人物原案']),
    pub: infoboxValue(infobox, ['出版社', '发行', '出版商', '発行']),
    line,
    isbn: isbnValue(infobox),
    ns: item.nsfw === true,
    rt: tags,
  };
  if (kind) out.kind = kind;
  return out;
}

async function requestJson(url, options, label) {
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    await throttle();
    try {
      const res = await fetch(url, { ...options, signal: AbortSignal.timeout(30000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      if (attempt === 4) throw err;
      const wait = attempt * 2000;
      console.warn(`    ${label} 重试 ${attempt}/3：${err.message}，${wait}ms 后继续`);
      await sleep(wait);
    }
  }
}

function partitionFilter(partition, tagName) {
  const ratingCount = partition.max == null
    ? [`>=${partition.min}`]
    : [`>=${partition.min}`, `<${partition.max}`];
  return { type: [1], tag: [tagName], rating_count: ratingCount };
}

function requestPage(partition, offset, tagName) {
  const payload = {
    keyword: '',
    sort: 'heat',
    filter: partitionFilter(partition, tagName),
  };
  const url = `${BASE}/v0/search/subjects?limit=${PAGE_SIZE}&offset=${offset}`;
  return requestJson(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': USER_AGENT },
    body: JSON.stringify(payload),
  }, `${tagName}-${partition.key}@${offset}`);
}

function requestRelations(id) {
  const url = `${BASE}/v0/subjects/${id}/subjects`;
  return requestJson(url, {
    headers: { 'User-Agent': USER_AGENT },
  }, `rel@${id}`);
}

async function readMeta() {
  if (REFRESH || REFRESH_PAGES || !await exists(metaFile)) return null;
  try {
    const meta = JSON.parse(await readFile(metaFile, 'utf8'));
    if (meta.schema !== META_SCHEMA || !meta.tags || typeof meta.tags !== 'object') return null;
    return meta;
  } catch {
    return null;
  }
}

// 分区仍超过搜索接口上限时继续二分
function splitPartition(partition) {
  if (partition.max == null) {
    const nextMax = Math.max(partition.min + 1, partition.min * 2 || 1000);
    return [
      { key: `${partition.key}-a`, label: `${partition.min}-${nextMax - 1}`, min: partition.min, max: nextMax },
      { key: `${partition.key}-b`, label: `${nextMax}+`, min: nextMax, max: null },
    ];
  }
  if (partition.max - partition.min <= 1) return null;
  const mid = partition.min + Math.floor((partition.max - partition.min) / 2);
  return [
    { key: `${partition.key}-a`, label: `${partition.min}-${mid - 1}`, min: partition.min, max: mid },
    { key: `${partition.key}-b`, label: `${mid}-${partition.max - 1}`, min: mid, max: partition.max },
  ];
}

// 分区拆分后清掉父级分页，避免离线重算时把重复条目再读回来
async function clearPartitionPages(tagKey, partition) {
  const prefix = `page-${tagKey === 'ln' ? '' : tagKey + '-'}${partition.key}-`;
  const files = await readdir(buildDir).catch(() => []);
  await Promise.all(files
    .filter((f) => f.startsWith(prefix) && f.endsWith('.json'))
    .map((f) => rm(path.join(buildDir, f), { force: true })));
}

async function collectTag(tag, cachedPartitions, state) {
  const { seen, all, lnIds } = state;

  const leaves = [];
  // 有缓存时直接从上次的分区叶子开始，避免每次重查基础分区总数
  const queue = Array.isArray(cachedPartitions) && cachedPartitions.length
    ? cachedPartitions.map((p) => ({ ...p }))
    : PARTITIONS.map((p) => ({ ...p }));
  let fetched = 0;

  while (queue.length) {
    const partition = queue.shift();
    let total = partition.total == null ? null : Number(partition.total);
    let firstPage = null;
    if (total == null) {
      const first = await requestPage(partition, 0, tag.name);
      total = Number(first.total) || 0;
      firstPage = (Array.isArray(first.data) ? first.data : []).map(slim);
      console.log(`[${tag.name}] 分区 ${partition.label}：${total} 条`);
    }

    if (total > 1000) {
      const parts = splitPartition(partition);
      if (!parts) throw new Error(`[${tag.name}] 分区 ${partition.label} 有 ${total} 条且无法继续拆分`);
      await clearPartitionPages(tag.key, partition);
      console.log(`[${tag.name}] 分区 ${partition.label} 超过 1000 条，拆为 ${parts.map((p) => p.label).join(' / ')}`);
      queue.unshift(...parts);
      continue;
    }

    const pageCount = Math.ceil(total / PAGE_SIZE);
    for (let index = 0; index < pageCount; index += 1) {
      const offset = index * PAGE_SIZE;
      const cacheFile = pageFile(tag.key, partition, index);
      let page;
      if (index === 0 && firstPage) {
        page = firstPage;
        await writeFile(cacheFile, JSON.stringify(page), 'utf8');
      } else if (!REFRESH && await exists(cacheFile)) {
        page = JSON.parse(await readFile(cacheFile, 'utf8'));
      } else {
        const data = await requestPage(partition, offset, tag.name);
        page = (Array.isArray(data.data) ? data.data : []).map(slim);
        await writeFile(cacheFile, JSON.stringify(page), 'utf8');
      }
      for (const item of Array.isArray(page) ? page : []) {
        const id = String(item.i);
        if (seen.has(id)) continue;
        seen.add(id);
        all.push(item);
        fetched += 1;
        if (tag.key === 'ln') lnIds.add(id);
      }
      if (!page.length) break;
    }
    leaves.push({ key: partition.key, label: partition.label, min: partition.min, max: partition.max, total });
    console.log(`[${tag.name}] 分区 ${partition.label} 完成，累计 ${all.length} 条`);
  }

  return { leaves, fetched };
}

async function main() {
  await mkdir(buildDir, { recursive: true });
  if (REFRESH) {
    await rm(buildDir, { recursive: true, force: true });
    await mkdir(buildDir, { recursive: true });
  } else if (REFRESH_PAGES) {
    // 只清分页与 meta，保留 rel-*.json，避免重新抓 1123 个系列关系
    const files = await readdir(buildDir).catch(() => []);
    for (const file of files) {
      if (/^page-.+\.json$/.test(file) || file === 'meta.json') {
        await rm(path.join(buildDir, file), { force: true });
      }
    }
    console.log('已清理分页缓存，保留系列关联缓存');
  }

  const cachedMeta = await readMeta();
  const seen = new Set();
  const lnIds = new Set();
  const all = [];
  const tagMeta = {};

  for (const tag of TAGS) {
    const cache = cachedMeta && cachedMeta.tags ? cachedMeta.tags[tag.key] : null;
    const result = await collectTag(tag, cache && cache.partitions, { seen, all, lnIds });
    tagMeta[tag.key] = {
      name: tag.name,
      total: result.leaves.reduce((n, p) => n + p.total, 0),
      fetched: result.fetched,
      partitions: result.leaves,
    };
    console.log(`[${tag.name}] 完成：新增 ${result.fetched} 条，累计 ${all.length} 条`);
  }

  // 只在「小说」标签出现、没有「轻小说」标签的条目，标记为一般小说
  let generalCount = 0;
  all.forEach((item) => {
    if (lnIds.has(String(item.i))) return;
    item.gn = true;
    generalCount += 1;
  });

  const metaInfo = {
    schema: META_SCHEMA,
    total: all.length,
    general: generalCount,
    tags: tagMeta,
    generatedAt: new Date().toISOString(),
  };

  console.log(`合并去重：${all.length} 条（轻小说 ${tagMeta.ln.total} / 小说 ${tagMeta.novel.total} / 一般小说新增 ${generalCount}）`);

  const relations = new Map();
  if (NO_RELATIONS) {
    console.log('已跳过系列关联抓取，使用标题规则兜底');
  } else {
    const series = all.filter((x) => x.sv);
    console.log(`开始抓取 ${series.length} 个系列关联（间隔 ${DELAY_MS}ms，可中断续跑）`);
    let fetched = 0;
    let cached = 0;
    let failed = 0;

    for (let index = 0; index < series.length; index += 1) {
      const item = series[index];
      let rel = null;
      const cacheFile = relFile(item.i);
      if (!REFRESH && await exists(cacheFile)) {
        try {
          const raw = JSON.parse(await readFile(cacheFile, 'utf8'));
          rel = Array.isArray(raw) ? raw : [];
          cached += 1;
        } catch {
          rel = null;
        }
      }
      if (!rel) {
        try {
          const raw = await requestRelations(item.i);
          rel = Array.isArray(raw) ? raw : [];
          await writeFile(cacheFile, JSON.stringify(rel), 'utf8');
          fetched += 1;
        } catch (err) {
          failed += 1;
          rel = [];
          console.warn(`    关联 ${item.i} 失败：${err.message}`);
        }
      }
      relations.set(String(item.i), rel);
      if ((index + 1) % 50 === 0 || index === series.length - 1) {
        console.log(`关联 ${index + 1}/${series.length}（新抓 ${fetched} / 缓存 ${cached} / 失败 ${failed}）`);
      }
    }
  }

  // 与轻小说系列有关联的条目仍按轻小说处理，避免系列子卷被默认隐藏
  const lnRelated = new Set();
  for (const [parentId, rels] of relations.entries()) {
    if (!lnIds.has(String(parentId))) continue;
    for (const rel of Array.isArray(rels) ? rels : []) {
      if (String(rel?.relation || '').trim() !== '单行本') continue;
      if (rel?.type != null && Number(rel.type) !== 1) continue;
      lnRelated.add(String(rel.id));
    }
  }
  let adjusted = 0;
  all.forEach((item) => {
    if (!item.gn) return;
    const rels = relations.get(String(item.i)) || [];
    const hasLnChild = rels.some((rel) => lnIds.has(String(rel?.id)));
    if (lnRelated.has(String(item.i)) || hasLnChild) {
      delete item.gn;
      adjusted += 1;
    }
  });
  if (adjusted) console.log(`系列关联修正：${adjusted} 条一般小说随系列保留为轻小说`);

  metaInfo.total = all.length;
  metaInfo.general = all.filter((x) => x.gn).length;
  await writeFile(metaFile, JSON.stringify(metaInfo), 'utf8');

  const stats = await buildData(all, relations, { volumePack: buildMissingVolumes(all, relations) });
  console.log(`完成：${stats.total} 条（系列 ${stats.series} / 单册 ${stats.singles} / 子卷 ${stats.children} / 默认可见 ${stats.visible}）`);
  console.log(`懒加载卷包：${stats.volumes} 条 → ${stats.volumeFile}`);
  console.log(`关联子卷 ${stats.relationChildren} 条，标题兜底 ${stats.fallbackAdded} 条`);
  console.log(`父系列继承：书系 ${stats.inherited.line} / 插图 ${stats.inherited.il} / 作者 ${stats.inherited.au} / 出版社 ${stats.inherited.pub} / 题材 ${stats.inherited.tg} / 类型 ${stats.inherited.kind}`);
  console.log(`输出 ${stats.outFile}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
