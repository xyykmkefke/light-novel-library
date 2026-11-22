# 轻小说库 · 落实与交接

- 文档日期：2026-11-22
- 当前状态：v0.1.0 初始骨架（仅目录、规范与本文档，未写业务代码）
- 模板项目：`../番剧`（Bangumi Anime Library v1.6.8）
- 模板线上：<https://xyykmkefke.github.io/bangumi-anime-library/>
- 目标版本：v1.0.0

## 1. 目标与边界

做一个本地优先、无后端的轻小说浏览 + 阅读记录 PWA，沿用番剧项目的交互与工程体系。

v1.0.0 必须包含：

- 全库浏览：年份、题材、系列 / 单册筛选；评分 / 热度 / 发售日 / 名称排序
- 搜索：多关键词交集、`-词` 排除、拼音首字母、标题高亮、搜索历史
- 我的阅读：想读 / 在读 / 读完 / 弃读；系列条目记录读到第几卷；读完自动记录日期
- 视图：网格 / 列表 / 看板（按状态四列）；按年份、题材、状态分组
- 详情：封面、作者、插图、出版社、书系、册数、发售日、题材、评分、Bangumi 链接、同题材推荐
- 数据：JSON / CSV / Markdown 导出；JSON 导入合并（无效条目提示）
- 云同步：GitHub Gist 双向合并，删除墓碑，失败退避重试
- PWA：可添加到 iOS 主屏幕，离线可打开
- 设置：字号 / 卡片密度 / 动效 / 明暗主题
- 无障碍：跳过头部、焦点陷阱、Esc 归焦、状态播报、44px 触控目标

v1.0.0 明确不做：

- 单卷逐卷记录（只记系列进度）
- 个人评分、短评、笔记
- 本季日历、放送星期、最近浏览、摇一部、年度回顾
- 地区筛选（书籍的地区数据稀疏）
- 账号登录、自建后端

## 2. 数据源（已核实）

Bangumi 镜像接口：

```http
POST https://bgmapi.anibt.net/v0/search/subjects?limit=20&offset=0
Content-Type: application/json
User-Agent: yuc-light-novel-list/1.0

{
  "keyword": "",
  "sort": "heat",
  "filter": { "type": [1], "tag": ["轻小说"] }
}
```

- `type=1` 为书籍；`tag` 精确匹配「轻小说」。
- 单页最多 20 条（`limit` 传 50 也只返回 20），按 `offset += 20` 翻页，直到 `offset >= total`。
- 2026-11-22 实测 `total = 4003`，日期范围约 1865–2026。
- 搜索结果已包含 `infobox`、`tags`、`rating`、`collection`，无需逐条请求详情。
- 建议请求间隔 800ms，失败重试 4 次（2s / 4s / 6s 退避）。

数据构成（抽样 100 条）：

- `series: true` 约 74%：系列总条目，`volumes` 为总卷数
- `series: false` 约 26%：单卷或单本，其中一部分是某个系列的卷（如「文学少女」第 1 卷、「空之境界 (上)」）
- 因此需要「隐藏系列子卷」清洗，否则搜索一个系列会出现多条重复

## 3. 抓取与产出

新增 `scripts/fetch-books.mjs`，参考 `../番剧/scripts/fetch-bangumi.mjs`：

- 复用 `requestPage` 的重试、`slim` 的压缩思路、`initials` 拼音
- 去掉季度逻辑，直接按 offset 全量翻页
- 每页缓存到 `data/build/page-0000.json`，中断可续跑；`--refresh` 清空缓存重抓
- 输出 `data/light-novels.js`：

```js
// 由 scripts/fetch-books.mjs 生成，请勿手动修改
window.LN_META = { generatedAt: '...', count: 4003, minDate: '...', maxDate: '...' };
window.LN_DATA = [ /* ... */ ];
```

数据字段（缩写用于控制体积）：

