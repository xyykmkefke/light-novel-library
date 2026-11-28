// 用 GitHub Git Data API 推送，绕过 git 到 github.com:443 的直连问题。
//
// 起因（2026-11-28 v1.24.10）：`git push` 连续三次报
//   Failed to connect to github.com:443 after 21xxx ms: Could not connect to server
// 而 `gh api` 同一时刻正常。说明 git 的 HTTP 通道被卡住，gh 走的另一条路。
//
// 关键约束：取文件内容必须用 `git cat-file blob HEAD:<path>`，不能用 readFileSync。
// autocrlf 下工作区是 CRLF、仓库里是 LF，直接读磁盘会得到 CRLF 内容，
// 提交上去 git 再算一次 tree 校验必然失败（三站都踩过）。
//
// 用法：node scripts/gh-push.mjs [branch]

import { execFileSync } from 'node:child_process';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const BRANCH = process.argv[2] || 'main';

function git(args, opts = {}) {
  // 只在调用方没指定 encoding 时补 utf8；要二进制时调用方传 'buffer'
  // core.quotepath=false：中文文件名默认会被转成 "\344\270\255..." 的
  // 转义形式并加引号，cat-file blob HEAD:"..." 会找不到路径。
  const out = execFileSync('git', ['-c', 'core.quotepath=false', ...args], {
    cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, ...opts,
  });
  return Buffer.isBuffer(out) ? out : String(out).trim();
}
function gh(args, input) {
  // gh api 不带 --input 时不会读 stdin，body 会丢失（表现为
  // "Blob field content: missing_field" 的 422）。
  // 有 body 就必须显式加 --input -。
  const full = input === undefined ? args : [...args, '--input', '-'];
  return execFileSync('gh', full, {
    cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024,
    input: input === undefined ? undefined : JSON.stringify(input),
  }).trim();
}

// owner/repo 从远端 URL 解析
const remote = git(['remote', 'get-url', 'origin']);
const m = remote.match(/github\.com[:/]([^/]+)\/([^/.]+?)(?:\.git)?$/);
if (!m) { console.error('无法从 origin 解析 owner/repo：' + remote); process.exit(1); }
const [, OWNER, REPO] = m;

const headSha = git(['rev-parse', 'HEAD']);
const message = git(['log', '-1', '--pretty=%B']);

// 父提交：优先取**远端**当前 main 的 SHA，而不是本地 HEAD^。
//
// 原因：Git Data API 推送会重建 commit 对象，SHA 与本地不同（tree 相同
// 但 committer 时间/信息可能被服务器改写）。若第二次推送还用本地 HEAD^
// 当父提交，远端根本找不到那个对象 → 404 "Not Found"。
// 远端 SHA 才是远端分支真正的上一个提交。
const remoteTip = JSON.parse(gh(['api', `repos/${OWNER}/${REPO}/git/ref/heads/${BRANCH}`])).object.sha;

// 远端 tip 可能是 Git Data API 重建出来的 commit，本地对象库里没有，
// 所以不能 `git diff <remoteTip> HEAD`（bad object）。
// 改用**blob SHA 对比**：blob 的 SHA 是内容哈希，跨仓库一致，
// 只要两边同路径的 SHA 相同就说明内容一样，不用上传。
// 这样只依赖 git ls-tree（纯本地）与 API 的 tree 列表，互不依赖对象库。
const remoteCommit = JSON.parse(gh(['api', `repos/${OWNER}/${REPO}/git/commits/${remoteTip}`]));
const baseTreeSha = remoteCommit.tree.sha;

async function apiTreeRecursive(sha) {
  const out = JSON.parse(gh(['api', `repos/${OWNER}/${REPO}/git/trees/${sha}?recursive=1`]));
  if (out.truncated) throw new Error('远端 tree 过大被截断，无法安全比对');
  const map = new Map();
  (out.tree || []).forEach((e) => { if (e.type === 'blob') map.set(e.path, e.sha); });
  return map;
}
const remoteBlobs = await apiTreeRecursive(baseTreeSha);

const localBlobs = new Map();
git(['ls-tree', '-r', 'HEAD'])
  .split('\n')
  .filter(Boolean)
  .forEach((line) => {
    // 格式：<mode> blob <sha>\t<path>
    const tab = line.indexOf('\t');
    const meta = line.slice(0, tab).split(/\s+/);
    localBlobs.set(line.slice(tab + 1), meta[2]);
  });

const tree = [];
let changed = 0;
for (const [p, sha] of localBlobs) {
  if (remoteBlobs.get(p) === sha) continue;   // 内容一致，跳过
  const content = git(['cat-file', 'blob', `HEAD:${p}`], { encoding: 'buffer' });
  const blob = JSON.parse(gh(['api', '-X', 'POST', `repos/${OWNER}/${REPO}/git/blobs`], {
    content: content.toString('base64'),
    encoding: 'base64',
  }));
  tree.push({ path: p, mode: '100644', type: 'blob', sha: blob.sha });
  changed += 1;
}
// 远端有、本地没有 → 删除
for (const p of remoteBlobs.keys()) {
  if (localBlobs.has(p)) continue;
  tree.push({ path: p, mode: '100644', type: 'blob', sha: null });
  changed += 1;
}

console.log(`仓库 ${OWNER}/${REPO} 分支 ${BRANCH}`);
console.log(`本地提交 ${headSha.slice(0, 7)}，远端 tip ${remoteTip.slice(0, 7)}`);
console.log(`比对 ${localBlobs.size} 个文件，需更新 ${changed} 个`);

const newTree = JSON.parse(gh(['api', '-X', 'POST', `repos/${OWNER}/${REPO}/git/trees`], {
  base_tree: baseTreeSha,
  tree,
}));

const newCommit = JSON.parse(gh(['api', '-X', 'POST', `repos/${OWNER}/${REPO}/git/commits`], {
  message,
  tree: newTree.sha,
  parents: [remoteTip],
}));

gh(['api', '-X', 'PATCH', `repos/${OWNER}/${REPO}/git/refs/heads/${BRANCH}`], {
  sha: newCommit.sha,
  force: false,
});

console.log(`已更新 ${BRANCH} → ${newCommit.sha.slice(0, 7)}`);
console.log('注意：Git Data API 推送不产生 push 事件，CI 与 Pages 都不会自动跑。');
console.log('必须补：gh workflow run <ci>.yml --ref ' + BRANCH + ' 与 gh api -X POST repos/' + OWNER + '/' + REPO + '/pages/builds');
console.log('OWNER=' + OWNER + ' REPO=' + REPO);
