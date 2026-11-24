// 清洗系列子卷，生成 data/light-novels.js
// 用法：node scripts/clean-series.mjs
// 优先使用 data/build/rel-*.json 中的 Bangumi 关联（relation=单行本）；
// 缺少关联数据时，退回「系列标题前缀 + 卷标/后缀词」规则。

import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { initials } from './build-pinyin.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const BUILD_DIR = path.join(ROOT, 'data', 'build');
const OUT_FILE = path.join(ROOT, 'data', 'light-novels.js');
const IMG_BASE_RE = /^https?:\/\/bgmimg\.anibt\.net\/r\/400\//;
const VOLUME_RELATIONS = new Set(['单行本', '番外篇']);
const SPLIT_TITLE_RE = /[（(]\s*(上|中|下|前編|後編|前篇|後篇|上巻|中巻|下巻)\s*[）)]|\s(上|中|下)$/g;

function normalizeSeriesKey(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[（(]\s*(上|中|下|前編|後編|前篇|後篇)\s*[）)]/g, '')
    .replace(/[\s"'“”‘’「」『』【】\[\]()（）:：\-–—~〜!?！？,，.。·、]/g, '');
}

function storyUnits(ids, byId) {
  const groups = new Set();
  ids.forEach((id) => {
    const book = byId.get(String(id));
    const title = String(book?.cn || book?.n || id);
    const base = title.replace(SPLIT_TITLE_RE, '').replace(/\s+/g, ' ').trim();
    groups.add(base || String(id));
  });
  return groups.size;
}

function normalizeIsbn(code) {
  const raw = String(code || '').replace(/[^0-9Xx]/g, '').toUpperCase();
  if (raw.length === 13) {
    if (!/^\d{13}$/.test(raw)) return '';
    const sum = raw.slice(0, 12).split('').reduce((n, d, i) => n + Number(d) * (i % 2 ? 3 : 1), 0);
    return (10 - (sum % 10)) % 10 === Number(raw[12]) ? raw : '';
  }
  if (raw.length !== 10) return '';
  const body = '978' + raw.slice(0, 9);
  const sum = body.split('').reduce((n, d, i) => n + Number(d) * (i % 2 ? 3 : 1), 0);
  const code13 = body + ((10 - (sum % 10)) % 10);
  return /^\d{13}$/.test(code13) ? code13 : '';
}

const VOLUME_RE = /^(?:第)?\d+(?:[卷册集话])?(?:[-~].*)?$/;
const SUFFIX_RE = /^(?:上|中|下|前|后|新装版|短篇集|外传|番外篇?|画集|公式书|设定集)[^\s]{0,8}$/;

export function normalizeTitle(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[\s\u3000'"“”‘’·・:：,，.。!！?？、\-—~～()（）\[\]【】《》〈〉<>]/g, '');
}

function seriesWithVolumeRelations(relations) {
  const ids = new Set();
  for (const [seriesId, rels] of relations.entries()) {
    const hit = (Array.isArray(rels) ? rels : []).some(
      (rel) => String(rel?.relation || '').trim() === '单行本',
    );
    if (hit) ids.add(String(seriesId));
  }
  return ids;
}

// 用 Bangumi 关联接口的「单行本」精确标记子卷；父系列不在库内时不标记，避免出现没有归属的子卷
export function markRelationChildren(records, relations) {
  const byId = new Map(records.map((x) => [String(x.i), x]));
  const flags = new Set();
  for (const [parentId, rels] of relations.entries()) {
    if (!byId.has(String(parentId))) continue;
    for (const rel of Array.isArray(rels) ? rels : []) {
      if (String(rel?.relation || '').trim() !== '单行本') continue;
      if (rel?.type != null && Number(rel.type) !== 1) continue;
      const child = byId.get(String(rel.id));
      if (!child || child.sv) continue;
      flags.add(String(rel.id));
    }
  }
  return flags;
}

// 关联数据缺失时的兜底规则，避免完全没有子卷清洗
function seriesKeys(records) {
  return records
    .filter((x) => x.sv)
    .map((x) => ({ id: String(x.i), key: normalizeTitle(x.cn || x.n) }))
    .filter((x) => x.key)
    .sort((a, b) => b.key.length - a.key.length);
}

function titleParentId(item, seriesList) {
  const key = normalizeTitle(item.cn || item.n);
  if (!key) return null;
  for (const s of seriesList) {
    if (key.length <= s.key.length || !key.startsWith(s.key)) continue;
    const rest = key.slice(s.key.length);
    if (VOLUME_RE.test(rest) || SUFFIX_RE.test(rest)) return s.id;
  }
  return null;
}

export function markTitleChildren(records, relations, flags) {
  const trusted = seriesWithVolumeRelations(relations);
  const series = seriesKeys(records);

  let added = 0;
  for (const item of records) {
    if (item.sv || flags.has(String(item.i))) continue;
    const key = normalizeTitle(item.cn || item.n);
    if (!key) continue;
    for (const s of series) {
      if (trusted.has(s.id)) continue;
      if (key.length <= s.key.length || !key.startsWith(s.key)) continue;
      const rest = key.slice(s.key.length);
      if (VOLUME_RE.test(rest) || SUFFIX_RE.test(rest)) {
        flags.add(String(item.i));
        added += 1;
        break;
      }
    }
  }
  return added;
}

const INHERIT_FIELDS = ['line', 'il', 'au', 'pub'];

function buildParentMap(records, relations) {
  const byId = new Map(records.map((x) => [String(x.i), x]));
  const map = new Map();
  for (const [parentId, rels] of relations.entries()) {
    const parent = byId.get(String(parentId));
    if (!parent) continue;
    for (const rel of Array.isArray(rels) ? rels : []) {
      if (String(rel?.relation || '').trim() !== '单行本') continue;
      if (rel?.type != null && Number(rel.type) !== 1) continue;
      const childId = String(rel.id);
      if (!byId.has(childId)) continue;
      if (!map.has(childId)) map.set(childId, []);
      map.get(childId).push(parent);
    }
  }
  // 同一子卷有多个父条目时，优先继承收藏数更高的父系列
  for (const list of map.values()) list.sort((a, b) => (b.h || 0) - (a.h || 0));
  return map;
}

// 子卷常省略书系/插图等系列级字段，缺失时从父系列继承
function inheritFromParents(records, parentsByChild) {
  const filled = { line: 0, il: 0, au: 0, pub: 0, tg: 0, kind: 0 };
  for (const item of records) {
    const parents = parentsByChild.get(String(item.i));
    if (!parents || !parents.length) continue;
    for (const key of INHERIT_FIELDS) {
      if (String(item[key] || '').trim()) continue;
      const parent = parents.find((p) => String(p[key] || '').trim());
      if (parent) {
        item[key] = parent[key];
        filled[key] += 1;
      }
    }
    if (!Array.isArray(item.tg) || !item.tg.length) {
      const parent = parents.find((p) => Array.isArray(p.tg) && p.tg.length);
      if (parent) {
        item.tg = parent.tg.slice();
        filled.tg += 1;
      }
    }
    if (!item.kind) {
      const parent = parents.find((p) => p.kind);
      if (parent) {
        item.kind = parent.kind;
        filled.kind += 1;
      }
    }
  }
  return filled;
}

// 系列条目缺失的系列级字段，从子卷共识继承；首卷发售日取最早子卷日期
const INHERIT_FROM_CHILDREN = ['line', 'il', 'au', 'pub'];

function inheritFromChildren(records, childrenByParent) {
  const byId = new Map(records.map((x) => [String(x.i), x]));
  const filled = { line: 0, il: 0, au: 0, pub: 0, d: 0, img: 0 };
  for (const [parentId, ids] of childrenByParent.entries()) {
    const parent = byId.get(String(parentId));
    if (!parent) continue;
    const children = ids.map((id) => byId.get(String(id))).filter(Boolean);
    if (!children.length) continue;
    for (const key of INHERIT_FROM_CHILDREN) {
      if (String(parent[key] || '').trim()) continue;
      const values = children.map((c) => c[key]).filter((v) => String(v || '').trim());
      if (!values.length) continue;
      const freq = new Map();
      values.forEach((v) => freq.set(v, (freq.get(v) || 0) + 1));
      const [top, count] = [...freq.entries()].sort((a, b) => b[1] - a[1])[0];
      // 单子卷直接采用；多子卷要求至少两票且过半，避免被单个外传带偏
      const threshold = values.length === 1 ? 1 : Math.max(2, Math.ceil(values.length / 2));
      if (count >= threshold) {
        parent[key] = top;
        filled[key] += 1;
      }
    }
    if (!parent.d) {
      const dates = children.map((c) => c.d).filter(Boolean).sort();
      if (dates.length) {
        parent.d = dates[0];
        filled.d += 1;
      }
    }
    if (!parent.img) {
      const child = children
        .filter((c) => c.img)
        .sort((a, b) => String(a.d || '').localeCompare(String(b.d || '')))[0];
      if (child) {
        parent.img = child.img;
        filled.img += 1;
      }
    }
  }
  return filled;
}

// 父系列 → 子卷索引：用于「一键加入系列全部子卷」
function buildChildrenMap(records, relations, flags) {
  const parentsByChild = buildParentMap(records, relations);
  const byId = new Map(records.map((x) => [String(x.i), x]));
  const children = new Map();
  for (const [childId, parents] of parentsByChild.entries()) {
    if (!flags.has(childId)) continue;
    const parent = parents[0];
    if (!parent) continue;
    const pid = String(parent.i);
    if (!children.has(pid)) children.set(pid, []);
    children.get(pid).push(childId);
  }
  for (const list of children.values()) {
    list.sort((a, b) => {
      const da = String(byId.get(a)?.d || '');
      const db = String(byId.get(b)?.d || '');
      return da.localeCompare(db) || Number(a) - Number(b);
    });
  }
  // 标题兜底标记的子卷没有关联记录，按标题前缀补进所属系列，保证 ch 索引完整
  const covered = new Set();
  children.forEach((list) => list.forEach((id) => covered.add(id)));
  const seriesList = seriesKeys(records);
  for (const item of records) {
    const cid = String(item.i);
    if (!flags.has(cid) || covered.has(cid)) continue;
    const pid = titleParentId(item, seriesList);
    if (!pid || pid === cid) continue;
    if (!children.has(pid)) children.set(pid, []);
    children.get(pid).push(cid);
    covered.add(cid);
  }
  children.forEach((list) => list.sort((a, b) => {
    const da = String(byId.get(a)?.d || '');
    const db = String(byId.get(b)?.d || '');
    return da.localeCompare(db) || Number(a) - Number(b);
  }));
  return children;
}

// 关联里有、但库中没有的日本轻小说卷：生成懒加载卷包，不进入首屏核心包
export function buildMissingVolumes(records, relations) {
  const byId = new Map(records.map((x) => [String(x.i), x]));
  const parents = [];
  for (const [parentId, rels] of relations.entries()) {
    const parent = byId.get(String(parentId));
    if (!parent) continue;
    if (parent.gn || !/[\u3040-\u30ff]/.test(parent.n || '')) continue;
    parents.push([parent, Array.isArray(rels) ? rels : []]);
  }
  // 同一卷挂在多个系列时，归到收藏数最高的系列，避免 ch 重复
  parents.sort((a, b) => (b[0].h || 0) - (a[0].h || 0));

  const volumes = [];
  const parentById = new Map();
  for (const [parent, rels] of parents) {
    for (const rel of rels) {
      if (rel?.type != null && Number(rel.type) !== 1) continue;
      const relation = String(rel?.relation || '').trim();
      if (!VOLUME_RELATIONS.has(relation)) continue;
      const id = String(rel.id);
      if (!id || byId.has(id) || parentById.has(id)) continue;
      const name = String(rel.name || '').trim();
      if (!name) continue;
      const cn = String(rel.name_cn || '').trim();
      const img = String(rel.images?.common || rel.images?.large || '').replace(IMG_BASE_RE, '');
      volumes.push({
        i: Number(rel.id),
        n: name,
        cn,
        img,
        sv: false,
        c: true,
        ns: false,
        py: initials(cn || name),
      });
      parentById.set(id, String(parent.i));
    }
  }
  return { volumes, parentById };
}

export async function buildData(records, relations = new Map(), {
  fallback = true,
  generatedAt = new Date().toISOString(),
  outFile = OUT_FILE,
  volumePack = { volumes: [], parentById: new Map() },
} = {}) {
  // 人工确认的漏卷关系：Bangumi 上存在但未被系列关联覆盖
  try {
    const manual = JSON.parse(await readFile(path.join(ROOT, 'data', 'manual-relations.json'), 'utf8'));
    Object.entries(manual).forEach(([parentId, childIds]) => {
      const existingKey = [...relations.keys()].find((k) => String(k) === String(parentId));
      const key = existingKey === undefined ? String(parentId) : existingKey;
      const list = relations.get(key) || [];
      (Array.isArray(childIds) ? childIds : []).forEach((childId) => {
        const exists = list.some((rel) => String(rel?.id) === String(childId) &&
          String(rel?.relation || '').trim() === '单行本' &&
          (rel?.type == null || Number(rel.type) === 1));
        if (!exists) list.push({ id: Number(childId), type: 1, relation: '单行本', name: '' });
      });
      relations.set(key, list);
    });
  } catch { /* 没有人工关系文件时跳过 */ }

  // Bangumi 详情补全候选：只填空字段，不覆盖已有值
  let detailFills = {};
  try {
    const raw = JSON.parse(await readFile(path.join(ROOT, 'data', 'bgm-detail-fills.json'), 'utf8'));
    detailFills = raw.fills || {};
  } catch { /* 没有详情补全文件时跳过 */ }
  const detailFilled = { date: 0, cover: 0, au: 0, pub: 0, line: 0, il: 0 };
  for (const item of records) {
    const fill = detailFills[String(item.i)];
    if (!fill) continue;
    if (!item.d && fill.date) {
      item.d = fill.date;
      detailFilled.date += 1;
    }
    if (!item.img && fill.cover) {
      item.img = fill.cover;
      detailFilled.cover += 1;
    }
    for (const [key, field] of [['author', 'au'], ['publisher', 'pub'], ['line', 'line'], ['illustrator', 'il']]) {
      if (!String(item[field] || '').trim() && fill[key]) {
        item[field] = fill[key];
        detailFilled[field] += 1;
      }
    }
  }

  const parentsByChild = buildParentMap(records, relations);
  const inherited = inheritFromParents(records, parentsByChild);
  const flags = markRelationChildren(records, relations);
  const relationChildren = flags.size;
  const fallbackAdded = fallback ? markTitleChildren(records, relations, flags) : 0;

  const childrenByParent = buildChildrenMap(records, relations, flags);
  const inheritedFromChildren = inheritFromChildren(records, childrenByParent);

  // 懒加载卷包：只把新卷挂到父系列的 ch，不放进首屏核心包
  const volumes = Array.isArray(volumePack?.volumes) ? volumePack.volumes : [];
  const volumeParentById = volumePack?.parentById || new Map();
  // RanobeDB 人工核对的补卷：只在父系列存在时合并，避免把卷挂到不存在的条目
  try {
    const fixes = JSON.parse(await readFile(path.join(ROOT, 'data', 'ranobedb-volume-fixes.json'), 'utf8'));
    const knownIds = new Set(volumes.map((v) => String(v.i)));
    const parentIds = new Set(records.map((x) => String(x.i)));
    Object.entries(fixes.parents || {}).forEach(([parentId, info]) => {
      if (!parentIds.has(String(parentId))) return;
      (Array.isArray(info?.volumes) ? info.volumes : []).forEach((v) => {
        const id = String(v?.i);
        if (!id || knownIds.has(id) || parentIds.has(id)) return;
        knownIds.add(id);
        volumes.push(v);
        volumeParentById.set(id, String(parentId));
      });
    });
  } catch { /* 没有补卷文件时跳过 */ }
  volumeParentById.forEach((pid, cid) => {
    if (!childrenByParent.has(pid)) childrenByParent.set(pid, []);
    const list = childrenByParent.get(pid);
    if (!list.includes(cid)) list.push(cid);
  });
  childrenByParent.forEach((list) => list.sort((a, b) => Number(a) - Number(b)));

  // 拆包：详情字段按需加载，网格首屏不下载；封面只存路径，运行时再拼图片域名
  const EXTRA_KEYS = ['au', 'il', 'pub', 'line', 'isbn', 'fisbn', 'jd'];
  // 重建时保留 openBD / RanobeDB 已写回 extra 的补全字段，避免清洗覆盖
  let previousExtra = {};
  try {
    const extraRaw = await readFile(path.join(ROOT, 'data', 'light-novels-extra.js'), 'utf8');
    const extraMatch = extraRaw.match(/window\.LN_EXTRA\s*=\s*(\{[\s\S]*\});?/);
    if (extraMatch) previousExtra = JSON.parse(extraMatch[1]);
  } catch { /* 首次构建没有 extra 文件 */ }
  const extra = {};
  const final = records.map(({ rt, ...rest }) => {
    const out = { ...rest, c: flags.has(String(rest.i)) };
    const prev = previousExtra[String(rest.i)];
    if (prev) {
      EXTRA_KEYS.forEach((key) => {
        if (!out[key] && prev[key]) out[key] = prev[key];
      });
    }
    if (!Array.isArray(out.tg) || !out.tg.length) delete out.tg;
    if (out.isbn) {
      const isbn = normalizeIsbn(out.isbn);
      if (isbn) out.isbn = isbn;
      else delete out.isbn;
    }
    if (out.sv && childrenByParent.has(String(rest.i))) out.ch = childrenByParent.get(String(rest.i));
    const fields = {};
    EXTRA_KEYS.forEach((key) => {
      if (out[key]) fields[key] = out[key];
      delete out[key];
    });
    if (Object.keys(fields).length) extra[String(out.i)] = fields;
    if (typeof out.img === 'string') out.img = out.img.replace(IMG_BASE_RE, '');
    return out;
  });

  final.sort((a, b) => {
    const da = a.d || '';
    const db = b.d || '';
    if (da !== db) return db.localeCompare(da);
    if (b.h !== a.h) return b.h - a.h;
    return a.i - b.i;
  });

  // 拆分卷：上/中/下按同一故事卷计，详情与统计区分「册」和「故事卷」
  const allBooks = new Map([...final, ...volumes].map((x) => [String(x.i), x]));
  let physicalVolumes = 0;
  let storyVolumes = 0;
  final.forEach((item) => {
    if (!item.sv || !Array.isArray(item.ch) || !item.ch.length) return;
    physicalVolumes += item.ch.length;
    const units = storyUnits(item.ch, allBooks);
    storyVolumes += units;
    if (units < item.ch.length) item.chs = units;
  });

  // 同名系列条目：保留卷数最多、收藏最高的主条目，其余标记 ver 并默认隐藏
  const seriesGroups = new Map();
  final.filter((x) => x.sv).forEach((item) => {
    const key = normalizeSeriesKey(item.n) || normalizeSeriesKey(item.cn);
    if (!key) return;
    if (!seriesGroups.has(key)) seriesGroups.set(key, []);
    seriesGroups.get(key).push(item);
  });
  let versionCount = 0;
  seriesGroups.forEach((list) => {
    if (list.length < 2) return;
    list.sort((a, b) => (b.ch?.length || 0) - (a.ch?.length || 0) ||
      (b.h || 0) - (a.h || 0) || a.i - b.i);
    const primary = list[0];
    list.slice(1).forEach((item) => {
      item.ver = primary.i;
      versionCount += 1;
    });
  });

  // 重复版本缺失的作者 / 插图从主条目继承；书系、出版社、日期可能因版本不同，不自动继承
  const verInherited = { au: 0, il: 0 };
  final.filter((x) => x.ver).forEach((item) => {
    const primary = extra[String(item.ver)] || {};
    const fields = extra[String(item.i)] || (extra[String(item.i)] = {});
    for (const key of ['au', 'il']) {
      if (!String(fields[key] || '').trim() && String(primary[key] || '').trim()) {
        fields[key] = primary[key];
        verInherited[key] += 1;
      }
    }
  });

  const dates = final.map((x) => x.d).filter(Boolean).sort();
  const meta = {
    generatedAt,
    count: final.length,
    volumes: volumes.length,
    general: final.filter((x) => x.gn).length,
    versions: versionCount,
    physicalVolumes,
    storyVolumes,
    minDate: dates[0] || '',
    maxDate: dates[dates.length - 1] || '',
  };

  const content = '// 由 scripts/fetch-books.mjs / clean-series.mjs 生成，请勿手动修改\n' +
    `window.LN_META = ${JSON.stringify(meta)};\n` +
    `window.LN_DATA = ${JSON.stringify(final)};\n`;
  await mkdir(path.dirname(outFile), { recursive: true });
  await writeFile(outFile, content, 'utf8');

  // 首屏轻量核心：只放默认可见条目；子卷、一般小说与重复版本后台加载
  const lite = final.filter((x) => !x.c && !x.gn && !x.ver);
  const rest = final.filter((x) => x.c || x.gn || x.ver);
  const liteFile = outFile.replace(/\.js$/, '-lite.js');
  const restFile = outFile.replace(/\.js$/, '-rest.js');
  const header = '// 由 scripts/fetch-books.mjs / clean-series.mjs 生成，请勿手动修改\n';
  await writeFile(liteFile, header +
    `window.LN_META = ${JSON.stringify(meta)};\n` +
    `window.LN_DATA = ${JSON.stringify(lite)};\n`, 'utf8');
  await writeFile(restFile, header +
    `window.LN_REST = ${JSON.stringify(rest)};\n`, 'utf8');

  const extraFile = outFile.replace(/\.js$/, '-extra.js');
  const extraContent = '// 由 scripts/fetch-books.mjs / clean-series.mjs 生成，请勿手动修改\n' +
    `window.LN_EXTRA = ${JSON.stringify(extra)};\n`;
  await writeFile(extraFile, extraContent, 'utf8');

  const volumeFile = outFile.replace(/\.js$/, '-volumes.js');
  const volumeContent = '// 由 scripts/fetch-books.mjs / clean-series.mjs 生成，请勿手动修改\n' +
    `window.LN_VOLUMES = ${JSON.stringify(volumes)};\n`;
  await writeFile(volumeFile, volumeContent, 'utf8');

  return {
    total: final.length,
    series: final.filter((x) => x.sv).length,
    singles: final.filter((x) => !x.sv).length,
    children: final.filter((x) => x.c).length,
    volumes: volumes.length,
    visible: final.filter((x) => !x.c).length,
    relationSeries: relations.size,
    relationChildren,
    fallbackAdded,
    inherited,
    inheritedFromChildren,
    verInherited,
    detailFilled,
    outFile,
    liteFile,
    restFile,
    liteCount: lite.length,
    restCount: rest.length,
    extraFile,
    extraCount: Object.keys(extra).length,
    volumeFile,
  };
}

export async function loadCachedPages() {
  let files;
  try {
    files = (await readdir(BUILD_DIR)).filter((f) => /^page-.+\.json$/.test(f)).sort();
  } catch {
    throw new Error('未找到分页缓存，请先运行 npm run fetch-data');
  }
  if (!files.length) throw new Error('分页缓存为空，请先运行 npm run fetch-data');

  const seen = new Set();
  const all = [];
  // 轻小说分页排在前面；只出现在「小说」分页里的条目标记为一般小说
  const ordered = files
    .filter((f) => !f.startsWith('page-novel-'))
    .concat(files.filter((f) => f.startsWith('page-novel-')));
  for (const file of ordered) {
    const isNovel = file.startsWith('page-novel-');
    const page = JSON.parse(await readFile(path.join(BUILD_DIR, file), 'utf8'));
    for (const item of Array.isArray(page) ? page : []) {
      const id = String(item.i);
      if (seen.has(id)) continue;
      seen.add(id);
      if (isNovel) item.gn = true;
      all.push(item);
    }
  }
  return all;
}

export async function loadCachedRelations(records) {
  const map = new Map();
  for (const item of records) {
    if (!item.sv) continue;
    try {
      const raw = await readFile(path.join(BUILD_DIR, `rel-${item.i}.json`), 'utf8');
      const rel = JSON.parse(raw);
      map.set(String(item.i), Array.isArray(rel) ? rel : []);
    } catch {
      // 关联缓存缺失时交给标题兜底
    }
  }
  return map;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const records = await loadCachedPages();
  const relations = await loadCachedRelations(records);
  const volumePack = buildMissingVolumes(records, relations);
  const stats = await buildData(records, relations, { volumePack });
  console.log(`完成：${stats.total} 条（系列 ${stats.series} / 单册 ${stats.singles} / 子卷 ${stats.children}）`);
  console.log(`懒加载卷包：${stats.volumes} 条 → ${stats.volumeFile}`);
  console.log(`关联覆盖 ${stats.relationSeries} 个系列，关联子卷 ${stats.relationChildren} 条，标题兜底 ${stats.fallbackAdded} 条`);
  console.log(`父系列继承：书系 ${stats.inherited.line} / 插图 ${stats.inherited.il} / 作者 ${stats.inherited.au} / 出版社 ${stats.inherited.pub} / 题材 ${stats.inherited.tg} / 类型 ${stats.inherited.kind}`);
  console.log(`子卷→系列继承：书系 ${stats.inheritedFromChildren.line} / 插图 ${stats.inheritedFromChildren.il} / 作者 ${stats.inheritedFromChildren.au} / 出版社 ${stats.inheritedFromChildren.pub} / 日期 ${stats.inheritedFromChildren.d} / 封面 ${stats.inheritedFromChildren.img}`);
  console.log(`重复版本继承：作者 ${stats.verInherited.au} / 插图 ${stats.verInherited.il}`);
  console.log(`详情补全：日期 ${stats.detailFilled.date} / 封面 ${stats.detailFilled.cover} / 作者 ${stats.detailFilled.au} / 出版社 ${stats.detailFilled.pub} / 书系 ${stats.detailFilled.line} / 插图 ${stats.detailFilled.il}`);
  console.log(`输出 ${stats.outFile}`);
}
