// 同步合并逻辑单元测试：直接从 index.html 抽取 mergeRemoteState，保证测的是线上代码
// 用法：node scripts/test-merge.mjs
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const html = await readFile(path.join(ROOT, 'index.html'), 'utf8');
const start = html.indexOf('// #merge-core-start');
const end = html.indexOf('// #merge-core-end');
if (start < 0 || end < 0) {
  console.error('未在 index.html 找到合并逻辑标记');
  process.exit(1);
}
const source = html.slice(start, end);
const STATUS = { want: '想读', doing: '在读', done: '读完', drop: '弃读' };
const mergeRemoteState = new Function(
  'STATUS',
  `${source}\nreturn mergeRemoteState;`,
)(STATUS);

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`PASS  ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`FAIL  ${name}  → ${err.message}`);
  }
}
function assert(ok, message) {
  if (!ok) throw new Error(message);
}
const totalOf = (id) => ({ 1: 10, 2: 0, 3: 5 })[id] || 0;

test('远端新条目会加入本地', () => {
  const map = {};
  const deleted = {};
  const n = mergeRemoteState(map, deleted, {
    items: [{ id: 1, status: 'doing', addedAt: 100, vol: 2, updatedAt: 100 }],
  }, totalOf);
  assert(n === 1, `changed=${n}`);
  assert(map['1'].s === 'doing' && map['1'].vol === 2, '条目内容不符');
});

test('同一条目按更新时间取新状态', () => {
  const map = { 1: { s: 'want', t: 100, vol: 1, u: 200, f: 0 } };
  mergeRemoteState(map, {}, {
    items: [{ id: 1, status: 'doing', addedAt: 100, vol: 1, updatedAt: 300 }],
  }, totalOf);
  assert(map['1'].s === 'doing', `状态=${map['1'].s}`);
});

test('本地更新时间更晚时保留本地状态', () => {
  const map = { 1: { s: 'drop', t: 100, vol: 1, u: 400, f: 0 } };
  mergeRemoteState(map, {}, {
    items: [{ id: 1, status: 'doing', addedAt: 100, vol: 3, updatedAt: 300 }],
  }, totalOf);
  assert(map['1'].s === 'drop', `状态=${map['1'].s}`);
  assert(map['1'].vol === 3, `进度=${map['1'].vol}`);
});

test('阅读进度取两者较大值', () => {
  const map = { 1: { s: 'doing', t: 100, vol: 6, u: 400, f: 0 } };
  mergeRemoteState(map, {}, {
    items: [{ id: 1, status: 'doing', addedAt: 100, vol: 3, updatedAt: 300 }],
  }, totalOf);
  assert(map['1'].vol === 6, `进度=${map['1'].vol}`);
});

test('进度达到总卷数自动标记读完', () => {
  const map = { 3: { s: 'doing', t: 100, vol: 4, u: 200, f: 0 } };
  mergeRemoteState(map, {}, {
    items: [{ id: 3, status: 'doing', addedAt: 100, vol: 5, updatedAt: 300 }],
  }, totalOf);
  assert(map['3'].s === 'done', `状态=${map['3'].s}`);
});

test('墓碑阻止已删除条目复活', () => {
  const map = {};
  const deleted = { 1: 500 };
  const n = mergeRemoteState(map, deleted, {
    items: [{ id: 1, status: 'doing', addedAt: 100, vol: 1, updatedAt: 400 }],
  }, totalOf);
  assert(n === 0, `changed=${n}`);
  assert(!map['1'], '条目不应存在');
});

test('删除之后的远端更新会覆盖墓碑', () => {
  const map = {};
  const deleted = { 1: 500 };
  mergeRemoteState(map, deleted, {
    items: [{ id: 1, status: 'doing', addedAt: 100, vol: 1, updatedAt: 600 }],
  }, totalOf);
  assert(!!map['1'], '条目应恢复');
  assert(!deleted['1'], '墓碑应被清除');
});

test('远端墓碑删除本地旧条目', () => {
  const map = { 2: { s: 'done', t: 100, vol: 1, u: 200, f: 200 } };
  const deleted = {};
  const n = mergeRemoteState(map, deleted, { items: [], deleted: { 2: 300 } }, totalOf);
  assert(n === 1, `changed=${n}`);
  assert(!map['2'], '条目应删除');
  assert(deleted['2'] === 300, `墓碑=${deleted['2']}`);
});

test('本地在删除后更新过则不被远端墓碑删除', () => {
  const map = { 2: { s: 'doing', t: 100, vol: 1, u: 400, f: 0 } };
  const deleted = { 2: 300 };
  mergeRemoteState(map, deleted, { items: [], deleted: { 2: 300 } }, totalOf);
  assert(!!map['2'], '本地条目应保留');
});

test('非法或缺失 ID 被忽略', () => {
  const map = {};
  const n = mergeRemoteState(map, {}, {
    items: [{ id: 'abc', status: 'done' }, { status: 'done' }, null, { id: -1 }],
  }, totalOf);
  assert(n === 0, `changed=${n}`);
  assert(Object.keys(map).length === 0, '不应写入任何条目');
});

test('兼容旧版 ep 字段作为进度', () => {
  const map = {};
  mergeRemoteState(map, {}, {
    items: [{ id: 2, status: 'doing', addedAt: 100, ep: 4, updatedAt: 100 }],
  }, totalOf);
  assert(map['2'].vol === 4, `进度=${map['2'].vol}`);
});

test('重复合并相同数据不产生变化', () => {
  const map = { 1: { s: 'doing', t: 100, vol: 2, u: 300, f: 0, r: 8, rv: '不错', nt: '记一笔', rvU: 300 } };
  const remote = {
    items: [{ id: 1, status: 'doing', addedAt: 100, vol: 2, updatedAt: 300, rating: 8, review: '不错', note: '记一笔', reviewUpdatedAt: 300 }],
  };
  assert(mergeRemoteState(map, {}, remote, totalOf) === 0, '首次不应变化');
  assert(mergeRemoteState(map, {}, remote, totalOf) === 0, '重复合并不应变化');
});

test('远端书评随较新记录合并', () => {
  const map = { 1: { s: 'done', t: 100, vol: 1, u: 200, f: 0, r: 6, rv: '还行', nt: '', rvU: 200 } };
  mergeRemoteState(map, {}, {
    items: [{
      id: 1, status: 'done', addedAt: 100, vol: 1, updatedAt: 300,
      rating: 9, review: '非常好', note: '第二卷期待', reviewUpdatedAt: 300,
    }],
  }, totalOf);
  assert(map['1'].r === 9, `评分=${map['1'].r}`);
  assert(map['1'].rv === '非常好', `短评=${map['1'].rv}`);
  assert(map['1'].nt === '第二卷期待', `笔记=${map['1'].nt}`);
});

test('旧客户端只更新状态不会清空书评', () => {
  const map = { 1: { s: 'done', t: 100, vol: 1, u: 200, f: 0, r: 9, rv: '神作', nt: '写了很久', rvU: 500 } };
  mergeRemoteState(map, {}, {
    items: [{ id: 1, status: 'doing', addedAt: 100, vol: 1, updatedAt: 800 }],
  }, totalOf);
  assert(map['1'].rv === '神作', `短评=${map['1'].rv}`);
  assert(map['1'].nt === '写了很久', `笔记=${map['1'].nt}`);
  assert(map['1'].r === 9, `评分=${map['1'].r}`);
  assert(map['1'].s === 'doing', `状态=${map['1'].s}`);
});

test('明确清空书评会同步到另一端', () => {
  const map = { 1: { s: 'done', t: 100, vol: 1, u: 200, f: 0, r: 7, rv: '旧短评', nt: '', rvU: 200 } };
  mergeRemoteState(map, {}, {
    items: [{
      id: 1, status: 'done', addedAt: 100, vol: 1, updatedAt: 900,
      rating: 0, review: '', note: '', reviewUpdatedAt: 900,
    }],
  }, totalOf);
  assert(map['1'].rv === '', `短评=${map['1'].rv}`);
  assert(map['1'].r === 0, `评分=${map['1'].r}`);
});

test('评分越界会被限制', () => {
  const map = {};
  mergeRemoteState(map, {}, {
    items: [
      { id: 1, status: 'done', addedAt: 100, vol: 0, updatedAt: 100, rating: 99 },
      { id: 3, status: 'done', addedAt: 100, vol: 0, updatedAt: 100, rating: -5 },
    ],
  }, totalOf);
  assert(map['1'].r === 10, `上界=${map['1'].r}`);
  assert(map['3'].r === 0, `下界=${map['3'].r}`);
});

test('过长书评会被截断', () => {
  const map = {};
  mergeRemoteState(map, {}, {
    items: [{ id: 1, status: 'done', addedAt: 100, vol: 0, updatedAt: 100, review: 'a'.repeat(200), note: 'b'.repeat(1200) }],
  }, totalOf);
  assert(map['1'].rv.length === 140, `短评长度=${map['1'].rv.length}`);
  assert(map['1'].nt.length === 1000, `笔记长度=${map['1'].nt.length}`);
});

test('无书评时间戳的旧数据仍能合并', () => {
  const map = { 1: { s: 'want', t: 100, vol: 0, u: 200, f: 0, r: 0, rv: '', nt: '', rvU: 0 } };
  mergeRemoteState(map, {}, {
    items: [{ id: 1, status: 'done', addedAt: 100, vol: 0, updatedAt: 300, rating: 8, review: '旧版书评' }],
  }, totalOf);
  assert(map['1'].s === 'done', `状态=${map['1'].s}`);
  assert(map['1'].rv === '旧版书评', `短评=${map['1'].rv}`);
});

test('书评字段缺失时保持空字符串', () => {
  const map = {};
  mergeRemoteState(map, {}, {
    items: [{ id: 1, status: 'done', addedAt: 100, vol: 0, updatedAt: 100 }],
  }, totalOf);
  assert(map['1'].rv === '' && map['1'].nt === '' && map['1'].r === 0, '默认值不符');
});

test('未知状态回退为读完', () => {
  const map = {};
  mergeRemoteState(map, {}, {
    items: [{ id: 1, status: 'unknown', addedAt: 100, vol: 0, updatedAt: 100 }],
  }, totalOf);
  assert(map['1'].s === 'done', `状态=${map['1'].s}`);
});

console.log(`\n${passed}/${passed + failed} 通过`);
process.exit(failed ? 1 : 0);
