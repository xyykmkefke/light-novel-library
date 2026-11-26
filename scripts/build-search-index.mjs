// 生成多语言搜索索引：
//   1) 把 py（拼音首字母）扩成「首字母|全拼」，支持 mfszy 与 mofashizhiye 两种输入
//   2) 为假名标题补罗马字全拼（rpy），覆盖 405 条无汉字的日文标题
//   3) 从 extra 包抽出作者/插图，生成独立的 light-novels-au.js 小包（搜索框聚焦时预取）
// 用法：node scripts/build-search-index.mjs
// 幂等：可重复运行，会就地更新 data/light-novels.js 与 -lite.js 的 py 字段。
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { pinyin } from 'pinyin-pro';
import { kanaInitials } from './build-pinyin.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const FULL_FILE = path.join(ROOT, 'data', 'light-novels.js');

// 假名 → 罗马字（与 build-pinyin.mjs 的 KANA 表同源，但这里要保留完整音节而非首字母）
const KANA_ROMA = {
  あ: 'a', い: 'i', う: 'u', え: 'e', お: 'o',
  か: 'ka', き: 'ki', く: 'ku', け: 'ke', こ: 'ko',
  さ: 'sa', し: 'shi', す: 'su', せ: 'se', そ: 'so',
  た: 'ta', ち: 'chi', つ: 'tsu', て: 'te', と: 'to',
  な: 'na', に: 'ni', ぬ: 'nu', ね: 'ne', の: 'no',
  は: 'ha', ひ: 'hi', ふ: 'fu', へ: 'he', ほ: 'ho',
  ま: 'ma', み: 'mi', む: 'mu', め: 'me', も: 'mo',
  や: 'ya', ゆ: 'yu', よ: 'yo',
  ら: 'ra', り: 'ri', る: 'ru', れ: 're', ろ: 'ro',
  わ: 'wa', を: 'wo', ん: 'n',
  が: 'ga', ぎ: 'gi', ぐ: 'gu', げ: 'ge', ご: 'go',
  ざ: 'za', じ: 'ji', ず: 'zu', ぜ: 'ze', ぞ: 'zo',
  だ: 'da', ぢ: 'ji', づ: 'zu', で: 'de', ど: 'do',
  ば: 'ba', び: 'bi', ぶ: 'bu', べ: 'be', ぼ: 'bo',
  ぱ: 'pa', ぴ: 'pi', ぷ: 'pu', ぺ: 'pe', ぽ: 'po',
  ぁ: 'a', ぃ: 'i', ぅ: 'u', ぇ: 'e', ぉ: 'o',
  ゃ: 'ya', ゅ: 'yu', ょ: 'yo', ゔ: 'vu', ゐ: 'i', ゑ: 'e',
  // 长音符与促音：日语读音里通常省略或双写辅音，这里统一按省略处理，
  // 让「ラーメン」也能被 ramen 命中
  'ー': '', 'っ': '', 'ッ': '',
};

// 片假名 → 平假名（位移 0x60）
function toHiragana(ch) {
  const code = ch.charCodeAt(0);
  if (code >= 0x30a1 && code <= 0x30f6) return String.fromCharCode(code - 0x60);
  return ch;
}

// 促音（っ/ッ）后面接的假名，罗马字要双写首辅音：
// プラスチック → purasuchikku（而不是 purasuchiku）。同音省略会让「chikku」搜不到。
function isSokuon(ch) {
  const h = toHiragana(ch);
  return h === 'っ';
}

// 把一段日文标题转成罗马字全拼（只处理假名，汉字原样丢弃）
export function kanaRomaji(text) {
  const chars = Array.from(String(text || ''));
  let out = '';
  for (let i = 0; i < chars.length; i += 1) {
    const ch = chars[i];
    if (isSokuon(ch)) {
      // 找下一个假名的罗马字，双写其首字母；`ち` 开头是 ch，双写 c 才符合 chikku
      for (let j = i + 1; j < chars.length; j += 1) {
        const next = KANA_ROMA[toHiragana(chars[j])];
        if (next) { out += next[0]; break; }
        if (chars[j].trim()) break;
      }
      continue;
    }
    const roma = KANA_ROMA[toHiragana(ch)];
    if (roma != null) out += roma;
  }
  return out.replace(/[^a-z0-9]/g, '').toLowerCase();
}

// 判断标题里是否有假名（有才值得生成罗马字）
function hasKana(text) {
  return /[\u3041-\u309f\u30a1-\u30f6]/.test(String(text || ''));
}

// 全拼：只对含汉字的文本生成；纯假名/纯英文没有中文读音，返回空串
export function fullPinyin(text) {
  const s = String(text || '');
  if (!/[\u4e00-\u9fff]/.test(s)) return '';
  return pinyin(s, { toneType: 'none', type: 'array' })
    .join('')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

// 一条记录的搜索索引：py 存「首字母|全拼」，rpy 存假名罗马字
function buildIndex(x) {
  const base = x.cn || x.n || '';
  const initial = x.py && !/[|]/.test(x.py) ? x.py : (kanaInitials(base) || '');
  const full = fullPinyin(base);
  const parts = [];
  if (initial) parts.push(initial);
  if (full && full !== initial) parts.push(full);
  const py = parts.join('|');
  const rpy = hasKana(x.n) ? kanaRomaji(x.n) : '';
  return { py, rpy };
}

function parseDataFile(src) {
  const metaMatch = src.match(/window\.LN_META\s*=\s*(\{[\s\S]*?\});\n/);
  const open = src.indexOf('[', src.indexOf('window.LN_DATA'));
  const close = src.lastIndexOf(']');
  if (!metaMatch || open < 0 || close < 0) throw new Error('无法解析数据文件');
  return {
    meta: JSON.parse(metaMatch[1]),
    all: JSON.parse(src.slice(open, close + 1)),
    head: src.slice(0, src.indexOf('window.LN_DATA')),
  };
}

export async function buildSearchIndex() {
  const src = await readFile(FULL_FILE, 'utf8');
  const { meta, all } = parseDataFile(src);

  let pyChanged = 0;
  let rpyAdded = 0;
  all.forEach((x) => {
    const { py, rpy } = buildIndex(x);
    if (py && py !== x.py) {
      x.py = py;
      pyChanged += 1;
    }
    if (rpy && x.rpy !== rpy) {
      x.rpy = rpy;
      rpyAdded += 1;
    }
  });

  // 主数据文件（构建输入，保留完整字段）
  const header = '// 由 scripts/fetch-books.mjs / clean-series.mjs 生成，请勿手动修改\n';
  await writeFile(FULL_FILE, header +
    `window.LN_META = ${JSON.stringify({ ...meta, generatedAt: new Date().toISOString() })};\n` +
    `window.LN_DATA = ${JSON.stringify(all)};\n`, 'utf8');

  return { total: all.length, pyChanged, rpyAdded };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const r = await buildSearchIndex();
  console.log(`搜索索引已更新：${r.total} 条；拼音改写 ${r.pyChanged} 条；罗马字新增 ${r.rpyAdded} 条`);
}
