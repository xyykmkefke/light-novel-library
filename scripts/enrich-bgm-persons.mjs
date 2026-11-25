// 用 Bangumi `/v0/subjects/{id}/persons` 补缺失的插图 / 作者（以及出版社 / 书系）
// 用法：node scripts/enrich-bgm-persons.mjs [--limit=2000] [--delay=1000]
// 只读查询，结果按 ID 缓存在 data/build/bgm-persons/，可中断续跑；直接写回 data/light-novels-extra.js。
// 端点无鉴权、无分页，relation 为中文标签：插图 / 作者 / 出版社 / 书系。
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const EXTRA_FILE = path.join(ROOT, 'data', 'light-novels-extra.js');
const CORE_FILE = path.join(ROOT, 'data', 'light-novels.js');
const CACHE_DIR = path.join(ROOT, 'data', 'build', 'bgm-persons');
const BASE = 'https://bgmapi.anibt.net/v0/subjects';
const UA = 'yuc-light-novel-list/1.0';

const arg = (name, fallback) => {
  const hit = process.argv.find((x) => x.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : fallback;
};
const LIMIT = Math.max(1, Number(arg('limit', 2000)) || 2000);
const DELAY = Math.max(300, Number(arg('delay', 1000)) || 1000);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

async function fetchPersons(id) {
  const file = path.join(CACHE_DIR, `${id}.json`);
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch { /* 继续查询 */ }
  const url = `${BASE}/${id}/persons`;
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
  await writeFile(file, JSON.stringify(Array.isArray(data) ? data : []), 'utf8');
  await sleep(DELAY);
  return Array.isArray(data) ? data : [];
}

// 同一角色多个人名用「 / 」连接，与库里既有 au/il 的写法一致
function namesFor(persons, relation) {
  const seen = new Set();
  const names = [];
  for (const p of persons) {
    if (Number(p.type) === 2) continue; // 组织（出版社等）不进作者 / 插图
    if (String(p.relation || '').trim() !== relation) continue;
    const name = String(p.name || '').trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  return names.join(' / ');
}

await mkdir(CACHE_DIR, { recursive: true });
const raw = await readFile(EXTRA_FILE, 'utf8');
const match = raw.match(/window\.LN_EXTRA\s*=\s*(\{[\s\S]*\});?/);
if (!match) throw new Error('未找到 window.LN_EXTRA');
const extra = JSON.parse(match[1]);
const core = parseArray(await readFile(CORE_FILE, 'utf8'), 'LN_DATA');

const targets = core
  .filter((x) => {
    if (x.rn) return false; // 扩展书目另有专门的补全脚本
    const fields = extra[String(x.i)] || {};
    return !String(fields.il || '').trim() || !String(fields.au || '').trim();
  })
  .sort((a, b) => (b.h || 0) - (a.h || 0))
  .slice(0, LIMIT);

const header = '// 由 scripts/fetch-books.mjs / clean-series.mjs 生成，请勿手动修改\n';
async function flush() {
  await writeFile(EXTRA_FILE, header + `window.LN_EXTRA = ${JSON.stringify(extra)};\n`, 'utf8');
}

console.log(`待补条目：${targets.length}（缺插图或作者）`);
let ilFilled = 0;
let auFilled = 0;
let pubFilled = 0;
let lineFilled = 0;
let empty = 0;

for (let i = 0; i < targets.length; i += 1) {
  const x = targets[i];
  let persons = [];
  try {
    persons = await fetchPersons(x.i);
  } catch (err) {
    console.log(`进度 ${i + 1}/${targets.length}：${x.cn || x.n} 查询失败 ${err.message}`);
    continue;
  }
  if (!persons.length) {
    empty += 1;
    console.log(`进度 ${i + 1}/${targets.length}：${x.cn || x.n} 无人物数据`);
    continue;
  }
  const fields = extra[String(x.i)] || (extra[String(x.i)] = {});
  const il = namesFor(persons, '插图');
  const au = namesFor(persons, '作者');
  if (il && !String(fields.il || '').trim()) { fields.il = il; ilFilled += 1; }
  if (au && !String(fields.au || '').trim()) { fields.au = au; auFilled += 1; }
  if (!String(fields.pub || '').trim()) {
    const pub = persons.filter((p) => String(p.relation || '').trim() === '出版社')
      .map((p) => String(p.name || '').trim()).filter(Boolean)[0] || '';
    if (pub) { fields.pub = pub; pubFilled += 1; }
  }
  if (!String(fields.line || '').trim()) {
    const line = persons.filter((p) => String(p.relation || '').trim() === '书系')
      .map((p) => String(p.name || '').trim()).filter(Boolean)[0] || '';
    if (line) { fields.line = line; lineFilled += 1; }
  }
  console.log(`进度 ${i + 1}/${targets.length}：${x.cn || x.n} ${il ? '插图+' + il : ''} ${au ? '作者+' + au : ''}`.trim());
  if ((i + 1) % 25 === 0) await flush();
}

await flush();
console.log(`persons 完成：查询 ${targets.length} 条，空数据 ${empty}，补插图 ${ilFilled}、作者 ${auFilled}、出版社 ${pubFilled}、书系 ${lineFilled}`);