| 字段 | 含义 | 来源 |
|---|---|---|
| `i` | Bangumi ID | `id` |
| `n` | 原名 | `name` |
| `cn` | 中文名 | `name_cn` |
| `d` | 首卷发售日 | `date` |
| `v` | 总卷数 | `volumes`（0 表示未知 / 单本） |
| `sv` | 是否系列条目 | `series` |
| `c` | 是否系列子卷（构建期推断） | 见第 4 节 |
| `s` | 评分 | `rating.score` |
| `rk` | 排名 | `rating.rank` |
| `h` | 收藏数 | `collection.collect` |
| `img` | 封面 | `images.common` |
| `py` | 拼音首字母 | `pinyin-pro` |
| `tg` | 题材 id 数组 | `scripts/genres.mjs` |
| `au` | 作者 | `infobox`「作者」 |
| `il` | 插图 | `infobox`「插图」 |
| `pub` | 出版社 | `infobox`「出版社」 |
| `line` | 书系 / 文库 | `infobox`「书系」或「文库」 |
| `ns` | 是否 R18 | `nsfw` |
| `rt` | 原始标签（仅抓取缓存，不写入最终文件） | `meta_tags` + `tags`（count ≥ 3） |

题材白名单（`scripts/genres.mjs`，18 个）：

科幻、奇幻、异世界、恋爱、校园、日常、治愈、喜剧、悬疑、推理、战斗、冒险、后宫、百合、耽美、恐怖、历史、青春。

标签映射沿用番剧策略：只做精确匹配，低于 3 票的用户标签不参与归类；调整映射表后可离线重算，无需重新联网。

## 4. 系列子卷清洗

在构建期（fetch 末尾或独立 `scripts/clean-series.mjs`）执行：

1. 取所有 `sv=true` 的系列，归一化标题（去空格 / 标点），按长度降序。
2. 对 `sv=false` 的条目，若归一化标题以某个系列标题开头，且剩余部分匹配卷标，则标记 `c = true`：
   - 数字卷标：`/^[\s　]*(第)?\s*\d+\s*[卷册集话]?([\s　]*[-~～].*)?$/`
   - 卷后缀词：`上 | 中 | 下 | 前 | 后 | 新装版 | 短篇集 | 外传 | 番外 | 画集 | 公式书 | 设定集`
3. 标题完全相同的条目只保留 `h` 最高的一条，其余标记 `c = true`。
4. `check-data.mjs` 输出系列数、单册数、子卷数；抽查：
   - 搜索「文学少女」默认只显示系列条目
   - 「白夜行」「人间失格」这类单本仍显示
   - 「无职转生」默认只显示系列条目

UI 对应：筛选栏提供「隐藏系列子卷」开关，默认开启；关闭后显示全部约 4000 条。

## 5. 个人数据与键名（同源冲突警告）

两个项目都会部署在 `xyykmkefke.github.io` 下，localStorage 与 Cache Storage 按 origin 共享，所有键必须带项目前缀，绝不能复用番剧的键。

| 用途 | 键名 |
|---|---|
| 我的阅读 | `yuc_ln_mine_v1` |
| 筛选偏好 | `yuc_ln_prefs_v1` |
| 搜索历史 | `yuc_ln_hist_v1` |
| 删除墓碑 | `yuc_ln_deleted_v1` |
| 设置 | `yuc_ln_settings_v1` |
| Gist 配置 | `yuc_ln_gist_v1` |
| 备份时间 | `yuc_ln_backup_v1` |
| 待备份改动 | `yuc_ln_dirty_v1` |
| 备份提醒 | `yuc_ln_backup_warn_v1` |
| SW 缓存 | `yuc-ln-shell-v1` |
| Gist 文件名 | `yuc-light-novel-list.json` |
| Gist payload app | `yuc-light-novel-list` |

单条记录：

```js
{
  s: 'want' | 'doing' | 'done' | 'drop',
  vol: 0,        // 已读到第几卷，范围 0..v；v=0 时隐藏进度输入
  t: 0,          // 加入时间戳
  u: 0,          // 更新时间戳
  f: 0           // 读完时间戳，未读完为 0
}
```

- 状态文案：想读 / 在读 / 读完 / 弃读
- 状态改为 `done` 时自动 `f = Date.now()` 且 `vol = v`；离开 `done` 保留 `vol`，`f` 置 0
- 合并规则：同一条目按 `u` 取新；`vol` 取两者较大值；删除用墓碑（保留 180 天）
- 导出 JSON：

