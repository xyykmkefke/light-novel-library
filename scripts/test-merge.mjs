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
  const map = { 1: { s: 'doing', t: 100, vol: 2, u: 300, f: 0 } };
  const remote = {
    items: [{ id: 1, status: 'doing', addedAt: 100, vol: 2, updatedAt: 300 }],
  };
  assert(mergeRemoteState(map, {}, remote, totalOf) === 0, '首次不应变化');
  assert(mergeRemoteState(map, {}, remote, totalOf) === 0, '重复合并不应变化');
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
