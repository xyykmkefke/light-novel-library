// 审计重复系列与拆分卷：只读分析，输出 reports/edition-audit-2026-11-23.md
// 用法：node scripts/audit-editions.mjs
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const REPORT = path.join(ROOT, 'reports', 'edition-audit-2026-11-23.md');
const SPLIT_RE = /[（(]\s*(上|中|下|前編|後編|前篇|後篇|上巻|中巻|下巻)\s*[）)]|\s(上|中|下)$/;

const norm = (value) => String(value || '')
  .normalize('NFKC')
  .toLowerCase()
  .replace(/[（(]\s*(上|中|下|前編|後編|前篇|後篇)\s*[）)]/g, '')
  .replace(/[\s"'“”‘’「」『』【】\[\]()（）:：\-–—~〜!?！？,，.。·、]/g, '');

const raw = await readFile(path.join(ROOT, 'data', 'light-novels.js'), 'utf8');
const core = JSON.parse(raw.match(/window\.LN_DATA\s*=\s*(\[[\s\S]*\]);?/)[1]);
const rawVolumes = await readFile(path.join(ROOT, 'data', 'light-novels-volumes.js'), 'utf8');
const volumes = JSON.parse(rawVolumes.match(/window\.LN_VOLUMES\s*=\s*(\[[\s\S]*\]);?/)[1]);
const all = new Map([...core, ...volumes].map((x) => [String(x.i), x]));

const groups = new Map();
for (const item of core.filter((x) => x.sv)) {
  const key = norm(item.n) || norm(item.cn);
  if (!key) continue;
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(item);
}
const duplicates = [...groups.values()].filter((list) => list.length > 1)
  .map((list) => ({
    title: list[0].cn || list[0].n,
    list: list.sort((a, b) => (b.ch || []).length - (a.ch || []).length || (b.h || 0) - (a.h || 0)),
  }))
  .sort((a, b) => b.list.length - a.list.length);

const splits = [];
for (const parent of core.filter((x) => x.sv && Array.isArray(x.ch))) {
  const books = parent.ch.map((id) => all.get(String(id))).filter(Boolean);
  const split = books.filter((b) => SPLIT_RE.test(b.cn || b.n));
  if (split.length < 2) continue;
  const bases = new Map();
  split.forEach((b) => {
    const base = String(b.cn || b.n).replace(SPLIT_RE, '').replace(/\s+/g, ' ').trim();
    if (!bases.has(base)) bases.set(base, []);
    bases.get(base).push(b);
  });
  splits.push({
    parent,
    total: books.length,
    split: split.length,
    groups: [...bases.entries()].filter(([, list]) => list.length >= 2),
  });
}
splits.sort((a, b) => b.split - a.split);

const lines = [
  '# 重复系列与拆分卷审计',
  '',
  `生成时间：${new Date().toISOString()}`,
  '',
  '## 汇总',
  '',
  `- 重复系列组：**${duplicates.length}** 组，涉及 **${duplicates.reduce((n, g) => n + g.list.length, 0)}** 个系列条目`,
  `- 含上/中/下拆分卷的系列：**${splits.length}** 个`,
  `- 核心 ${core.length} 条，卷包 ${volumes.length} 条`,
  '',
  '## 重复系列（按条目数）',
  '',
  '| 系列 | 条目数 | ID / 卷数 / 收藏 |',
  '|---|---:|---|',
  ...duplicates.slice(0, 30).map((g) => `| ${g.title} | ${g.list.length} | ${g.list.map((x) => `${x.i} (${(x.ch || []).length}卷, ${x.h || 0})`).join('；')} |`),
  '',
  '## 拆分卷最多的系列',
  '',
  '| 系列 | 总卷 | 拆分卷 | 重复组 |',
  '|---|---:|---:|---:|',
  ...splits.slice(0, 20).map((s) => `| ${s.parent.cn || s.parent.n} | ${s.total} | ${s.split} | ${s.groups.length} |`),
  '',
  '## 典型案例',
  '',
  '### 仰望半月的夜空',
  '',
  '- 2265：8 卷，日文主版本；149327：2 卷，另一版本（`半分の月がのぼる空 (1)(2)`）。',
  '- 两个系列条目同名，导致卷数统计和 RanobeDB 对照出现 8 / 2 / 4 三种口径。',
  '',
  '### 转生史莱姆',
  '',
  '- 本地 31 卷是通常单行本；RanobeDB 的 46 条是上/中/下拆分版本，不是 15 本漏卷。',
  '',
  '## 建议',
  '',
  '1. 重复系列不要直接删除：保留卷数最多、收藏最高的为主条目，其余标记为版本并默认隐藏。',
  '2. 拆分卷（上/中/下）是实体书形态，不应合并；统计口径应区分「故事卷」与「册」。',
  '3. RanobeDB 对照时按主条目匹配，避免同名版本互相覆盖。',
  '4. 本次只读审计，未修改数据。',
];
await mkdir(path.dirname(REPORT), { recursive: true });
await writeFile(REPORT, lines.join('\n'), 'utf8');
console.log(`重复系列：${duplicates.length} 组 / ${duplicates.reduce((n, g) => n + g.list.length, 0)} 条`);
console.log(`拆分卷系列：${splits.length} 个`);
console.log(`报告：${REPORT}`);
