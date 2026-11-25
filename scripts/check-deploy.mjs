// 部署边界校验：只允许运行时文件进入 Pages，构建输入与开发文件必须排除
// 只读检查，供 CI 与本地 npm run check-deploy 使用
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const FULL_CORE = 'data/light-novels.js';

// 必须出现在 _config.yml exclude 中的非运行时路径
const DEPLOY_EXCLUDES = [
  'node_modules',
  'scripts',
  'reports',
  'screenshots',
  'data/build',
  FULL_CORE,
  'data/bgm-detail-fills.json',
  'data/manual-relations.json',
  'data/ranobedb-cn.json',
  'data/ranobedb-cn-blocklist.json',
  'data/ranobedb-volume-fixes.json',
  'data/ranobedb-counts.json',
  '.github',
  '.automation',
  'package.json',
  'package-lock.json',
  'README.md',
  'HANDOVER.md',
  'LICENSE',
];

// 站点运行必需的文件；任何一个被 exclude 都视为错误
const RUNTIME_FILES = [
  'index.html',
  'manifest.webmanifest',
  'sw.js',
  'icon.svg',
  'icons/icon-180.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'data/light-novels-lite.js',
  'data/light-novels-rest.js',
  'data/light-novels-extra.js',
  'data/light-novels-ch.js',
  'data/light-novels-volumes.js',
  'data/light-novels-rn.js',
];

const problems = [];
const read = (file) => readFile(path.join(ROOT, file), 'utf8');

function parseExcludes(config) {
  const block = config.split(/^exclude:\s*$/m)[1] || '';
  const set = new Set();
  for (const line of block.split('\n')) {
    if (!line.trim()) continue;
    const item = line.match(/^\s+-\s*(.+?)\s*$/);
    if (item) {
      set.add(item[1].replace(/^['"]|['"]$/g, '').trim());
    } else if (!line.startsWith(' ')) {
      break;
    }
  }
  return set;
}

const excludes = parseExcludes(await read('_config.yml').catch(() => ''));
for (const entry of DEPLOY_EXCLUDES) {
  if (!excludes.has(entry)) problems.push(`_config.yml 未排除 ${entry}`);
}

const isExcluded = (file) => [...excludes].some((entry) => {
  const clean = entry.replace(/\/+$/, '');
  return file === clean || file.startsWith(`${clean}/`);
});

for (const file of RUNTIME_FILES) {
  try {
    await access(path.join(ROOT, file));
  } catch {
    problems.push(`缺少运行时文件 ${file}`);
  }
  if (isExcluded(file)) problems.push(`运行时文件被误排除：${file}`);
}

const index = await read('index.html');
const sw = await read('sw.js');
const runtimeRefs = new Set(
  [...`${index}\n${sw}`.matchAll(/data\/light-novels-[a-z]+\.js/g)].map((m) => m[0]),
);

if (`${index}\n${sw}`.includes(FULL_CORE)) {
  problems.push(`${FULL_CORE} 不应被页面或 SW 引用`);
}

for (const file of runtimeRefs) {
  try {
    await access(path.join(ROOT, file));
  } catch {
    problems.push(`页面/SW 引用了不存在的 ${file}`);
  }
  if (isExcluded(file)) problems.push(`页面/SW 引用的文件被排除：${file}`);
}

if (problems.length) {
  console.error('部署边界校验失败：');
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}

console.log(`部署边界校验通过：${excludes.size} 项排除，${RUNTIME_FILES.length} 个运行时文件，${runtimeRefs.size} 个运行时数据包`);
