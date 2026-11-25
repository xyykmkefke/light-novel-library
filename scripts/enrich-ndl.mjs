// 用国立国会図書館サーチ（NDL Search）OpenSearch 补 ISBN / 文库名 / 首发日 / 出版社
// 用法：node scripts/enrich-ndl.mjs [--limit=1000] [--proxy=http://127.0.0.1:7897] [--delay=1600]
// 只读查询，无 key；NDL 在中国大陆常需本机代理，默认走 127.0.0.1:7897，可用 --proxy= 清空。
// 结果直接写回 data/light-novels-extra.js（每 50 条冲刷），可中断续跑。
// 两种查询：
//   1) 只有日文原名、没有 ISBN 的条目：标题检索，必须精确同名才采纳；
//   2) 有 ISBN 但缺文库名：ISBN 反查，取 dcndl:seriesTitle。
import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import path from 'node:path';

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(import.meta.dirname, '..');
const EXTRA_FILE = path.join(ROOT, 'data', 'light-novels-extra.js');
const CORE_FILE = path.join(ROOT, 'data', 'light-novels.js');
const CACHE_DIR = path.join(ROOT, 'data', 'build', 'ndl');
const API = 'https://ndlsearch.ndl.go.jp/api/opensearch';
const UA = 'yuc-light-novel-list/1.0';

const arg = (name, fallback) => {
  const hit = process.argv.find((x) => x.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : fallback;
};
const LIMIT = Math.max(1, Number(arg('limit', 1000)) || 1000);
const PROXY = arg('proxy', 'http://127.0.0.1:7897');
const DELAY = Math.max(500, Number(arg('delay', 1600)) || 1600);

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

function decodeEntities(s) {
  return String(s || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, '&')
    .trim();
}

function norm(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s"'“”‘’「」『』【】\[\]()（）:：\-–—~〜!?！？,，.。·、;；]/g, '');
}

function isJpTitle(s) {
  return /[\u3040-\u30ff]/.test(String(s || ''));
}

async function cachedGet(key, url) {
  const file = path.join(CACHE_DIR, `${createHash('sha1').update(key).digest('hex').slice(0, 16)}.xml`);
  try {
    return await readFile(file, 'utf8');
  } catch { /* 继续请求 */ }
  let xml = '';
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const args = ['-sS', '--max-time', '30', '-A', UA];
      if (PROXY) args.push('-x', PROXY);
      args.push(url);
      const { stdout } = await execFileAsync('curl', args, { maxBuffer: 8 * 1024 * 1024 });
      xml = stdout;
      if (/Too Many Requests|同時アクセス/.test(xml)) throw new Error('rate limited');
      if (!/<rss|<feed|<html/.test(xml)) throw new Error('unexpected response');
      break;
    } catch (err) {
      if (attempt === 3) throw err;
      await sleep(attempt * 3000);
    }
  }
  await writeFile(file, xml, 'utf8');
  await sleep(DELAY);
  return xml;
}

