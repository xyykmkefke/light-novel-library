// 从完整核心重新拆出运行时包（lite / rest / ch），并生成两个独立搜索索引包：
//   - light-novels-pyf.js：全拼索引（id → 全拼），让 mofashizhiye 能命中「魔法使之夜」
//   - light-novels-rpy.js：罗马字索引（id → 罗马字），让 mahou 能命中日文标题
//   - light-novels-au.js ：作者/插图索引（id → [作者, 插图]），搜索框聚焦时预取
// 三个索引包不进 lite：lite 只保留「首字母」这一个轻量索引，保持首屏体积不变。
// 用法：node scripts/split-shards.mjs
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const DATA = path.join(ROOT, 'data');
const HEADER = '// 由 scripts/fetch-books.mjs / clean-series.mjs 生成，请勿手动修改\n';

const src = await readFile(path.join(DATA, 'light-novels.js'), 'utf8');
const meta = JSON.parse(src.match(/window\.LN_META\s*=\s*(\{[\s\S]*?\});\n/)[1]);
const open = src.indexOf('[', src.indexOf('window.LN_DATA'));
const all = JSON.parse(src.slice(open, src.lastIndexOf(']') + 1));

// ch 索引单独成包，首屏核心不携带
const chPack = {};
all.forEach((x) => {
  if (x.sv && Array.isArray(x.ch) && x.ch.length) chPack[String(x.i)] = x.ch;
});

// py 拆成「首字母」与「全拼」：首字母留在核心包（体积小、命中率高），
// 全拼与罗马字挪到独立索引包，避免首屏为搜「全拼」多付 50KB。
const pyFull = {};
const pyRoman = {};
const core = all.map((x) => {
  const { ch, py, rpy, ...rest } = x;
  const parts = String(py || '').split('|');
  const initial = parts[0] || '';
  const full = parts[1] || '';
  if (full) pyFull[String(x.i)] = full;
  if (rpy) pyRoman[String(x.i)] = rpy;
  return initial ? { ...rest, py: initial } : rest;
});

const stripCh = (x) => x;
const lite = core.filter((x) => !x.c && !x.gn && !x.ver);
const rest = core.filter((x) => x.c || x.gn || x.ver);

await writeFile(path.join(DATA, 'light-novels-lite.js'), HEADER +
  `window.LN_META = ${JSON.stringify(meta)};\n` +
  `window.LN_DATA = ${JSON.stringify(lite)};\n`, 'utf8');
await writeFile(path.join(DATA, 'light-novels-rest.js'), HEADER +
  `window.LN_REST = ${JSON.stringify(rest)};\n`, 'utf8');
await writeFile(path.join(DATA, 'light-novels-ch.js'), HEADER +
  `window.LN_CH = ${JSON.stringify(chPack)};\n`, 'utf8');
await writeFile(path.join(DATA, 'light-novels-pyf.js'), HEADER +
  `window.LN_PYF = ${JSON.stringify(pyFull)};\n`, 'utf8');
await writeFile(path.join(DATA, 'light-novels-rpy.js'), HEADER +
  `window.LN_RPY = ${JSON.stringify(pyRoman)};\n`, 'utf8');

// 作者索引小包：只放「条目 id → [作者, 插图]」。
// 与 extra 包（648KB，含 ISBN/书系/出版社等详情）分开，是因为作者是搜索维度里最高频的一项，
// 不该为了搜作者而下载整个详情包。
const extraRaw = await readFile(path.join(DATA, 'light-novels-extra.js'), 'utf8').catch(() => '');
const extraMatch = extraRaw.match(/window\.LN_EXTRA\s*=\s*(\{[\s\S]*\});?/);
const extra = extraMatch ? JSON.parse(extraMatch[1]) : {};
const auPack = {};
all.forEach((x) => {
  const e = extra[String(x.i)] || {};
  const au = String(e.au || '').trim();
  const il = String(e.il || '').trim();
  if (!au && !il) return;
  auPack[String(x.i)] = il ? [au, il] : [au];
});
await writeFile(path.join(DATA, 'light-novels-au.js'), HEADER +
  `window.LN_AU = ${JSON.stringify(auPack)};\n`, 'utf8');

console.log('拆分完成：' +
  `lite ${lite.length} / rest ${rest.length} / ch ${Object.keys(chPack).length} 系列 / ` +
  `全拼 ${Object.keys(pyFull).length} / 罗马字 ${Object.keys(pyRoman).length} / 作者 ${Object.keys(auPack).length}`);
