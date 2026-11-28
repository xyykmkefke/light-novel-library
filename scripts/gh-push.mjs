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
  const out = execFileSync('git', args, {
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
const parentSha = git(['rev-parse', 'HEAD^']);
const message = git(['log', '-1', '--pretty=%B']);

// 相对父提交的改动文件（含新增/修改/删除）
const nameStatus = git(['diff', '--name-status', parentSha, headSha]).split('\n').filter(Boolean);
const files = nameStatus.map((line) => {
  const parts = line.split('\t');
  return { status: parts[0][0], path: parts[parts.length - 1] };
});

console.log(`仓库 ${OWNER}/${REPO} 分支 ${BRANCH}`);
console.log(`提交 ${headSha.slice(0, 7)}，改动 ${files.length} 个文件`);

// 父提交的 tree
const parentCommit = JSON.parse(gh(['api', `repos/${OWNER}/${REPO}/git/commits/${parentSha}`]));
const baseTreeSha = parentCommit.tree.sha;

const tree = files.map((f) => {
  if (f.status === 'D') {
    return { path: f.path, mode: '100644', type: 'blob', sha: null };
  }
  // 必须从 git 对象库读，不能读工作区（CRLF 会导致 tree 校验失败）
  const content = git(['cat-file', 'blob', `HEAD:${f.path}`], { encoding: 'buffer' });
  const blob = JSON.parse(gh(['api', '-X', 'POST', `repos/${OWNER}/${REPO}/git/blobs`], {
    content: content.toString('base64'),
    encoding: 'base64',
  }));
  return { path: f.path, mode: '100644', type: 'blob', sha: blob.sha };
});

const newTree = JSON.parse(gh(['api', '-X', 'POST', `repos/${OWNER}/${REPO}/git/trees`], {
  base_tree: baseTreeSha,
  tree,
}));

const newCommit = JSON.parse(gh(['api', '-X', 'POST', `repos/${OWNER}/${REPO}/git/commits`], {
  message,
  tree: newTree.sha,
  parents: [parentSha],
}));

gh(['api', '-X', 'PATCH', `repos/${OWNER}/${REPO}/git/refs/heads/${BRANCH}`], {
  sha: newCommit.sha,
  force: false,
});

console.log(`已更新 ${BRANCH} → ${newCommit.sha.slice(0, 7)}`);
console.log('注意：Git Data API 推送不产生 push 事件，CI 与 Pages 都不会自动跑。');
console.log('必须补：gh workflow run <ci>.yml --ref ' + BRANCH + ' 与 gh api -X POST repos/' + OWNER + '/' + REPO + '/pages/builds');
console.log('OWNER=' + OWNER + ' REPO=' + REPO);
