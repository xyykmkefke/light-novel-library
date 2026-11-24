// 部署边界校验：构建用完整核心不得进入 Pages，运行时数据文件必须齐全
// 只读检查，供 CI 与本地 npm run check-deploy 使用
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const FULL_CORE = 'data/light-novels.js';
const RUNTIME_FILES = [
  'data/light-novels-lite.js',
  'data/light-novels-rest.js',
  'data/light-novels-extra.js',
  'data/light-novels-volumes.js',
  'data/light-novels-rn.js',
];

const problems = [];
const read = (file) => readFile(path.join(ROOT, file), 'utf8');

const config = await read('_config.yml').catch(() => '');
if (!new RegExp(`^\\s*-\\s*${FULL_CORE.replace('.', '\\.')}\\s*$`, 'm').test(config)) {
  problems.push(`_config.yml 未排除 ${FULL_CORE}`);
}

const index = await read('index.html');
const sw = await read('sw.js');
const runtimeRefs = new Set(
  [...`${index}\n${sw}`.matchAll(/data\/light-novels-[a-z]+\.js/g)].map((m) => m[0]),
);

if (`${index}\n${sw}`.includes(FULL_CORE)) {
  problems.push(`${FULL_CORE} 不应被页面或 SW 引用`);
}

for (const file of RUNTIME_FILES) {
  try {
    await access(path.join(ROOT, file));
  } catch {
    problems.push(`缺少运行时数据文件 ${file}`);
  }
}

for (const file of runtimeRefs) {
  try {
    await access(path.join(ROOT, file));
  } catch {
    problems.push(`页面/SW 引用了不存在的 ${file}`);
  }
}

if (problems.length) {
  console.error('部署边界校验失败：');
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}

console.log(`部署边界校验通过：${runtimeRefs.size} 个运行时数据文件，${FULL_CORE} 已排除`);