```json
{
  "app": "yuc-light-novel-list",
  "version": 1,
  "exportedAt": "2026-11-22T00:00:00.000Z",
  "items": [
    { "id": 499, "status": "done", "vol": 8, "addedAt": 0, "updatedAt": 0, "finishedAt": 0 }
  ]
}
```

## 6. 页面改造映射

以 `../番剧/index.html` v1.6.8 为底稿复制，保留 CSS / 主题 / 工具栏 / 命令面板 / 设置 / 同步 / 导出 / 无障碍，替换下列域相关内容：

| 番剧 | 轻小说 |
|---|---|
| `ANIME_DATA` / `ANIME_META` | `LN_DATA` / `LN_META` |
| `data/anime-lite.js` 分层加载 | 删除；数据量约 4000 条，直接一次加载 |
| `STATUS` 想看 / 在看 / 看完 / 弃番 | 想读 / 在读 / 读完 / 弃读 |
| `state.season` + `renderSeasons` | 删除 |
| `state.platform`（动画平台） | 删除 |
| `state.region` | 删除 |
| 卡片「集数 / 已看」 | 「卷数 / 已读卷」 |
| 详情「话数 / 首播」 | 「册数 / 发售日 / 作者 / 插图 / 出版社 / 书系」 |
| 日历视图 | 删除 |
| 导出列「已看」 | 「已读卷」「读完日期」 |
| 播放进度 `ep` | 阅读进度 `vol` |
| Gist 键与文件名 | 见第 5 节 |
| `PAGE_SIZE` 240 分批 | 保留 |

关键区段（v1.6.8 行号，仅作定位参考）：

- 数据与常量：L2602–2658
- `state`：L2686–2705
- 记录 `normalizeEntry` / `saveMine`：L2737–2820
- `filteredList`：L3439
- 卡片渲染：L3555
- `render`：L3943
- 详情 `renderDetail`：L4107
- 命令面板 `renderPalette`：L4682
- 设置 `syncSettingsUI`：L5290
- 导出：L5572–5639
- 导入：L5641–5686
- Gist 同步：L5715–6100
- 全库加载 `loadFullData`：L6269

搜索、筛选、批量、撤销、看板、分组、分享、备份提醒、重试队列等通用逻辑不要重写，按字段替换即可。

## 7. 目录结构（完成后）

```
轻小说/
├── index.html                 # 单文件应用
├── data/light-novels.js       # 生成的全库数据（提交）
├── data/build/                # 抓取分页缓存（不提交）
├── scripts/
│   ├── fetch-books.mjs
│   ├── clean-series.mjs
│   ├── genres.mjs
│   ├── build-pinyin.mjs
│   ├── check-data.mjs
│   └── verify.mjs
├── sw.js
├── manifest.webmanifest
├── icon.svg
├── icons/                     # 180 / 192 / 512 PNG
├── package.json
└── README.md
```

## 8. 实施步骤

### Step 1 数据（完成标志：`npm run check-data` 通过）

1. 复制 `../番剧/scripts/` 的 fetch / pinyin / check 框架，改成本项目命名。
2. 写 `fetch-books.mjs`，全量抓约 4003 条，输出 `data/light-novels.js`。
3. 写 `genres.mjs`（18 个题材），构建期写入 `tg`。
4. 写 `clean-series.mjs`，写入 `c` 字段。
5. `npm run check-data`：重复 ID、日期、评分、卷数、题材、标题、`rt` 泄漏全部为 0；输出系列 / 单册 / 子卷统计。

### Step 2 页面（完成标志：本地打开可浏览、可加入、可记进度）

1. 复制 `../番剧/index.html`，按第 6 节替换数据、状态、题材、字段。
2. 删除季度 / 日历 / 地区 / 动画平台相关代码与 DOM。
3. 卡片、详情、我的、导出列改为卷进度。
4. 保留搜索、筛选、排序、视图、批量、撤销、命令面板、设置、无障碍。
5. `npx serve .` 打开检查桌面与 375×812 移动端。

### Step 3 云同步与数据（完成标志：双浏览器双向合并通过）

