// 用 RanobeDB 系列数据只读校验卷数差异
// 用法：node scripts/validate-ranobedb.mjs [--limit=120]
// 输出 reports/ranobedb-validate-2026-11-23.md，不修改任何数据文件
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const CACHE_DIR = path.join(ROOT, 'data', 'build', 'ranobedb-series');
const REPORT = path.join(ROOT, 'reports', 'ranobedb-validate-2026-11-23.md');
const BASE = 'https://ranobedb.org/api/v0';
const DELAY_MS = 1100;
const UA = 'yuc-light-novel-list/1.0';
const limitArg = process.argv.find((x) => x.startsWith('--limit='));
const LIMIT = limitArg ? Math.max(1, Number(limitArg.split('=')[1]) || 120) : 120;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const norm = (v) => String(v || '').normalize('NFKC').toLowerCase()
  .replace(/[\s"'“”‘’「」『』【】\[\]()（）:：\-–—~〜!?！？,，.。·、]/g, '');

async function searchSeries(title) {
  const key = createHash('sha1').update(title).digest('hex').slice(0, 16);
  const file = path.join(CACHE_DIR, `${key}.json`);
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch { /* 继续查询 */ }
  const url = `${BASE}/series?q=${encodeURIComponent(title)}`;
  let data = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(30000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      data = await res.json();
      break;
    } catch (err) {
      if (attempt === 3) throw err;
      await sleep(attempt * 2000);
    }
  }
  const series = Array.isArray(data?.series) ? data.series : [];
  await writeFile(file, JSON.stringify({ title, series }), 'utf8');
  await sleep(DELAY_MS);
  return { title, series };
}

function pickSeries(list, title) {
  const base = norm(title);
  if (!base) return null;
  // 只接受标题完全一致，避免把 AA / SP / 官方指南等外传当成主系列
  return list.find((s) => norm(s.title) === base) || null;
}

await mkdir(CACHE_DIR, { recursive: true });
await mkdir(path.dirname(REPORT), { recursive: true });
const raw = await readFile(path.join(ROOT, 'data', 'light-novels.js'), 'utf8');
const data = JSON.parse(raw.match(/window\.LN_DATA\s*=\s*(\[[\s\S]*\]);?/)[1]);
const targets = data
  .filter((x) => x.sv && Array.isArray(x.ch) && x.ch.length && /[\u3040-\u30ff]/.test(x.n || ''))
  .sort((a, b) => (b.h || 0) - (a.h || 0))
  .slice(0, LIMIT);

const rows = [];
let matched = 0;
let equal = 0;
let oursMore = 0;
let rnMore = 0;
for (let i = 0; i < targets.length; i += 1) {
  const item = targets[i];
  const { series } = await searchSeries(item.n);
  const hit = pickSeries(series, item.n);
  if (!hit) {
    rows.push({ item, hit: null });
    console.log(`进度 ${i + 1}/${targets.length}：${item.n} 未匹配`);
    continue;
  }
  matched += 1;
  const ours = item.ch.length;
  const rn = Number(hit.c_num_books) || 0;
  if (ours === rn) equal += 1;
  else if (ours > rn) oursMore += 1;
  else rnMore += 1;
  rows.push({ item, hit, ours, rn, diff: ours - rn });
  console.log(`进度 ${i + 1}/${targets.length}：${item.n} 我们 ${ours} / RanobeDB ${rn}`);
}

const gaps = rows.filter((r) => r.hit && r.diff !== 0).sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));
const lines = [
  '# RanobeDB 卷目对照报告（只读）',
  '',
  `生成时间：${new Date().toISOString()}`,
  '',
  `抽样：热度前 ${targets.length} 个系列；RanobeDB 匹配 ${matched} 个。`,
  '',
  '## 汇总',
  '',
  `- 卷数一致：${equal}`,
  `- 我们更多：${oursMore}`,
  `- RanobeDB 更多：${rnMore}`,
  `- 未匹配：${targets.length - matched}`,
  '',
  '## 差异最大的系列',
  '',
  '| 系列 | 我们 | RanobeDB | 差值 | RanobeDB 标题 |',
  '|---|---:|---:|---:|---|',
  ...gaps.slice(0, 40).map((r) => `| ${r.item.cn || r.item.n} | ${r.ours} | ${r.rn} | ${r.diff > 0 ? '+' : ''}${r.diff} | ${r.hit.title} |`),
  '',
  '## 说明',
  '',
  '- RanobeDB 的 `c_num_books` 可能只统计主卷，番外、短篇集不一定计入，差异不直接等于错误。',
  '- 我们这边的卷数来自 Bangumi 系列关联，已包含单行本与番外篇。',
  '- 本报告只用于人工抽查，不回写数据。',
];
await writeFile(REPORT, lines.join('\n'), 'utf8');
console.log(`完成：匹配 ${matched}，一致 ${equal}，我们更多 ${oursMore}，RanobeDB 更多 ${rnMore}`);
console.log(`报告：${REPORT}`);
