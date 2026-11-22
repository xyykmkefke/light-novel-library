// 为轻小说数据补充拼音首字母字段 py，便于按首字母搜索。
// 用法：node scripts/build-pinyin.mjs
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { pinyin } from 'pinyin-pro';

const ROOT = path.resolve(import.meta.dirname, '..');
const FULL_FILE = path.join(ROOT, 'data', 'light-novels.js');

const KANA = {
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
};

// 纯日文标题没有汉字，pinyin-pro 无法处理；退回假名罗马字首字母
export function kanaInitials(text) {
  let out = '';
  for (const ch of String(text || '')) {
    const code = ch.charCodeAt(0);
    const hira = code >= 0x30a1 && code <= 0x30f6 ? String.fromCharCode(code - 0x60) : ch;
    const roma = KANA[hira];
    if (roma) out += roma[0];
  }
  return out.toLowerCase();
}

export function initials(text) {
  if (!text) return '';
  const py = pinyin(String(text), { pattern: 'first', toneType: 'none', type: 'array' })
    .join('')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
  return py || kanaInitials(text);
}

export async function addPinyin() {
  const src = await readFile(FULL_FILE, 'utf8');
  const metaMatch = src.match(/window\.LN_META\s*=\s*(\{[\s\S]*?\});/);
  const open = src.indexOf('[', src.indexOf('window.LN_DATA'));
  const close = src.lastIndexOf(']');
  if (!metaMatch || open < 0 || close < 0) throw new Error('无法解析 data/light-novels.js');
  const meta = JSON.parse(metaMatch[1]);
  const all = JSON.parse(src.slice(open, close + 1));
  let changed = 0;
  all.forEach((x) => {
    const py = initials(x.cn || x.n);
    if (x.py !== py) {
      x.py = py;
      changed += 1;
    }
  });
  meta.generatedAt = new Date().toISOString();
  const content = '// 由 scripts/fetch-books.mjs 生成，请勿手动修改\n' +
    `window.LN_META = ${JSON.stringify(meta)};\n` +
    `window.LN_DATA = ${JSON.stringify(all)};\n`;
  await writeFile(FULL_FILE, content, 'utf8');
  return { total: all.length, changed };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await addPinyin();
  console.log(`已补充拼音：${result.total} 部（更新 ${result.changed}）`);
}