1. 按第 5 节改 localStorage 键、Gist 文件名、payload `app`。
2. 合并逻辑：`u` 新者胜，`vol` 取大，墓碑防复活。
3. 导出 JSON / CSV / MD，导入合并，备份提醒。

### Step 4 PWA（完成标志：断网重开可用）

1. `sw.js` 改缓存名 `yuc-ln-shell-v1`，SHELL 改为 `./data/light-novels.js`。
2. manifest 改名「轻小说库」、短名「轻小说」，主题色沿用石墨黑 + 靛蓝。
3. 生成 180 / 192 / 512 PNG 图标，补 iOS meta。
4. 断网重开验证。

### Step 5 验收（完成标志：`npm run verify` 全绿）

1. 从 `../番剧/scripts/verify.mjs` 复制 CDP 验收骨架（静态服务器、Edge/Chrome、CDP 部分）。
2. 端口改为本项目专用：HTTP `8791`，CDP `9337`，避免与番剧 / galgame 冲突。
3. 写本项目用例，目标 ≥ 45 项，覆盖第 9 节。
4. 保留失败截图 / 日志。

### Step 6 部署（完成标志：线上可打开）

1. 提交后执行：

```bash
gh repo create xyykmkefke/light-novel-library --public --source . --remote origin --push
```

2. 开启 Pages：`main` 分支根目录。
3. 线上复跑验收，记录 URL 与版本。

## 9. 验收清单

数据：

- [ ] 条目数 ≥ 3900，ID 无重复
- [ ] 日期为空或 `YYYY-MM-DD`
- [ ] 评分 0–10，卷数为 ≥ 0 的整数
- [ ] 题材 id 全部在白名单内，无重复
- [ ] 最终文件无 `rt` 字段
- [ ] 系列 / 单册 / 子卷统计合理；抽查「文学少女」「无职转生」「白夜行」

功能：

- [ ] 搜索中文、原名、拼音首字母、`-排除`
- [ ] 年份 / 题材 / 状态 / 高分 / 只看我的 / 隐藏子卷筛选
- [ ] 网格 / 列表 / 看板切换，分组，分页
- [ ] 加入 / 移出、四状态、卷进度上限、读完自动填日期
- [ ] 批量标记 / 移出、撤销
- [ ] 详情、相似推荐、上下一条、分享链接
- [ ] JSON / CSV / MD 导出；JSON 导入合并与无效提示
- [ ] 设置字号 / 密度 / 动效 / 主题
- [ ] 命令面板、键盘导航、焦点陷阱

同步：

- [ ] 两个浏览器配置同 Gist，A 加 B 见
- [ ] A 改状态、B 改进度，合并后状态取新、进度取大
- [ ] 删除后另一设备不复活
- [ ] 断网改数据，恢复后自动补同步
- [ ] Token 错误不重试并提示

PWA / 移动端：

- [ ] 离线重开可用
- [ ] iOS 添加到主屏幕全屏启动
- [ ] 375×812 筛选抽屉、44px 触控、无横向滚动

## 10. 已知风险与决策

1. Bangumi 书籍数据系列 / 单卷混杂：用 `c` 标记 + 默认隐藏；若误判，用户可关闭开关看全部。
2. 部分条目缺日期 / 卷数 / 作者：留空，UI 显示「—」，不丢弃条目。
3. 封面为外链，首次需联网；离线显示首字占位（沿用番剧）。
4. 两个 Pages 站点同源：键名、缓存名、Gist 文件名必须唯一。
5. Gist Token 只存本机；建议只勾选 `gist` 权限。
6. 抓取是公开接口，务必限速 800ms、带 UA、失败退避，避免被风控。
7. 版本策略：补丁位修 bug / 样式，次版本加功能块，主版本才大改。

## 11. 交接提示词

> 接手 `c:\Users\ASUS\Desktop\音乐\轻小说`。先读 `README.md`、`HANDOVER.md`，再读 `../番剧/README.md` 和 `../番剧/index.html` 的对应区段。按第 8 节顺序实现 v1.0.0，每步运行 `check-data` / `verify`，不要修改 `../番剧`。完成后汇报：数据统计、verify 通过数、桌面与移动端截图、线上 URL。若数据字段与本文不符，先停下来说明差异再改。