function items(xml) {
  const out = [];
  const re = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = re.exec(xml))) {
    const block = m[1];
    const pick = (tag) => {
      const hit = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`));
      return hit ? decodeEntities(hit[1]) : '';
    };
    const ids = [...block.matchAll(/<dc:identifier[^>]*>([\s\S]*?)<\/dc:identifier>/g)]
      .map((x) => decodeEntities(x[1]));
    const isbn = ids.map((x) => x.replace(/[^0-9Xx]/g, '')).find((x) => /^97[89]\d{10}$/.test(x)) || '';
    out.push({
      title: pick('title') || pick('dc:title'),
      creator: pick('dc:creator'),
      publisher: pick('dc:publisher'),
      series: pick('dcndl:seriesTitle'),
      issued: pick('dcterms:issued') || pick('dc:date'),
      isbn,
    });
  }
  return out;
}

function dateFromNdl(s) {
  const t = String(s || '').trim();
  const m = t.match(/^(\d{4})(?:[.\-/年](\d{1,2}))?(?:[.\-/月](\d{1,2}))?/);
  if (!m) return '';
  const y = Number(m[1]);
  if (y < 1700 || y > 2100) return '';
  const mo = m[2] ? String(m[2]).padStart(2, '0') : '';
  const d = m[3] ? String(m[3]).padStart(2, '0') : '';
  return mo ? `${y}-${mo}${d ? '-' + d : ''}` : String(y);
}

function cleanSeries(s) {
  return String(s || '').split(/[;；]/)[0].trim();
}

await mkdir(CACHE_DIR, { recursive: true });
const extra = parseObject(await readFile(EXTRA_FILE, 'utf8'), 'LN_EXTRA');
const core = parseArray(await readFile(CORE_FILE, 'utf8'), 'LN_DATA');

const noIsbn = core.filter((x) => {
  if (x.rn || x.gn) return false;
  const f = extra[String(x.i)] || {};
  if (f.isbn || f.fisbn) return false;
  return isJpTitle(x.n);
});
const noLine = core.filter((x) => {
  if (x.rn || x.gn) return false;
  const f = extra[String(x.i)] || {};
  if (!/^\d{13}$/.test(String(f.isbn || ''))) return false;
  return !String(f.line || '').trim();
});

// 先补 ISBN（价值更高），再补文库名；两类合计按 LIMIT 截断
const targets = [
  ...noIsbn.map((x) => ({ x, mode: 'title' })),
  ...noLine.map((x) => ({ x, mode: 'isbn' })),
].slice(0, LIMIT);

const header = '// 由 scripts/fetch-books.mjs / clean-series.mjs 生成，请勿手动修改\n';
async function flush() {
  await writeFile(EXTRA_FILE, header + `window.LN_EXTRA = ${JSON.stringify(extra)};\n`, 'utf8');
}

console.log(`NDL 目标：缺 ISBN ${noIsbn.length} 条，缺文库 ${noLine.length} 条，本轮 ${targets.length} 条`);
const stats = { titleHit: 0, isbnFilled: 0, lineFilled: 0, pubFilled: 0, jdFilled: 0, miss: 0 };

for (let i = 0; i < targets.length; i += 1) {
  const { x, mode } = targets[i];
  const fields = extra[String(x.i)] || (extra[String(x.i)] = {});
  try {
    if (mode === 'title') {
      const xml = await cachedGet(`t:${x.n}`, `${API}?title=${encodeURIComponent(x.n)}&cnt=10`);
      const list = items(xml);
      const want = norm(x.n);
      const hit = list.find((it) => it.isbn && norm(it.title) === want) ||
        list.find((it) => it.isbn && want.length >= 6 && norm(it.title).startsWith(want));
      if (!hit) {
        stats.miss += 1;
      } else {
        stats.titleHit += 1;
        if (x.sv) fields.fisbn = hit.isbn;
        else fields.isbn = hit.isbn;
        stats.isbnFilled += 1;
        const line = cleanSeries(hit.series);
        if (line && !fields.line) { fields.line = line; stats.lineFilled += 1; }
        if (hit.publisher && !fields.pub) { fields.pub = hit.publisher; stats.pubFilled += 1; }
        const jd = dateFromNdl(hit.issued);
        if (jd && !fields.jd) { fields.jd = jd; stats.jdFilled += 1; }
      }
    } else {
      const xml = await cachedGet(`i:${fields.isbn}`, `${API}?isbn=${fields.isbn}&cnt=3`);
      const list = items(xml);
      const line = cleanSeries(list.map((it) => it.series).find(Boolean));
      if (line && !fields.line) {
        fields.line = line;
        stats.lineFilled += 1;
      } else if (!line) {
        stats.miss += 1;
      }
      const pub = list.map((it) => it.publisher).find(Boolean) || '';
      if (pub && !fields.pub) { fields.pub = pub; stats.pubFilled += 1; }
    }
  } catch (err) {
    console.log(`进度 ${i + 1}/${targets.length}：${x.cn || x.n} 失败 ${err.message}`);
    continue;
  }
  if ((i + 1) % 25 === 0) {
    await flush();
    console.log(`进度 ${i + 1}/${targets.length}：ISBN ${stats.isbnFilled} / 文库 ${stats.lineFilled} / 出版社 ${stats.pubFilled}`);
  }
}

await flush();
console.log(`NDL 完成：查询 ${targets.length} 条，标题命中 ${stats.titleHit}，补 ISBN ${stats.isbnFilled}、文库 ${stats.lineFilled}、出版社 ${stats.pubFilled}、首发日 ${stats.jdFilled}，未命中 ${stats.miss}`);
