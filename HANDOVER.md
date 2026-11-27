# 轻小说库 · 落实与交接

- 文档日期：2026-11-23
- 当前状态：**v1.24.3 完成**（数据、页面、书评、统计、Gist 同步、PWA、本地纠错、格式与藏书、多语言搜索、自动化验收 240/240 + 全量搜索审计 14/14 + 分片失败回归 23/23）
- 项目线上：<https://xyykmkefke.github.io/light-novel-library/>
- 本次会话日志：`reports/session-log-2026-11-23.md`
- 模板项目：`../番剧`（Bangumi Anime Library v1.6.8）
- 模板线上：<https://xyykmkefke.github.io/bangumi-anime-library/>
- 目标版本：v1.18.0（已达成，功能：同步状态面板、合并统计与最近同步记录）

## 1. 目标与边界

做一个本地优先、无后端的轻小说浏览 + 阅读记录 PWA，沿用番剧项目的交互与工程体系。

v1.0.0 必须包含：

- 全库浏览：年份、题材、系列 / 单册筛选；评分 / 热度 / 发售日 / 名称排序
- 搜索：多关键词交集、`-词` 排除、拼音首字母、标题高亮、搜索历史
- 我的阅读：想读 / 在读 / 读完 / 弃读；系列条目记录读到第几卷；读完自动记录日期
- 视图：网格 / 列表 / 看板（按状态四列）；按年份、题材、状态分组
- 详情：封面、作者、插图、出版社、书系、册数、发售日、题材、评分、Bangumi 链接、相似推荐（同作者 / 同书系 / 同题材 / 评分接近）
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
- 单页最多 20 条（`limit` 传 50 也只返回 20）。
- 2026-11-23 实测「轻小说」`total = 4051`，「小说」`total = 3280`；两者合并去重后 4815 条。日期范围约 1719–2026。
- **搜索接口有 1000 条上限**：`offset` 最多到 980，`offset=1000` 起返回空数组。因此不能直接按 offset 翻完 4000 多条。
- 解决：按 `rating_count` 分区（0-9、10-19、20-29、30-39、40-49、50-74、75-99、100-499、500-999、1000+），每区小于 1000 条，区内再按 offset 翻页；若某区仍超 1000，脚本会继续二分。两个标签分别抓取后合并去重。
- 搜索结果已包含 `infobox`、`tags`、`rating`、`collection`，无需逐条请求详情。
- 建议请求间隔 800ms，失败重试 4 次（2s / 4s / 6s 退避）。

RanobeDB 公共 API（ODbL，请求间隔 1.1s）：

```http
GET https://ranobedb.org/api/v0/series?limit=250&page=1   # 全量目录，共 23194 个系列
GET https://ranobedb.org/api/v0/series/{id}               # 系列详情，含 books / staff / publishers
GET https://ranobedb.org/api/v0/releases?q={title}        # 单册 ISBN
```

- 目录缓存在 `data/build/ranobedb-catalog/`，详情缓存在 `data/build/ranobedb-series-detail/`，均可断点续跑。
- 扩展书目只收 `title_orig` 为日文、`c_num_books >= 2` 且与本地标题不重复的系列；封面来自 `https://images.ranobedb.org/`。
- 补卷只接受系列标题精确同名，避免把外传 / 不同版本挂到主系列。

数据构成（实测 5076 条，2026-11-25 刷新）：

- `series: true` 1394 条：系列主条目
- `series: false` 3682 条：单册，或某个系列的卷
- 经 `/v0/subjects/{id}/subjects` 清洗后，`c = true` 子卷 2223 条；默认可见轻小说 2026 条
- 同名系列保留卷数最多、收藏最高的为主条目，其余 79 条标记 `ver` 并默认隐藏
- 仅「小说」标签、没有「轻小说」标签的 788 条标记 `gn: true`，默认隐藏；与轻小说系列有关联的条目会保留为轻小说（离线 `clean-series` 也执行同样修正，见 `adjustGeneralFlags`）
- 关联中还有、库中没有的 7817 卷（单行本 + 番外篇 + RanobeDB 补卷）写入 `data/light-novels-volumes.js`，按需加载；核心 `ch` 直接引用这些 ID
- RanobeDB 扩展书目：≥2 卷、日文原名、与 Bangumi 标题去重后 8487 个系列 / 31254 卷，写入 `data/light-novels-rn.js`，默认隐藏、按需加载；ODbL 授权，详情链接到 RanobeDB
- 需要「隐藏系列子卷」清洗，否则搜索一个系列会出现多条重复

## 3. 抓取与产出

新增 `scripts/fetch-books.mjs`，参考 `../番剧/scripts/fetch-bangumi.mjs`：

- 复用 `requestPage` 的重试、`slim` 的压缩思路、`initials` 拼音
- 去掉季度逻辑，按 `rating_count` 分区，在各分区内按 offset 翻页
- 每页缓存到 `data/build/page-{分区}-{页码}.json`，中断可续跑；`--refresh` 清空缓存重抓
- 输出 `data/light-novels.js`：

```js
// 由 scripts/fetch-books.mjs 生成，请勿手动修改
window.LN_META = { generatedAt: '...', count: 5076, general: 788, minDate: '...', maxDate: '...' };
window.LN_DATA = [ /* ... */ ];
```

数据字段（缩写用于控制体积）：

| 字段 | 含义 | 来源 |
|---|---|---|
| `i` | Bangumi ID | `id` |
| `n` | 原名 | `name` |
| `cn` | 中文名 | `name_cn` |
| `d` | 首卷发售日 | `date`，允许 `YYYY` / `YYYY-MM` / `YYYY-MM-DD`，按上游精度存储 |
| `v` | 总卷数 | `volumes`（0 表示未知 / 单本） |
| `sv` | 是否系列条目 | `series` |
| `c` | 是否系列子卷（构建期推断） | 见第 4 节 |
| `s` | 评分 | `rating.score` |
| `rk` | 排名 | `rating.rank` |
| `h` | 收藏数 | `collection.collect` |
| `img` | 封面 | `images.common` |
| `py` | 拼音首字母 | `pinyin-pro` |
| `tg` | 题材 id 数组 | `scripts/genres.mjs` |
| `au` | 作者 | `infobox`「作者」→「原作」→「著者」/「作者名」 |
| `il` | 插图 | `infobox`「插图」→「插画」/「イラスト」→「作画」/「人物原案」 |
| `pub` | 出版社 | `infobox`「出版社」/「发行」/「出版商」/「発行」 |
| `line` | 书系 / 文库 | `infobox`「书系」/「文库」/「レーベル」/「丛书」/「图书品牌」，含嵌套版本 |
| `kind` | 类型标记（可选） | 漫画 `manga` / 画集 `artbook` / 指南 `guide`；普通轻小说不写 |
| `ns` | 是否 R18 | `nsfw` |
| `rt` | 原始标签（仅抓取缓存，不写入最终文件） | `meta_tags` + `tags`（count ≥ 3） |

题材白名单（`scripts/genres.mjs`，18 个）：

科幻、奇幻、异世界、恋爱、校园、日常、治愈、喜剧、悬疑、推理、战斗、冒险、后宫、百合、耽美、恐怖、历史、青春。

标签映射沿用番剧策略：只做精确匹配，低于 3 票的用户标签不参与归类；调整映射表后可离线重算，无需重新联网。

## 4. 系列子卷清洗

在构建期由 `scripts/clean-series.mjs` 执行，优先用 Bangumi 关联接口，标题规则只做兜底：

1. **主规则：关联接口**。对每个 `sv=true` 的系列请求 `GET /v0/subjects/{id}/subjects`，把 `relation=单行本` 且 `type=1` 的关联条目标记为 `c = true`。缓存到 `data/build/rel-{id}.json`，可离线重算。
   - 实测「文学少女」返回 17 条单行本，「无职转生」返回 26 条，能覆盖标题规则漏掉的 `“文学少女”と…` 这类卷名。
2. **兜底规则：标题前缀**。仅对没有「单行本」关联数据的系列使用：
   - 归一化标题（去空格 / 标点），按长度降序；
   - `sv=false` 条目若以系列标题开头，且剩余部分匹配数字卷标或后缀词，则标记 `c = true`；
   - 数字卷标：`^(?:第)?\d+(?:[卷册集话])?(?:[-~].*)?$`；
   - 后缀词：`上 | 中 | 下 | 前 | 后 | 新装版 | 短篇集 | 外传 | 番外 | 画集 | 公式书 | 设定集`。
3. **父系列字段继承**：子卷常省略系列级字段。对 `c=true` 且字段为空的条目，从 `h` 最高的父系列继承 `line`、`il`、`au`、`pub`、`tg`、`kind`；不继承 `d`（日期）和 `v`（卷数）。
4. **类型标记**：`作画` 存在或标签含「漫画/コミック」且无插图 → `kind=manga`；标题/标签含画集、Art Book、イラスト集 → `kind=artbook`；含公式书、设定集、ガイドブック、Fan Book → `kind=guide`。普通轻小说不写 `kind`。
5. **不自动合并同名条目**：实测存在不同版本 / 不同作者的合法同名作品，按标题去重会误伤；重复项保留，由 UI 展示或后续人工处理。
6. `check-data.mjs` 输出系列数、单册数、子卷数、类型标记数；抽查：
   - 搜索「文学少女」默认只显示系列条目，不再出现单卷；
   - 「白夜行」「人间失格」这类单本仍显示；
   - 「无职转生」默认只显示系列条目，番外篇系列保留。

UI 对应：筛选栏提供「隐藏系列子卷」开关，默认开启；关闭后显示全部约 4000 条。

## 5. 个人数据与键名（同源冲突警告）

番剧、轻小说、galgame 三个项目都会部署在 `xyykmkefke.github.io` 下，localStorage 与 Cache Storage 按 origin 共享，所有键必须带项目前缀，绝不能复用番剧的键。

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
| 年度目标 | `yuc_ln_goal_v1` |
| 书评草稿 | `yuc_ln_draft_v1` |
| 打卡日期 | `yuc_ln_days_v1` |
| 同步日志 | `yuc_ln_synclog_v1` |
| 本地纠错 / 别名 | `yuc_ln_meta_v1` |
| SW 缓存 | `yuc-ln-shell-v47` |
| Gist 文件名 | `yuc-light-novel-list.json` |
| Gist payload app | `yuc-light-novel-list` |

单条记录：

```js
{
  s: 'want' | 'doing' | 'done' | 'drop',
  vol: 0,        // 已读到第几卷，范围 0..v；v=0 时隐藏进度输入
  t: 0,          // 加入时间戳
  u: 0,          // 更新时间戳
  f: 0,          // 读完时间戳，未读完为 0
  r: 0,          // 我的评分 0–10，0 表示未评分
  rv: '',        // 短评，≤140 字
  nt: '',        // 笔记，≤1000 字
  rvU: 0,        // 书评更新时间戳，独立于状态合并
  fm: '',        // 阅读 / 持有格式：paper | ebook | web | audio，空表示未标记
  ow: 0,         // 藏书标记 0/1
  mu: 0          // 格式 / 藏书更新时间戳，跨设备按它整体取新
}
```

- 状态文案：想读 / 在读 / 读完 / 弃读
- 状态改为 `done` 时自动 `f = Date.now()` 且 `vol = v`；离开 `done` 保留 `vol`，`f` 置 0
- 合并规则：同一条目按 `u` 取新；`vol` 取两者较大值；书评按 `rvU` 单独取新；删除用墓碑（保留 180 天）
- 本地纠错记录（`yuc_ln_meta_v1`）：

```js
{
  cn: '', n: '', au: '', il: '', pub: '', line: '', d: '', // 只存被修正的字段
  al: [],   // 别名，≤8 个，参与搜索
  clr: [],  // 被用户清空的字段（与「没填」区分）
  u: 0      // 更新时间，跨设备按它取新
}
```

- 导出 / Gist payload（version 4；旧版客户端会忽略 `meta` 与格式字段，收藏记录仍可互通）：

```json
{
  "app": "yuc-light-novel-list",
  "version": 4,
  "exportedAt": "2026-11-22T00:00:00.000Z",
  "items": [
    { "id": 499, "status": "done", "vol": 8, "addedAt": 0, "updatedAt": 0, "finishedAt": 0,
      "rating": 9, "review": "短评", "note": "笔记", "reviewUpdatedAt": 0,
      "format": "ebook", "owned": 1, "formatUpdatedAt": 0 }
  ],
  "deleted": {},
  "meta": { "499": { "au": "本地作者", "al": ["别名"], "clr": [], "u": 0 } }
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
├── data/
│   ├── light-novels.js        # 完整核心（构建/校验输入，不部署）
│   ├── light-novels-lite.js   # 首屏默认可见
│   ├── light-novels-rest.js   # 子卷 / 一般小说 / 重复版本（后台补载）
│   ├── light-novels-ch.js     # 系列子卷索引（打开系列详情时按需）
│   ├── light-novels-extra.js  # 详情字段（按需）
│   ├── light-novels-volumes.js
│   ├── light-novels-rn.js
│   ├── bgm-detail-fills.json  # 详情补全候选（构建输入）
│   └── build/                 # 抓取分页缓存（不提交）
├── scripts/
│   ├── fetch-books.mjs
│   ├── clean-series.mjs
│   ├── enrich-bgm-detail.mjs
│   ├── genres.mjs
│   ├── build-pinyin.mjs
│   ├── check-data.mjs
│   ├── check-deploy.mjs
│   └── verify.mjs
├── sw.js
├── manifest.webmanifest
├── icon.svg
├── icons/                     # 180 / 192 / 512 PNG
├── package.json
└── README.md
```

## 8. 实施步骤

### Step 1 数据（已完成，`npm run check-data` 通过）

1. 复制 `../番剧/scripts/` 的 fetch / pinyin / check 框架，改成本项目命名。
2. 写 `fetch-books.mjs`，按 `rating_count` 分区抓取 4007 条，输出 `data/light-novels.js`。
3. 写 `genres.mjs`（18 个题材），构建期写入 `tg`。
4. 写 `clean-series.mjs`，优先用关联接口写入 `c` 字段，标题规则兜底。
5. `npm run check-data`：重复 ID、日期、评分、卷数、题材、标题、`rt` 泄漏全部为 0；系列 1123 / 单册 2884 / 子卷 2028。

### Step 2 页面（已完成）

1. 复制 `../番剧/index.html`，按第 6 节替换数据、状态、题材、字段。
2. 卡片和详情显示 `kind` 角标（漫画 / 画集 / 指南）；筛选中可选择类型。
3. 删除季度 / 日历 / 地区 / 动画平台相关代码与 DOM。
4. 卡片、详情、我的、导出列改为卷进度。
5. 保留搜索、筛选、排序、视图、批量、撤销、命令面板、设置、无障碍。
6. 桌面与 375×812 移动端均通过验收。

### Step 3 云同步与数据（已完成）

1. localStorage 键、Gist 文件名、payload `app` 已改为 `yuc_ln_*` / `yuc-light-novel-list`。
2. 合并逻辑：`u` 新者胜，`vol` 取大，墓碑防复活。
3. 导出 JSON / CSV / MD，导入合并，备份提醒均已实现。

### Step 4 PWA（已完成）

1. `sw.js` 缓存名 `yuc-ln-shell-v36`，SHELL 包含 `./data/light-novels-lite.js` 与 `./data/light-novels-extra.js`；剩余核心、卷包与扩展书目不预缓存，首屏后 / 首次展开 / 打开开关时按需下载并进入运行时缓存；封面缓存上限 400 张，超出按插入顺序清理。
2. manifest 为「轻小说库」/「轻小说库」，主题色沿用石墨黑 + 靛蓝。
3. 已生成 180 / 192 / 512 PNG 图标，iOS meta 完整。

### Step 5 验收（已完成：203/203）

1. `scripts/verify.mjs` 复用 CDP 骨架，端口 HTTP `8791`、CDP `9337`。
2. 覆盖数据、筛选、搜索、排序、阅读记录、卷进度、看板、分组、批量、命令面板、设置、空状态、hash、PWA、无障碍、移动端与控制台错误。
3. 失败截图与日志保留在 `screenshots/`。

### Step 6 部署（已完成）

1. 仓库：<https://github.com/xyykmkefke/light-novel-library>（public，默认分支 `main`）。
2. Pages：`main` 分支根目录，已开启；线上地址 <https://xyykmkefke.github.io/light-novel-library/>。
3. 线上冒烟：240 张卡片、全库 4007 条、页脚 v1.0.1、无脚本错误。
4. v1.0.1 已推送（commit `ee4242d`）。
5. v1.1.0 已推送（`cc6ebc8` 功能、`98221d8` 对比度与截图、`5f205a0` 作者跳转）；Pages 构建 `built`。
6. 线上冒烟：240 卡片、全库 4007、页脚 v1.1.0；作者标签跳转 `作者:道造` 命中 3 条且弹窗关闭；统计页可打开；无脚本错误。

## 9. 验收清单

数据：

- [x] 条目数 ≥ 3900，ID 无重复（4007 条）
- [x] 日期为空或 `YYYY-MM-DD`
- [x] 评分 0–10，卷数为 ≥ 0 的整数
- [x] 题材 id 全部在白名单内，无重复（覆盖 3187 条，79.5%）
- [x] 最终文件无 `rt` 字段
- [x] 系列 / 单册 / 子卷统计合理（1123 / 2884 / 2028）；抽查「文学少女」「无职转生」「白夜行」「人间失格」
- [x] 父系列继承生效：书系补 1244、插图 696、作者 12、题材 895；题材覆盖 79.5%
- [x] 类型标记有效：漫画 226 / 画集 9 / 指南 2，普通轻小说不写 `kind`

功能：

- [x] 搜索中文、原名、拼音首字母、`-排除`；高级字段 `作者:` `年:` `分:` `题材:`
- [x] 我的评分 / 短评 / 笔记，随导出、导入与 Gist 同步
- [x] 阅读统计、年度目标、题材偏好与常读作者
- [x] 详情作者 / 题材 / 年份标签跳转全库筛选
- [x] 年份 / 题材 / 类型 / 状态 / 高分 / 只看我的 / 隐藏子卷筛选
- [x] 网格 / 列表 / 看板切换，分组，分页
- [x] 加入 / 移出、四状态、卷进度上限、读完自动填日期
- [x] 批量标记 / 移出、撤销
- [x] 详情、相似推荐、上下一条、分享链接
- [x] JSON / CSV / MD 导出；JSON 导入合并与无效提示
- [x] 设置字号 / 密度 / 动效 / 主题
- [x] 命令面板、键盘导航、焦点陷阱

同步：

- [x] 键名、文件名、payload 已按项目前缀隔离
- [x] 合并按 `u` 取新、`vol` 取大、墓碑防复活
- [x] 断网恢复后自动补同步（重试队列沿用模板）
- [ ] 双浏览器真实 Gist 联调（需用户 Token，本地验收未覆盖）

PWA / 移动端：

- [x] 离线重开可用（SHELL + 全库数据缓存）
- [x] 设置面板显示封面缓存张数与占用，可一键清理
- [x] Service Worker 立即注册，页面重新可见时主动检查更新
- [x] iOS 添加到主屏幕全屏启动
- [x] 375×812 筛选抽屉、44px 触控、无横向滚动

## 9.1 实施记录

- 页面为单文件 `index.html`，数据一次加载，不再有 `anime-lite` 分层。
- 新增「隐藏系列子卷」开关，默认开启；关闭后显示全部 4007 条。
- 类型筛选：`novel` 表示数据中无 `kind` 的普通轻小说。
- 卷进度仅在 `v > 0` 且条目在「我的阅读」时显示；读满自动转「读完」并写入 `f`。
- 相似推荐：同类型内按同作者 → 同书系 → 同题材 → 评分接近排序。
- `npm run check-data` 问题数 0；`npm run verify` 74/74（含离线重开与 JSON 导入）。
- 截图：`screenshots/desktop.png`、`screenshots/mobile.png`。

## 9.2 v1.0.1 补丁记录（2026-11-23）

- 清理模板残留：删除日历视图、加载进度条、季度/地区/番剧相关死 CSS 与注释。
- 数据：29 条纯假名标题补罗马字首字母（`build-pinyin.mjs` 增加假名映射），拼音覆盖 4007/4007；133 条无日期为 Bangumi 上游确实缺失（详情接口同样为空），不做臆造。
- 排序：评分排序改为贝叶斯加权（先验均值 7.0、先验票数 100，`window.__lnBayesScore`），低收藏 10 分条目不再霸榜；搜索同档也按加权分排序。
- 同步：合并逻辑抽为纯函数 `mergeRemoteState`，新增 `scripts/test-merge.mjs`，13 条用例覆盖状态取新、进度取大、读满转读完、墓碑、旧 `ep` 字段、非法 ID。
- 体验：年份条溢出时右侧渐隐并自动滚动到当前年份；Toast 限宽居中，避免移动端溢出。
- PWA：缓存名升级 `yuc-ln-shell-v2`；检测到新版本接管时提示「刷新」。
- 验收：`check-data` 0；`test-merge` 13/13；`verify` 79/79（新增加权排序、日文首字母、年份提示、首屏耗时 4 条）。
- 体积：`index.html` 约 197 KB，`data/light-novels.js` 约 1.4 MB。

## 9.3 v1.1.0 功能记录（2026-11-23）

- 我的书评：详情内 1–10 分评分（即时保存）、140 字短评、1000 字笔记；未收藏时提示先加入阅读。
- 卡片展示 `★ 评分` 角标；详情元信息增加「我的评分」；CSV 增加评分/短评/笔记列；Markdown 增加评分列与「短评与笔记」章节。
- 同步协议升级 version 2：新增 `rating` / `review` / `note` / `reviewUpdatedAt`；书评按 `rvU` 单独取新，旧客户端只改状态不会清空书评；导入兼容旧版与书评字段。
- 阅读统计标签页：收藏/读完/在读/已读卷总览、年度目标与进度条、历年读完、今年月度分布、题材偏好、常读作者、已评分与平均分；目标存 `yuc_ln_goal_v1`。
- 高级搜索：`作者:`、`年:2020`、`年:2010-2020`、`分:>=8`、`题材:奇幻`，可与关键词、`-词` 排除组合；高亮与相关度只使用普通关键词。
- 详情内作者标签可点击，自动跳转到该作者的全库筛选（`作者:名字`）。
- 排序新增「按卷数」「按我的评分」；hash 与本地偏好同步。
- 键盘新增 J/K 上下移动卡片焦点；帮助面板补充搜索语法。
- 性能：卡片 `content-visibility: auto`；封面缓存上限 400 张自动清理；安装引导（`beforeinstallprompt` + iOS 分享提示，每会话一次）。
- 测试：`test-merge` 20 项；`verify` 115 项（新增书评、统计、高级搜索、作者跳转、卷数排序、J/K、浅色主题对比度、移动端统计与 390/430 宽度）。
- 浅色主题对比度：正文 17.57:1、次要文字 6.02:1（相对卡片底色），均高于 WCAG AA 4.5:1。
- 截图：新增 `screenshots/mobile-stats.png`、`desktop-stats.png`、`light.png`。

## 9.4 v1.1.1 补丁记录（2026-11-23）

- 参考 Goodreads / StoryGraph 的年度阅读挑战「ahead of schedule」做法，在统计页年度目标卡片增加节奏行。
- 新增纯函数 `goalPace(finished, target, now)`（`window.__lnGoalPace`）：按当年已过天数占总天数比例估算此刻应读本数，输出领先 / 落后本数、全年进度百分比与剩余天数；未设目标时不显示。
- 版本与缓存：页脚、manifest、package.json 升至 1.1.1；SW 缓存名升到 `yuc-ln-shell-v4`，确保旧客户端拿到新页面。
- 测试：`check-data` 问题 0；`test-merge` 20/20；`verify` 117/117（新增「年度目标显示节奏」「目标节奏按已过天数计算」2 项）。
- 来源：<https://www.goodreads.com/topic/show/22940342-reading-challenge-progress>、<https://mistysbookspace.wordpress.com/2026/07/08/mid-year-book-freak-out-tag-10/>。

## 9.5 v1.1.2 补丁记录（2026-11-23）

- 参考 BookLore 的「Log progress with one tap」与 Hardcover 对列表 / 详情交互的统一化做法，在详情弹窗内加入卷进度控制：减一卷、加一卷、读完全部，无需回到列表改卷数。
- 进度变更沿用 `setVol`：0 卷时减号禁用、读满自动转读完并补日期、回退自动转回在读；状态按钮与元信息中的进度标签同步更新。
- 为避免丢失书评草稿，进度操作用局部刷新更新进度条 / 进度标签 / 状态按钮，不重建整个详情。
- 版本与缓存：页脚、manifest、package.json 升至 1.1.2；SW 缓存名升到 `yuc-ln-shell-v5`。
- 测试：`check-data` 问题 0；`test-merge` 20/20；`verify` 121/121（新增详情进度控制、0 卷禁用减号、一键下一卷、进度与元信息同步 4 项）。
- 来源：<https://apps.apple.com/dk/app/booklore-book-tracker/id6784735724>、<https://hardcover.app/blog/hardcover-report-for-march-2024>、<https://github.com/Kareadita/Kavita>。

## 9.6 v1.1.3 补丁记录（2026-11-23）

- 参考 Bangumi 第三方客户端（czy0729/Bangumi、raycast-bangumi）收藏列表的浏览与排序方式：「最近更新」「我的评分」「阅读进度」等维度优先于单一加入时间。
- 我的阅读排序新增三项：最近更新（`entry.u`）、我的评分（`entry.r` 降序，同分比更新时间）、阅读进度（已读卷 / 总卷比例降序，同比例比已读卷数）。排序值随 hash 的 `ms` 与本地偏好保存，白名单同步扩展。
- 卷数未知的条目在进度排序中按 0 处理，不影响其余排序。
- 版本与缓存：页脚、manifest、package.json 升至 1.1.3；SW 缓存名升到 `yuc-ln-shell-v6`。
- 测试：`check-data` 问题 0；`test-merge` 20/20；`verify` 124/124（新增我的评分 / 阅读进度 / 最近更新排序 3 项）。
- 来源：<https://www.raycast.com/maxchang3/bangumi>、<https://bangumi.github.io/api/>、<https://hellogithub.com/repository/f33414cc05504c4685016a1103cda422>、<https://www.juxia.com/sjwy/ruanjian-693739.html>。

## 9.7 v1.1.4 补丁记录（2026-11-23）

- 参考 StoryGraph / Goodreads 对长文本编辑的处理：错按关闭或切换书籍不应丢失正在写的内容，草稿先落本地、正式保存才写入记录。
- 短评 / 笔记输入时即写入本机 `yuc_ln_draft_v1`（与收藏记录分离，不进入 Gist 同步协议）；详情底部字数提示同时显示「草稿已自动保存」。
- 重新打开详情时，若草稿时间晚于最近一次书评保存且内容不同，则自动回填并提示「已恢复未保存草稿」；点「保存书评」后清除草稿；移出收藏、清空列表时一并清理对应草稿。
- 版本与缓存：页脚、manifest、package.json 升至 1.1.4；SW 缓存名升到 `yuc-ln-shell-v7`。
- 测试：`check-data` 问题 0；`test-merge` 20/20；`verify` 128/128（新增草稿暂存、重开恢复、草稿提示、保存后清除 4 项）。
- 来源：<https://roadmap.thestorygraph.com/requests-ideas/posts/add-spoiler-tag-to-reviews>、<https://roadmap.thestorygraph.com/changelog>、<https://hardcover.app/blog/hardcover-report-for-september-2026>。

## 9.8 v1.1.5 补丁记录（2026-11-23）

- 参考 Calibre 的 `字段:值` 搜索语法与 Kavita 元数据筛选字段（Publisher / Imprint），把库里已有的 `pub`（出版社）与 `line`（书系）纳入高级搜索。
- 新增搜索字段 `出版社:` / `书系:`（兼容别名 `pub:` / `line:`），值为不区分大小写的包含匹配，可与关键词、`年:`、`分:`、`题材:`、`-词` 组合使用。
- 详情页的出版社、书系由纯文本标签改为可点击标签：点击后按 `出版社:` / `书系:` 跳转全库筛选；含空白的值无法用单个搜索词表达，降级为普通标签仅展示。
- 帮助面板、搜索框占位与 README 同步补充新语法。
- 版本与缓存：页脚、manifest、package.json 升至 1.1.5；SW 缓存名升到 `yuc-ln-shell-v8`。
- 测试：`check-data` 问题 0；`test-merge` 20/20；`verify` 131/131（新增出版社搜索、书系搜索、出版社标签跳转 3 项）。
- 来源：<https://manual.calibre-ebook.com/searching.html>、<https://calibre.posixlycorrect.com/advsearch>、<https://wiki.kavitareader.com/guides/features/filtering/>。

## 9.9 v1.1.6 补丁记录（2026-11-23）

- 参考 web.dev 的 Service Worker 生命周期建议，注册不再等 `window.load`（远程封面可能拖慢 load），改为脚本末尾立即注册。
- 页面重新可见（`visibilitychange`）且在线时调用 `reg.update()` 主动检查更新；接管提示沿用原有 `controllerchange`。
- 参考 Edge 离线存储文档与缓存配额实践，设置面板新增「离线缓存」一行：展示封面缓存张数与 `navigator.storage.estimate()` 占用，并提供「清理封面」按钮（只清理本项目 `yuc-ln-` 缓存中的封面请求，不影响应用壳与全库数据）。
- 修正 `<meta name="version">` 仍是 `1.0.0` 的遗留问题，现与 manifest、页脚、package.json 同步为 1.1.6。
- 版本与缓存：页脚、manifest、package.json 升至 1.1.6；SW 缓存名升到 `yuc-ln-shell-v9`。
- 测试：`check-data` 问题 0；`test-merge` 20/20；`verify` 135/135（新增离线缓存占用、清理封面、meta 版本一致、SW 主动更新检查 4 项）。
- 来源：<https://web.dev/learn/pwa/update?hl=zh-cn>、<https://web.developers.google.cn/articles/service-worker-lifecycle>、<https://learn.microsoft.com/ga-ie/microsoft-edge/progressive-web-apps/how-to/offline>、<https://blog.hashhackers.com/blog/storage-quota-management/>。

## 9.10 v1.1.7 补丁记录（2026-11-23）

- 参考 W3C ARIA22 与电商筛选无障碍实践，新增屏幕阅读器专用 live region（`#resultAnnounce`，`role="status"` + `aria-live="polite"` + `aria-atomic="true"`）：筛选、搜索或切换视图后，朗读「筛选后 N 本 · 年份」等结果数，500ms 节流避免连续输入时反复打断。
- 顶部视图标签（全部轻小说 / 我的阅读 / 阅读统计）随激活状态同步 `aria-current="page"`，`.tabs` 补充 `aria-label="主要视图"`，便于辅助技术识别当前所在视图。
- 新增 `.sr-only` 工具类，仅用于对屏幕阅读器可见的文本，不影响视觉布局。
- 版本与缓存：页脚、manifest、package.json 升至 1.1.7；SW 缓存名升到 `yuc-ln-shell-v10`。
- 测试：`check-data` 问题 0；`test-merge` 20/20；`verify` 138/138（新增 live region 属性、筛选播报内容、aria-current 3 项）。
- 来源：<https://w3c.github.io/wcag/techniques/aria/ARIA22>、<https://getadjustable.com/en/blog/e-commerce-accessibility-product-cards-filters-checkout>、<https://accessibility-test.org/blog/compliance/accessibility-for-e-commerce-product-filtering-and-faceted-search/>、<https://www.equalweb.com/academy/learn/lessons/live-regions.html>。

## 9.11 v1.1.8 补丁记录（2026-11-23）

- 参考 MDN 懒加载指南与 `content-visibility` 实践，`cardHtml` 依据当前视图计算封面 `sizes`：网格沿用响应式宽度，列表视图固定 `64px`、看板视图固定 `56px`，使浏览器只选 200w 小图，减少长列表封面流量与解码开销。
- `.card` 的 `contain-intrinsic-size` 追加 `auto` 关键字（保留原两值写法作兜底）：浏览器记住卡片实际渲染尺寸，长列表滚动时减少占位高度跳动。
- 版本与缓存：页脚、manifest、package.json 升至 1.1.8；SW 缓存名升到 `yuc-ln-shell-v11`。
- 测试：`check-data` 问题 0；`test-merge` 20/20；`verify` 141/141（新增列表 sizes、看板 sizes、渲染尺寸记忆 3 项）。
- 来源：<https://developer.mozilla.org/en-US/docs/Web/Performance/Guides/Lazy_loading>、<https://webperfclinic.com/article/css-content-visibility-rendering-performance-guide>、<https://handoff.design/css-performance/content-visibility/>。

## 9.12 v1.1.9 补丁记录（2026-11-23）

- 参考 Calibre-Web 的 typeahead 与 WAI-ARIA combobox 模式，搜索框输入两个字符后浮出书名 / 作者联想（最多 6 条，按书名前缀、原名前缀、作者命中、书名包含排序，按「标题 + 作者」去重）。
- 联想与「最近搜索」共用浮层：有输入时显示建议，空输入时显示历史；`作者:` 等字段语法或单字符输入不触发联想，避免遮挡筛选结果。
- 交互：↑/↓ 在建议间移动高亮（`aria-activedescendant`），回车或点击回填完整书名并写入搜索历史，回填后面板收起；焦点始终留在输入框。
- 无障碍：搜索框补 `role="combobox"`、`aria-autocomplete="list"`、`aria-haspopup="listbox"`、`aria-expanded`，建议列表使用 `listbox` / `option` 语义。
- 版本与缓存：页脚、manifest、package.json 升至 1.1.9；SW 缓存名升到 `yuc-ln-shell-v12`。
- 测试：`check-data` 问题 0；`test-merge` 20/20；`verify` 146/146（新增联想浮出、listbox 语义、combobox 语义、方向键高亮、点击回填 5 项）。
- 来源：<https://deepwiki.com/janeczku/calibre-web/6-external-integrations>、<https://accessibility.build/guides/accessible-combobox>、<https://www.w3.org/WAI/ARIA/apg/patterns/combobox/examples/combobox-autocomplete-list/>、<https://developer.mozilla.org/zh-CN/docs/Web/Accessibility/ARIA/Reference/Roles/combobox_role>。

## 9.13 v1.2.0 功能记录（2026-11-23）

- 参考 StoryGraph 的「平均读完用时」统计思路，阅读统计页新增「阅读节奏」卡片。
- 读完率：读完条目 ÷ 收藏总数，整数百分比。
- 平均读完天数：只统计同时有加入时间 `t` 与读完时间 `f` 的记录，按自然日取整后求平均，保留一位小数；无样本显示「—」，并在卡片底部注明参与统计的本数。
- 实现为纯函数 `readingPace(entries)` 并挂到 `window.__lnReadingPace`，便于验收直接断言边界数据。
- 版本与缓存：页脚、meta、manifest、package.json 升至 1.2.0；SW 缓存名升到 `yuc-ln-shell-v13`。
- 测试：`check-data` 问题 0；`test-merge` 20/20；`verify` 148/148（新增阅读节奏计算、统计页卡片展示 2 项）。
- 来源：<https://roadmap.thestorygraph.com/requests-ideas/posts/stat-pages-per-day-per-book>、<https://roadmap.thestorygraph.com/requests-ideas/posts/stat-average-time-to-finish-on-book-s-page->、<https://cjrthebrit.com/2026/06/04/storygraph-monthly-stats-may-2026/>。

## 9.14 v1.3.0 功能记录（2026-11-23）

- 参考 Kavita 的 Continue Reading 与 BookLore 的 Reading 书架，在「我的阅读」顶部新增「继续阅读」横向快捷条。
- 取数规则：只列状态为「在读」且已读卷数小于总卷数的书，按最近一次进度更新时间倒序，最多 8 本；有搜索词、状态筛选、批量模式或看板视图时隐藏，避免与当前视图重复。
- 交互：点封面或书名进入详情；点「＋1 卷」直接记录下一卷，读满后自动转为「读完」并移出快捷条。
- 实现为纯函数 `continueItems(items, mine, limit)` 并挂到 `window.__lnContinueList`，便于验收断言过滤与排序。
- 版本与缓存：页脚、meta、manifest、package.json 升至 1.3.0；SW 缓存名升到 `yuc-ln-shell-v14`。
- 测试：`check-data` 问题 0；`test-merge` 20/20；`verify` 151/151（新增过滤排序、快捷条渲染、一键加卷 3 项）。
- 来源：<https://wiki.kavitareader.com/en/guides/get-started-using-your-library>、<https://deepwiki.com/Kareadita/Kavita/1.2-key-features>、<https://apps.apple.com/uy/app/booklore-book-tracker/id6784735724>。

## 9.15 v1.4.0 功能记录（2026-11-23）

- 参考 StoryGraph 的 daily streak，阅读统计页新增「阅读打卡」卡片：连续天数、最长连续、近 7 天打卡格与今日状态。
- 记录方式：在标记状态、加入收藏、更新卷进度、保存评分 / 书评时写入当天日期（`yuc_ln_days_v1`，最多保留 400 天）；统计时再合并已有记录的更新时间 `u` 与读完时间 `f`，老用户无需额外操作也能看到历史连击。
- 续接规则：当天有记录从今天起算；当天还没记录但昨天有记录时，保留昨天为止的连击，避免一天未读就提前归零；两天以上空白才归零（与 StoryGraph 的可补记区间思路一致）。
- 实现为纯函数 `readingStreak(days, entries, now)` 并挂到 `window.__lnReadingStreak`，按本地日历增减天数，规避夏令时下 24 小时不等于一天的问题。
- 版本与缓存：页脚、meta、manifest、package.json 升至 1.4.0；SW 缓存名升到 `yuc-ln-shell-v15`。
- 测试：`check-data` 问题 0；`test-merge` 20/20；`verify` 155/155（新增连续天数计算、当天未打卡不归零、统计卡片与近 7 天、打卡日期落盘 4 项）。
- 来源：<https://roadmap.thestorygraph.com/changelog/streaks->、<https://roadmap.thestorygraph.com/features>、<https://thestorygraph.freshdesk.com/support/solutions/articles/79000145752-how-to-fix-your-streak>。

## 9.16 v1.5.0 功能记录（2026-11-23）

- 参考 StoryGraph / Goodreads 的书评管理，阅读统计页新增「我的书评」汇总卡：只列写过短评或笔记的收藏，按书评更新时间倒序显示最近 6 条。
- 每条显示书名、短评（无短评时取笔记）两行摘要、我的评分与日期；点击可直接打开对应详情，继续编辑书评。
- 底部说明记录总数与显示条数；没有书评时提示「在详情页写下短评或笔记后，会在这里汇总最近的记录」。
- 实现为纯函数 `recentReviews(entries, limit)` 并挂到 `window.__lnRecentReviews`，只读现有 `yuc_ln_mine_v1`，不新增存储键、不改同步协议。
- 版本与缓存：页脚、meta、manifest、package.json 升至 1.5.0；SW 缓存名升到 `yuc-ln-shell-v16`。
- 测试：`check-data` 问题 0；`test-merge` 20/20；`verify` 158/158（新增过滤排序、统计卡摘要、点击打开详情 3 项）。
- 来源：<https://roadmap.thestorygraph.com/fr>、<https://www.goodreads.com/genres/reference-on-my-shelves>、<https://roadmap.thestorygraph.com/requests-ideas/posts/confirmation-when-leaving-review-page-in-app>。

## 9.17 v1.5.1 功能记录（2026-11-23）

- 参考 web.dev 的 Manifest shortcuts 与 Chrome 安装体验建议，`manifest.webmanifest` 新增稳定 `id`、`categories` 与 3 个桌面快捷方式：我的阅读（`#tab=mine`）、阅读统计（`#tab=stats`）、高分佳作（`#tab=all&o=score`）。
- 快捷方式复用现有 hash 路由，不新增页面、不改数据与同步协议；长按已安装图标即可直接进入对应视图。
- 安装完成后监听 `appinstalled`：写入本会话提示标记并轻提示「已安装到主屏幕」，避免后续重复弹出安装引导。
- 版本与缓存：页脚、meta、manifest、package.json 升至 1.5.1；SW 缓存名升到 `yuc-ln-shell-v17`。
- 测试：`check-data` 问题 0；`test-merge` 20/20；`verify` 163/163（新增稳定 id、快捷方式数量/名称/hash 路由、安装完成收起引导 5 项）。
- 来源：<https://web.dev/articles/manifest-shortcuts>、<https://developer.mozilla.org/en-US/docs/Web/Manifest/id>、<https://developer.mozilla.org/en-US/docs/Web/API/Window/appinstalled_event>、<https://web.dev/articles/install-criteria>。

## 9.18 v1.5.2 功能记录（2026-11-23）

- 参考 Goodreads 的「Readers also enjoyed」、StoryGraph 的「Browse similar books」与 Bangumi 条目关联，详情页相似推荐从「同题材 + 评分接近」升级为带理由的排序：同作者 → 同书系 → 同题材 → 评分接近。
- 作者字段按 `/、,，&` 拆分为多人后逐个比对，合写作品也能命中「同作者」；仍只推荐同类型（轻小说 / 漫画 / 画集 / 指南）条目，避免跨类型噪声。
- 每张推荐卡新增推荐理由标签（靛蓝强调色），并保留评分与发售日；纯函数 `similarItems(item, limit, pool)` 挂到 `window.__lnSimilar`，可传入自定义候选池做验收。
- 未新增存储键、未改动同步协议与数据结构；只影响详情页渲染。
- 版本与缓存：页脚、meta、manifest、package.json 升至 1.5.2；SW 缓存名升到 `yuc-ln-shell-v18`。
- 测试：`check-data` 问题 0；`test-merge` 20/20；`verify` 165/165（新增推荐理由标签、纯函数排序与跨类型排除 2 项）。
- 来源：<https://www.goodreads.com/topic/show/23724468-2026-melissa-challenge-tracker>、<https://apps.apple.com/us/app/storygraph-reading-tracker/id1570489264>、<https://bangumi.github.io/api/>。

## 9.19 v1.5.3 功能记录（2026-11-23）

- 参考 WAI-ARIA APG 的 Modal Dialog 模式与 WCAG H102：详情弹窗打开时把 `body > header`、`body > main`、`body > footer` 与回到顶部按钮设为 `inert`，关闭时移除；`aria-modal` 从此与真实行为一致，键盘与屏幕阅读器都无法穿透到背景列表。
- `inert` 通过特性检测启用（`'inert' in HTMLElement.prototype`），不支持的老浏览器自动跳过，不报错、不影响原有焦点陷阱与 Esc 归焦。
- 移动端筛选抽屉此前只处理 Esc：本次补上 Tab / Shift+Tab 在面板内循环（复用 `trapModalTab`），关闭时若焦点仍在抽屉内则归还给筛选按钮。
- 未新增存储键、未改动数据与同步协议；只影响交互与焦点管理。
- 版本与缓存：页脚、meta、manifest、package.json 升至 1.5.3；SW 缓存名升到 `yuc-ln-shell-v19`。
- 测试：`check-data` 问题 0；`test-merge` 20/20；`verify` 169/169（新增详情背景 inert、关闭解除 inert、筛选抽屉焦点循环、关闭归还焦点 4 项）。
- 来源：<https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/>、<https://www.w3.org/WAI/WCAG21/Techniques/html/H102>。

## 9.20 v1.6.0 功能记录（2026-11-23）

- 参考 Goodreads 书页的星级分布条：统计页「我的评分」卡片在已评分数量与平均分下方新增 1–10 分分布柱，只突出实际使用过的分数，空档保留 2px 基线，保持石墨黑 + 靛蓝的工具风。
- 新增纯函数 `ratingDist(entries)`（挂到 `window.__lnRatingDist`）：只统计 1–10 分的有效评分，返回各档本数、已评分总数、平均分与最常给分；并列时取较高分数，避免把偏好说得更苛刻。
- 卡片补充一行摘要：最常给几分与已评分占收藏比例；无评分时提示去详情页打分。柱状容器带完整 `aria-label`（逐档读出「X 分 N 本」），视觉之外的读屏用户也能获取分布。
- 未新增存储键、未改动数据结构与同步协议；只影响统计页渲染。
- 版本与缓存：页脚、meta、manifest、package.json 升至 1.6.0；SW 缓存名升到 `yuc-ln-shell-v20`。
- 测试：`check-data` 问题 0；`test-merge` 20/20；`verify` 171/171（新增评分纯函数统计、统计页分布柱与偏好摘要 2 项）。
- 来源：<https://thepublishingtimes.com/blog/goodreads-half-quarter-star-ratings>、<https://apps.apple.com/gr/app/storygraph-reading-tracker/id1570489264>。

## 9.21 v1.7.0 功能记录（2026-11-23）

- 参考 Hikara 的 Up Next queue：统计页新增「想读队列」卡片，从「想读」里挑出 3 本，并逐本标注推荐理由——同作者在读 > 评分 ≥ 8 > 短篇（≤ 3 卷）> 加入最早。
- 新增纯函数 `upNextItems(items, mine, limit)`（挂到 `window.__lnUpNext`）：先收集在读条目的作者，再对想读条目分级；同分时按评分降序、加入时间升序，结果稳定可断言。
- 每条提供「开始读」按钮，点击复用 `setStatus(id, 'doing')`，条目随即移出队列并计入在读与打卡；点书名可打开详情。
- 队列为空时显示引导文案；未新增存储键、未改动数据结构与同步协议，只影响统计页渲染。
- 版本与缓存：页脚、meta、manifest、package.json 升至 1.7.0；SW 缓存名升到 `yuc-ln-shell-v21`。
- 测试：`check-data` 问题 0；`test-merge` 20/20；`verify` 174/174（新增队列排序理由、统计页渲染、开始读移出队列 3 项）。
- 来源：<https://hikara.io/features/tbr-queue>、<https://apps.apple.com/kz/app/goodreads-book-tracker-more/id355833469>。

## 9.22 v1.7.1 功能记录（2026-11-23）

- 高级搜索新增 `评:` 字段（别名 `评语:` / `笔记:` / `note:` / `review:`），在「我的阅读」中按短评与笔记正文检索；未收藏条目自然排除。
- 搜索占位与帮助面板同步补充说明。
- 版本与缓存：页脚、meta、manifest、package.json 升至 1.7.1；SW 缓存名升到 `yuc-ln-shell-v22`。
- 测试：`check-data` 问题 0；`test-merge` 20/20；`verify` 175/175（新增书评正文搜索 1 项）。

## 9.23 v1.7.2 功能记录（2026-11-23，第 20 轮）

- 统计页新增「年度小结」卡片：`yearSummary()` 汇总当年读完本数、已读卷数、平均评分、最常读作者、题材 Top5 与读完书目（最多 30 本），导出为 Markdown。
- 纯函数挂载 `window.__lnYearSummary`，便于验收与调试；导出复用 `download()`，文件名 `轻小说年度小结-YYYY.md`。
- 参考：Goodreads「Year in Books」年度回顾的分享形态（<https://readingszone.com/my-year-in-books/>、<https://thereadinglane.com/2025/12/28/rear-in-books-goodreads-2025/>）。
- 版本与缓存：页脚、meta、manifest、package.json 升至 1.7.2；SW 缓存名升到 `yuc-ln-shell-v23`。
- 测试：`check-data` 问题 0；`test-merge` 20/20；`verify` 177/177（新增年度小结导出 2 项）。

## 9.24 v1.8.0 功能记录（2026-11-23）

- 数据：`clean-series.mjs` 新增父系列→子卷索引；415 个系列写入 `ch`，共 2028 条子卷引用，覆盖全部子卷；`check-data` 新增索引完整性与归属校验。
- 详情：系列条目新增「加入全部 N 卷 / 加入其余 N 卷」按钮，一键把子卷以「想读」加入；已存在条目保持原状，全部加入后按钮置灰显示「已加入全部 N 卷」；详情元信息增加「系列子卷」数量。
- 数据体积 4007 条约 1.16 MB（新增索引约 20 KB）。
- 版本与缓存：页脚、meta、manifest、package.json 升至 1.8.0；SW 缓存名升到 `yuc-ln-shell-v24`。
- 测试：`check-data` 问题 0；`test-merge` 20/20；`verify` 181/181（新增子卷索引 1 项、一键加入 3 项）。

## 9.25 v1.9.0 性能优化记录（2026-11-23）

- 拆包：`data/light-novels.js` 只保留首屏字段（960 KB，gzip 268 KB）；作者、插图、出版社、书系移入 `data/light-novels-extra.js`（370 KB，gzip 60 KB）。
- 按需加载：打开详情、进入统计、导出 CSV/Markdown、搜索含 `作者:` / `出版社:` / `书系:` 时注入 `light-novels-extra.js`，合并进同一份数据对象后重渲染。
- 封面：数据只存相对路径（`pic/cover/...`），页面启动时补全 `https://bgmimg.anibt.net/r/400/`；网格仍走 `r/200` srcset。
- 首屏：先渲染 60 张卡片，`requestIdleCallback` 补齐到 240；旧渲染任务用序号作废，避免重复插入。
- 首包对比：数据由 1.43 MB / gzip 373 KB 降到 960 KB / gzip 268 KB（-28%）；详情包按需再取 60 KB。
- 版本与缓存：1.9.0；SW `yuc-ln-shell-v25` 预缓存核心包与详情包。
- 测试：`check-data` 0 问题（新增拆包与封面路径校验）；`test-merge` 20/20；`verify` 183/183（新增首屏未加载详情包、按需加载合并 2 项）。
- 未改托管：GitHub Pages 国内带宽仍是主要瓶颈，后续可迁 Cloudflare Pages / Vercel。

## 9.26 v1.10.0 数据扩容记录（2026-11-23）

- 数据：`fetch-books.mjs` 改为同时抓取「轻小说」与「小说」两个标签，合并去重后 4815 条（轻小说 4092 / 一般小说 723）。分页缓存按标签分文件：`page-novel-*.json`；元信息 schema 升为 `tag-partitions-v2`。
- 来源标记：只在「小说」标签出现、没有「轻小说」标签的条目标记 `gn: true`；与轻小说系列存在「单行本」关联的条目自动保留为轻小说，共修正 83 条。
- 清洗修正：父系列不在库内的子卷不再标记 `c`；标题兜底产生的子卷会补进所属系列的 `ch` 索引，保证 `chRefs === c`。
- UI：新增「含一般小说」开关（默认关闭），全库浏览与搜索默认排除 `gn`；开关状态写入 hash / 偏好 / 视图；详情显示「收录：一般小说」；数据提示显示「共 N 本轻小说 · 另有 M 本一般小说」。
- 体积：核心包约 1.13 MB，详情包约 427 KB（4815 条）。（v1.11.0 后核心约 1.23 MB，新增卷包约 1.35 MB）
- 校验：`check-data` 0 问题（新增 `gn` 类型与 `meta.general` 一致性校验）；`test-merge` 20/20；`verify` 186/186（新增一般小说合并、默认排除、开关恢复 3 项）。
- 外部源调研：AniList `format:NOVEL` 共抓到 10,630 条，按标题精确匹配 1,102 条、覆盖本地 1,074 条；未匹配的高热度条目多为繁简差异或带副标题的同一作品，适合做别名补充而非直接合并。openBD / NDL 适合按 ISBN 补日文书系与发行日；RanobeDB 有 55,627 条书籍记录但无公开 API（ODbL），只能人工或授权导出。

## 9.27 v1.11.0 系列补卷记录（2026-11-23）

- 阶段 1 审计：核心 4815 条，单卷 ISBN 覆盖 94.0%，系列 ISBN 仅 1.4%；文库标签缺口仅 6 条；系列关联去重后缺 8643 条（单行本 7240 / 番外篇 344）。报告见 `reports/jp-audit-2026-11-23.md`。
- 补卷：`buildMissingVolumes` 从 `rel-*.json` 提取「单行本」「番外篇」中不在库内的记录，限定父系列为日本轻小说（非 `gn` 且标题含假名），共 7584 卷。
- 数据：卷包 `data/light-novels-volumes.js` 约 1.35 MB，只存 id、标题、封面相对路径、拼音与必需布尔字段；核心包 `ch` 引用卷 ID，核心体积基本不变。
- UI：`loadVolumes()` 按需注入卷包并合并进 `DATA`；展开子卷、打开统计、一键加入全部子卷、应用含子卷视图时触发；首屏与服务端 SHELL 都不下载卷包。
- 校验：`check-data` 新增卷包结构、重复 ID、封面路径、ch 引用完整性校验；`verify` 新增首屏未加载卷包、按需合并、SW 不预缓存卷包 3 项，共 189 项。

## 9.28 v1.12.0 openBD 日文书志补全（2026-11-23）

- ISBN：`fetch-books.mjs` 从 infobox 提取 ISBN-10/13，`clean-series.mjs` 统一转 13 位并做校验，非法值直接丢弃；当前核心 5076 条中 3490 条有有效 ISBN，另有 906 条系列首卷 ISBN。
- openBD：`scripts/enrich-openbd.mjs` 按 100 个 ISBN 一批查询 `api.openbd.jp`，结果按 ISBN 缓存在 `data/build/openbd/`；查询 3355 条、命中 3034 条。
- 字段：补书系 979 条、出版社 3 条；`jd` 写入日文版发售日（YYYY-MM / YYYY-MM-DD），共 2950 条。当前书系覆盖 3595 条、出版社 4793 条。
- UI：详情新增 ISBN 与「日文版」两项；`isbn`、`jd` 仍放在详情包，首屏不下载。
- 校验：`check-data` 增加 ISBN-13 校验和、日文版日期格式；`verify` 增加 ISBN 与日文版发售日覆盖 2 项，共 191 项。

## 9.29 v1.13.0 书系筛选与 RanobeDB（2026-11-23）

- 书系筛选：`#lineFilter` 首次点击时才调用 `loadExtra()` 并生成前 80 个高频书系；`state.line` 写入 hash（`ln=`）与偏好；清除筛选会一并重置。
- ISBN 反查：NDL / Google Books 在当前网络不可达，改用 RanobeDB 公共 API v0（`/api/v0/releases`，60 次/分钟以内）。`scripts/find-isbn-ranobedb.mjs` 查询热度前 300 条缺 ISBN 条目，累计补 11 个单册 ISBN、226 个系列首卷 ISBN；匹配时优先完全同名，并排除 AA / SP / 公式指南等外传。
- 字段：新增 `fisbn`（系列首卷 ISBN），详情显示「首卷 ISBN」；校验逻辑与 `isbn` 相同。
- 校验报告：`scripts/validate-ranobedb.mjs` 抽样热度前 120 个系列（只接受完全同名），匹配 50 个：卷数一致 34、我们更多 11、RanobeDB 更多 5。复核后确认 2 个真实漏卷（8691 `encore pieces`、16868 `『i』`），已写入 `data/manual-relations.json`；史莱姆差异是上/中/下拆分版本，零之使魔多出的是 Memorial BOOK，均不新增。报告写入 `reports/ranobedb-validate-2026-11-23.md`。
- 验收：`verify` 新增书系筛选、首卷 ISBN 覆盖 2 项，共 193 项。

## 9.30 v1.13.1 RanobeDB 差异复核（2026-11-23）

- 逐条复核“RanobeDB 更多”的 5 个系列：2 个真实漏卷（8691 `encore pieces`、16868 `『i』`）已通过 `data/manual-relations.json` 加入；史莱姆 46 条是上/中/下拆分版本，零之使魔第 23 项是 Memorial BOOK，均不新增。
- `buildData` 在标记子卷前合并人工关系；若同一 ID 已有非「单行本」关系，会额外补一条「单行本」边。
- 当前子卷 2160 条，默认可见轻小说 1902 条；卷包 7617 条不变。
- 验收仍为 193/193。

## 9.31 v1.14.0 重复版本与册/故事卷（2026-11-23）

- 构建时按规范化日文标题分组同名系列，保留 `ch` 最多、收藏最高的为主条目；其余 79 条写入 `ver: 主条目ID`。不删除数据，`ch` 仍保留。
- UI：`state.showVersions` 默认 false，`baseList` 过滤 `ver`；工具栏新增「显示重复版本」，写入 hash `dup=1`、偏好与视图；详情显示「重复版本，主条目：…」。
- 统计：构建时计算每个系列的 `chs`（上/中/下折合故事卷）和全局 `physicalVolumes` / `storyVolumes`；当前 9777 册 → 9685 故事卷。详情显示「N 册 / M 故事卷」，统计页新增「库内规模」卡片。
- 校验：`check-data` 增加 `ver` 指向、`chs` 范围、全局册/故事卷一致性；`verify` 增加拆分统计、版本默认隐藏与切换 2 项，共 195 项。

## 9.32 v1.15.0 RanobeDB 扩展书目（2026-11-23）

- 新增 `scripts/build-ranobedb.mjs`：从 RanobeDB 全量目录筛选日文原名、≥2 卷、与 Bangumi 标题去重的系列，生成 `data/light-novels-rn.js`；当前 8487 个系列 / 31254 卷，ODbL 授权。
- 扩展条目使用 `rn: true` 与 `rid`，ID 预留 `800000000 + rid`；`sv: true` 但无 `ch`，不参与系列子卷统计。UI 默认隐藏，`state.showRn` 控制，hash `rn=1`、偏好与视图均保存；打开开关才下载 2.38 MB 扩展包。
- 详情：扩展条目显示日文原名 / 英文名、册数、起始发售日、RanobeDB 链接与 ODbL 来源；不显示 Bangumi 评分与排名。
- 补卷：`scripts/fill-ranobedb-volumes.mjs` 精确同名匹配 RanobeDB，生成 `data/ranobedb-volume-fixes.json`；当前 10 个系列 / 22 卷，卷 ID 预留 `810000000 + book.id`，由 `clean-series.mjs` 合并进卷包并写入父系列 `ch`。
- 清洗：`buildData` 重建时从现有 extra 文件回填 openBD / RanobeDB 已补字段，避免 `clean-series` 覆盖 ISBN 与日文版日期。
- ISBN：继续用 RanobeDB 回填日文条目，单册 ISBN 3364 条不变，系列首卷 ISBN 从 216 补到 421 条；脚本每 20 条写回，可中断续跑。
- 校验：`check-data` 增加扩展包结构、ID / rid、日期、来源授权与 `meta` 一致性检查；`verify` 增加扩展书目默认隐藏、按需加载、关闭恢复、详情链接与 SW 不预缓存 4 项，共 199 项。

## 9.33 v1.15.1 首屏核心拆包（2026-11-23）

- 构建：`clean-series.mjs` 除完整核心外，额外输出 `data/light-novels-lite.js`（默认可见 1925 条）与 `data/light-novels-rest.js`（子卷 / 一般小说 / 重复版本 2926 条）。
- 加载：页面只同步加载 lite 包；`loadRest` 在首屏渲染 3 秒后后台补载，搜索、统计、我的阅读、展开子卷、版本开关等交互会主动触发补载。
- 体积：首屏核心 gzip 约 369 KB → 194 KB（约 -47%）；剩余核心 gzip 约 178 KB，不阻塞首屏。
- 缓存：SW 预缓存 lite + 详情包；rest、卷包、扩展书目走运行时缓存，离线重开仍能加载全库。
- 校验：`check-data` 校验 lite + rest 无重复、无缺失、划分正确；`verify` 增加首屏轻量核心、首屏未加载剩余核心、剩余核心按需加载 3 项，共 203 项。
- 版本 1.15.1，SW `yuc-ln-shell-v33`。

## 9.34 v1.15.2 扩展书目中文名映射（2026-11-23）

- 脚本：新增 `scripts/link-ranobedb-cn.mjs`，支持 `--shard/--shards` 分片、`--merge` 合并、标题哈希缓存（`data/build/ranobedb-cn-pilot/search/`，中断续跑）、`blocklist.json` 人工剔除。
- 匹配：Bangumi `/v0/search/subjects` 按日文原名查询；完全同名 > 包含 > 二元组 Dice ≥0.82；年份容差同名 ±5、其余 ±3；排除单卷条目、外传挂正传、卷数严重不符；小说源优先、漫画源降权。
- 结果：8487 条全量，命中 240 条（2.8%），命名 207 完全同名 / 28 包含 / 5 近似；漫画源 226 条。人工复核剔除 6 条错配，清单见 `data/build/ranobedb-cn-pilot/blocklist.json`。
- 应用：`build-ranobedb.mjs` 读取 `data/ranobedb-cn.json`，写入 `cn` / `bgm`，`py` 改用中文名首字母；`LN_RN_META` 增加 `cnMapped`。
- 校验：`check-data` 增加 cn 非空、cn≠日文原名、bgm 正整数、`meta.cnMapped` 与实际一致；`verify` 增加「扩展条目可用中文名搜索」1 项，共 204 项。
- 生效口径：扩展书目默认隐藏，中文名只在用户开启「显示扩展书目」后参与显示与搜索；默认 1925 条不受影响。
- 版本 1.15.2，SW `yuc-ln-shell-v34`。

## 9.35 v1.15.3 扩展书目详情与导入修复（2026-11-24）

- 详情抓取：新增 `scripts/fetch-ranobedb-detail.mjs`（`--shard/--shards/--limit/--delay`），抓 RanobeDB `/series/{id}` 的作者（`staff.role_type=author`）、出版社（`publishers.type=publisher`，优先日文版）、文库（`type=imprint`），只保留必要字段缓存在 `data/build/ranobedb-series-detail/{rid}.json`，可中断续跑。全量 8487 个系列，6 分片约 34 分钟。
- 数据：`build-ranobedb.mjs` 读取详情缓存，为条目写入 `au` / `pub` / `line`；覆盖 8468 作者 / 8484 出版社 / 8232 文库。`LN_RN` 原始体积 +613 KB、gzip +138 KB（581 → 719 KB），仅用户开启扩展书目时下载。
- 导入修复：`importBtn` / `fileInput` 的合并逻辑改为先 `loadRest()` 再合并。修复前，剩余核心（子卷 / 一般小说 / 重复版本）尚未补载时会被当成「无效记录」直接跳过并永久丢失；慢网（40 KB/s + 600ms 延迟）实测修复后正确写入「新增 1 本」。
- 深链修复：`hashchange` 命中剩余核心条目时补 `loadRest()`，不再依赖 3 秒定时器。
- ISBN：`find-isbn` 续跑 653 条，系列首卷 ISBN 从 421 补到 850 条，单册 3364 → 3367，任一 ISBN 覆盖 3785 → 4217（87%）。
- 中文名：新增 `--fallback` 变体查询（去副标题 / 去尾括号 / 去「シリーズ」），全量补查 375 次，命中 0 条——变体召回的多是别部作品，匹配器已正确拒绝；保留开关备用。
- 脚本健壮性：分片状态文件增加 `shards` 校验，合并按 `rid` 去重，避免换分片数后重复计数。
- 校验：`check-data` 增加 au / pub / line 类型断言，问题总数 0；`test-merge` 20/20；`verify` 增加「扩展条目详情显示作者」，共 205 项。
- 版本 1.15.3，SW `yuc-ln-shell-v35`。

## 9.36 v1.15.4 中文名扩容：接入 RanobeDB 官方中文标题（2026-11-24）

- 探索：Bangumi 对冷门书目覆盖 ~2.8% 已是瓶颈。对比三个候选源——RanobeDB 详情自带官方多语言标题（抽样约 3%，与 Bangumi 重叠极低，各 1/40）；Wikidata 仅 8% 系列有 ID 且查询接口慢；均无更高上限，选 RanobeDB。
- 抓取：`fetch-ranobedb-detail.mjs` 缓存结构加入 `titles`（多语言标题）并支持 `--refresh` 整体重抓，8487 个系列约 31 分钟。
- 构建：`build-ranobedb.mjs` 引入 `opencc-js`（devDependency）做繁→简转换；优先级 Bangumi 中文名 > RanobeDB 官方标题；中文标题必须含汉字（过滤「JK」这类音译缩写）。
- 结果：中文名 240 → **310 条（3.7%）**，其中 RanobeDB 官方 70 条（`meta.cnFromRanobedb`）；70 条逐一人工核对，均为官方译名，无错配。gzip 719 → 721 KB。
- 校验：`check-data` 0、`test-merge` 20/20、`verify` 205/205。
- 版本 1.15.4，SW `yuc-ln-shell-v36`。

## 9.37 v1.15.5 缺失日期与系列字段补全（2026-11-24）

- 审计：核心 4851 条中缺日期 235、作者 106、出版社 58、插图 1158、书系 1256、封面 2；ISBN 634 条已由 RanobeDB 查尽。
- 外部核实：新增 `scripts/enrich-bgm-detail.mjs`，按 900ms 间隔查询 Bangumi 详情，342 条目标全部缓存到 `data/build/bgm-subject/`；结果日期命中 125/235，作者 0/106、出版社 0/58、封面 0/2——后三者详情页同样为空，确认是上游缺失。
- 日期精度：125 条中 47 条只有年、66 条到月、12 条完整日期；`d` 允许 `YYYY` / `YYYY-MM` / `YYYY-MM-DD`，页面用 `dateText()` 显示「YYYY 年」「YYYY 年 M 月」，不臆造具体日。13 条明代 / 清代 / 多版本日期保持缺失。
- 本地继承：`clean-series.mjs` 新增「子卷→系列」共识继承（书系 8 / 插图 18 / 作者 12 / 出版社 4 / 首卷日 14 / 封面 0）与「重复版本」作者 / 插图继承（0 / 3）；只填空字段，不覆盖已有值。
- 结果：缺日期 235→96、作者 106→94、出版社 58→54、插图 1158→1137、书系 1256→1248；封面仍 2 条（上游无图）。
- 候选固化：`data/bgm-detail-fills.json` 随仓库提交，`clean-series` 重建时自动读取；原始详情缓存不提交。
- 校验：`check-data` 0、`test-merge` 20/20、`check-deploy` 通过、`verify` 205/205。
- 版本 1.15.5，SW `yuc-ln-shell-v37`。

## 9.38 v1.15.6 子卷索引拆包（2026-11-24）

- 首屏减负：`ch` 从 lite / rest 移除，单独生成 `data/light-novels-ch.js`（1071 个系列 / 9799 条引用，95,721 B，gzip 34,442 B）；完整核心仍保留 `ch` 供构建与校验。
- 体积：lite 554,377 → **469,286 B**（gzip 191,748 → **153,492 B，约 -20%**）；rest 689,394 → 682,633 B（gzip 170,490 B）。
- 运行时：新增 `loadCh()`，打开系列详情或一键加入子卷时加载并合并；`loadRest` 合并剩余核心时同步补 `ch`；`ln-ch-ready` 重渲染当前详情。
- PWA：SW `SHELL` 加入 `./data/light-novels-ch.js`，缓存名升到 `yuc-ln-shell-v38`，离线打开系列详情仍可用。
- 校验：`check-data` 新增索引包与完整核心 `ch` 的逐条一致性、系列归属、重复检查；`check-deploy` 运行时白名单加入 ch 包。
- 验收：`verify` 首屏断言不加载 ch 脚本；加载 rest/volumes/extra 后补载 ch，再校验 `chSeries` / `chRefs` 完整。
- 结果：`check-data` 0、`test-merge` 20/20、`check-deploy` 通过、`verify` 206/206。
- 版本 1.15.6，SW `yuc-ln-shell-v38`。

## 9.39 v1.15.7 封面 100w 档（2026-11-25）

- 实测封面：`r/100` 4.6 KB / `r/200` 15.0 KB / `r/400` 48.7 KB；`r/300` 不存在（返回 400）。
- `coverSrcset()` 改为三档 `100w / 200w / 400w`；列表（`sizes=64px`）与看板（`56px`）在 1x 屏取 100w，2x 屏取 200w，网格与详情行为不变。
- 继续阅读、想读队列的小缩略图从 `r/200` 改 `r/100`。
- 验收：列表 / 看板断言同时校验 `sizes` 与 srcset 含 `100w`，总项数仍 206。
- 结果：`check-data` 0、`test-merge` 20/20、`check-deploy` 通过、`verify` 206/206。
- 版本 1.15.7，SW `yuc-ln-shell-v39`。

## 9.40 v1.16.0 系列卷清单与自动进度（2026-11-25）

- 系列详情新增「卷清单」：默认折叠，标题显示「已读 X / N」与进度条；展开时补载剩余核心与卷包，逐卷显示标题、发售日与勾选状态。
- 自动进度：勾选一卷即写入该卷的「读完」记录；系列条目自动汇总已读卷数，全部子卷读完转「读完」，取消勾选回退为「在读 / 想读」。系列不在阅读列表时，首次勾选会自动加入。
- 辅助操作：「标记下一卷已读」按卷号 / 发售日顺序取第一条未读；卷号从标题（第 N 卷 / (N) / 上中下）提取，缺失时按发售日与 ID 排序。
- 复用 `ch` 索引包：打开系列详情加载 ch；展开卷清单时再加载 rest 与卷包，不增加首屏负担。
- 验收：`verify` 新增 3 项（卷清单显示、展开加载、勾选与下一卷自动进度），共 209 项。
- 结果：`check-data` 0、`test-merge` 20/20、`check-deploy` 通过、`verify` 209/209。
- 版本 1.16.0，SW `yuc-ln-shell-v40`。

## 9.41 v1.17.0 卷清单封面与卡片入口（2026-11-25）

- 卷清单每行新增 36×48 封面缩略图（`r/100`），无图时显示书名首字占位；懒加载，不一次性拉全。
- 系列卡片新增「子卷」按钮（`data-act="vols"`），点击直接打开详情并展开卷清单；按钮只在有 `chn` 子卷的系列上出现。
- 数据新增 `chn`（子卷数），lite / rest 携带，完整核心同时保留 `ch`；`check-data` 校验 `chn` 与 `ch` 一致。
- 顺带修正 rest / 卷包条目封面路径未补域名的问题，卡片与卷清单缩略图均可正常显示。
- 验收：`verify` 新增 3 项（卡片入口、入口直接展开、卷清单封面），共 212 项。
- 结果：`check-data` 0、`test-merge` 20/20、`check-deploy` 通过、`verify` 212/212。
- 版本 1.17.0，SW `yuc-ln-shell-v41`。

## 9.42 v1.18.0 同步状态面板与合并统计（2026-11-25）

- 同步弹窗新增状态摘要：连接状态、上次同步时间、待同步改动数、最近合并结果、最近 6 条同步记录（本地保留 20 条）。
- `mergeRemoteState` 增加可选统计对象，记录新增 / 远端较新 / 本地较新 / 同时更新 / 进度合并 / 墓碑删除；原有调用与返回值不变。
- 日志键 `yuc_ln_synclog_v1`，只存时间、结果与计数，不存书名或书评；同步成功 / 失败都会写入。
- 常驻同步状态追加「待同步 N」；`bumpDirty` / `markBackup` 时实时刷新面板。
- 验收：`test-merge` 新增 1 项合并统计，共 21 项；`verify` 新增 1 项面板断言，共 213 项。
- 结果：`check-data` 0、`test-merge` 21/21、`check-deploy` 通过、`verify` 213/213。
- 版本 1.18.0，SW `yuc-ln-shell-v42`。

## 9.43 v1.19.0 本地纠错与别名（2026-11-25）

- 详情页新增「本地纠错」面板：中文名 / 原名 / 作者 / 插图 / 出版社 / 书系 / 发售日 / 别名；日期接受 `YYYY`、`YYYY-MM`、`YYYY-MM-DD` 与「2019年5月3日」写法并归一。
- 覆盖只存本机 `yuc_ln_meta_v1`：`{ 字段, al: [别名], clr: [清空字段], u }`；`sanitizeMeta` 校验日期、去重别名（≤8）、保留清空标记。
- 覆盖在 `adoptData` 与每个数据包（rest / volumes / extra / rn）写入时套用；详情包后到时先把上游值记进 `__mo_applied` 再压上覆盖，「恢复上游」可还原。
- 别名与书名 / 原名 / 作者同档参与搜索与相关度排序；详情显示「别名」与「本地」已纠错标记。
- JSON 导出与 Gist payload 升到 version 3，新增 `meta` 一节，按 `u` 双向合并；version 2 客户端会忽略该节，收藏记录仍互通。同步日志新增「纠错 N 条」。
- 验收：`test-merge` 新增 3 项（纠错合并、较新优先、字段清洗），共 24 项；`verify` 新增 5 项（纠错面板、保存覆盖、别名搜索、刷新保留、恢复上游），共 218 项。
- 结果：`check-data` 0、`test-merge` 24/24、`check-deploy` 通过、`verify` 218/218。
- 版本 1.19.0，SW `yuc-ln-shell-v43`。

## 9.44 v1.20.0 格式与藏书（2026-11-25）

- 阅读记录新增 `fm`（paper / ebook / web / audio，空为未标记）、`ow`（藏书 0/1）与 `mu`（格式 / 藏书更新时间）。
- 详情页收藏后出现「格式」行：纸质 / 电子 / Web / 有声 / 未标记 + 「藏书」切换；修改即写记录、刷新列表与详情。
- 「我的阅读」新增格式下拉与「只看藏书」，支持 chips 单独移除、hash 与偏好记忆、保存视图；`clearFilters` 一并重置。
- 合并：格式与藏书整体按 `mu` 取新——旧客户端不带 `formatUpdatedAt` 时不会冲掉本地标记；本地未标记时接受远端标记。
- payload 升 version 4，新增 `format` / `owned` / `formatUpdatedAt`；CSV 与 Markdown 导出补「格式」「藏书」两列。
- 统计页新增「藏书与格式」卡片：藏书数 + 四类格式计数与未标记提示。
- 验收：`test-merge` 新增 4 项（远端写入、本地较新、旧客户端、显式取消），共 28 项；`verify` 新增 4 项（标记、格式筛选、只看藏书、统计卡片），共 222 项。
- 结果：`check-data` 0、`test-merge` 28/28、`check-deploy` 通过、`verify` 222/222。
- 版本 1.20.0，SW `yuc-ln-shell-v44`。

## 9.45 v1.21.0 数据刷新与 ISBN 补全（2026-11-25）

- `fetch-books.mjs --refresh-pages` 重抓全部分页：核心 4851→5076（+231 新增，6 条上游已改标「漫画」而移除），轻小说 4201 / 小说 3427 去重后一般小说 788；系列 1306→1394，子卷 2160→2223，默认可见 1925→2026。
- 卷包 7639→7817；子卷索引 1071→1128 个系列 / 9799→10040 条引用。
- RanobeDB `find-isbn` 查询 285 条缺 ISBN 的日文条目：补 57 个系列首卷 ISBN（850→906），单册无新增；任一 ISBN 覆盖 4217→4396 条（86.6%）。
- `enrich-detail` 复查 143 条缺字段条目，上游仍为空（候选 0）；同时修复增量运行会用空结果覆盖既有 `bgm-detail-fills.json` 的问题，现在先载入旧候选再合并。
- 修复 `clean-series` 离线重算丢失「与轻小说系列关联的一般小说」修正的问题：新抽出 `adjustGeneralFlags`，重算后 87 条不再被误判为 `gn` 隐藏（此前仅在在线抓取时执行）。
- 新增验收：`check-data` 0；`test-merge` 28/28；`check-deploy` 通过；`verify` 222/222（数据条数断言全部动态跟随 `LN_META`）。
- 结果：核心 5076、卷包 7817、合计 12893；缺日期 113 / 作者 101 / 出版社 60 / 插图 1205 / 书系 1396 / 封面 2。
- 版本 1.21.0，SW `yuc-ln-shell-v45`。

## 9.46 v1.22.0 数据补全（2026-11-25）

- `enrich-openbd` 扩展到系列首卷 ISBN：此前只处理 `isbn`，906 个只有 `fisbn` 的系列从未查过 openBD。改为 fisbn 也作为目标后，查询 651 个新 ISBN（批量 100/次），补书系 307、日文版首发 968、出版社 3。
- 新增 `scripts/enrich-bgm-persons.mjs`（`npm run enrich-persons`）：走 `/v0/subjects/{id}/persons`，relation 为中文「插图 / 作者 / 出版社 / 书系」，无鉴权无分页；查询 1223 条（缺插图或作者），空数据 330，补插图 126、作者 69、出版社 2、书系 3。缓存 `data/build/bgm-persons/`，每 25 条写回，可中断续跑。
- 新增 `scripts/fill-ranobedb-counts.mjs`（`npm run fill-counts`）：离线读 `data/build/ranobedb-catalog/`，按 `title_orig` 精确同名匹配 1449 条，补 719 条缺失册数与 15 条首发日，产物 `data/ranobedb-counts.json`（已加入部署排除，19 项）。册数取 `max(RN 卷数, chn)`，避免比实际子卷少而提前触发「读完」。
- 缺口变化：作者 101→32、插图 1205→1079、书系 1396→1086、出版社 60→55、日期 113→98、未知册数 3910→3191；日文版首发 2950→3918。
- 调研结论（未采用）：NDL Search 无 key 可查、支持 ISBN 反查文库名与近两年新书，但标题检索对新刊有盲区且需本机代理，抽样 ISBN 反查仅 1/8 有 `seriesTitle`；Google Books 匿名配额 429 且官方要求 key；RanobeDB release 缓存无 imprint，补不了书系。
- 验收：`check-data` 0、`test-merge` 28/28、`check-deploy` 通过（19 项排除）、`verify` 222/222。
- 版本 1.22.0，SW `yuc-ln-shell-v46`。

## 9.47 v1.23.0 卷包日期与中文名试点（2026-11-26）

- 新增 `scripts/enrich-volume-dates.mjs`（`npm run enrich-volumes`）：逐卷查 `/v0/subjects/{id}`，补卷包发售日与缺失封面；3 并发 + 900ms 间隔，缓存复用 `data/build/bgm-subject/`，`checked` 记录已查 ID 可续跑。结果：查询 7693 条，补发售日 7644、封面 2，缺日期 7798→54（49 条上游无数据 / 404）。
- 新增 `scripts/fill-bgm-cn.mjs`（`npm run fill-cn`）：中文名两条来源——RanobeDB 系列详情的繁中标题（离线、opencc 转简体，命中 0）、Bangumi 搜索同名条目（要求日文原名完全一致且对方有 `name_cn`）。试点 300 条查询命中 20 条，累计候选 23 条，产物 `data/cn-fills.json`；缺中文名 2101→2078。
- 新增 `scripts/enrich-ndl.mjs`（`npm run enrich-ndl`）：NDL Search OpenSearch 补 ISBN / 文库名 / 首发日，带 curl 代理与 429 退避。**当前网络不可达**：直连与 IPv4 均超时，`iss.ndl.go.jp` 303 跳转到被墙的 `ndlsearch.ndl.go.jp`，本机 7897 代理未运行；脚本已就绪，代理恢复后可直接跑。
- `clean-series` 新增 `cn-fills` 与 `volume-fills` 应用；部署排除增至 21 项（新增 `data/volume-fills.json`、`data/cn-fills.json`）。
- 验收：`check-data` 0、`test-merge` 28/28、`check-deploy` 通过（21 项排除）、`verify` 222/222。
- 版本 1.23.0，SW `yuc-ln-shell-v47`。

## 9.48 v1.23.1 修复加载期搜索假报「没有找到」（2026-11-26）

**缺陷**：首屏 lite 2026 本、rest 3050 本后台补。补齐前搜索未命中的书直接进 `renderEmptyRecovery()`，输出确定性否定「没有找到」；`loadRest()` 的 `onerror` 只做 `restLoading=null; resolve()`，失败与成功无法区分。

**复核结论（与提交的 BUG 报告有三处出入，已实测确认）**：

1. **不是「就绪后不重绘」**。`ln-rest-ready` 监听器注册在脚本顶层（3649 行附近），早于底部启动逻辑（9466 行附近的 `render()` 与 `loadRest`），事件不会丢；`onload` 里 `render()` 也确实生效。实测 rest 到位后结果自动从 0 变 1。
2. **报告选的复现用例 `銃×石`（702088）不成立**。该条 `gn:true`（一般小说），默认口径下**全库加载完成后同样搜不到**，属正确行为。
3. **`rest` 分片 3050 条全部默认隐藏**（788 一般小说 + 2223 子卷 + 79 重复版本，默认可见 0 条）；`lite` 2026 条恰好等于全部默认可见书目。因此「加载期 60.1% 的书搜不到」在**默认口径下不成立**。真实影响面是：打开了「含一般小说 / 显示子卷 / 显示重复版本」、或有已收藏记录落在 rest 分片的用户。

**真实缺陷（确认并修复）**：`rest` 加载失败时静默降级，搜索仍报「没有找到」，页脚也一直停在「正在加载全库…」，用户无法区分「网络挂了」与「书不存在」。

**改动（均在 `index.html`）**：

- 新增 `restFailed` / `restAttempts` 状态；`onerror` 置 `restFailed=true`、`window.__lnRestFailed=true` 并派发 `ln-rest-failed`。
- 空结果分支在 `state.hideChildren` 之后、`DATA.length` 之前插入 `!fullReady` 分支：失败时「全库数据加载失败 · 当前只搜了首屏 N 本 · 重新加载」，加载中时「全库数据正在加载 · 已加载 N 本，完成后会自动刷新结果」。
- `onload` 在 `resolve()` 前补 `if (state.q.trim()) render()` 兜底，不依赖事件监听时序。
- 新增 `ln-rest-failed` 监听与 `#retryRest` 重试入口（空结果区内委托）；重试第 3 次起才带 `?v=` 时间戳——前两次仍走原地址，避免破坏 Service Worker 的缓存优先策略导致离线重试永远失败。
- `updateDataHint()` 区分失败态，页脚不再无限显示「正在加载」。

**验收**：`scripts/verify.mjs` 新增 4 项（加载中文案、就绪后自动刷新、失败态与重试入口、点重试恢复），并把测试服务加了 `fault.restDelay` / `fault.restFail` 模拟钩子；新测试置于测试序列末尾并先清 SW 缓存，否则缓存优先会让服务端故障模拟失效。结果：`check-data` 0、`test-merge` 28/28、`check-deploy` 通过（21 项排除）、`verify` **226/226**（连跑两次稳定）。

**复现方式**：rest 的慢网与 503 已并入 `verify.mjs` 的 `fault.restDelay` / `fault.restFail` 钩子与 4 项断言；extra / ch 的失败三态见 `scripts/check-shard-failure.mjs`。一次性复现脚本用完即删，不留档。

- 版本 1.23.1，SW `yuc-ln-shell-v48`。

## 9.49 v1.23.2 统一分片加载失败处理（2026-11-26）

**背景**：修完 rest 的静默降级后，回头发现同类缺陷在另外 4 个分片全部存在——`extra` / `volumes` / `rn` / `ch` 的 `script.onerror` 都只有 `xxLoading = null; resolve();`。

**用户可见后果**（以 extra 最严重）：`extra` 承载作者 / 插图 / 出版社 / 书系，失败时详情页这些字段**整行不出现**（不是显示「—」），用户会以为这本书本来就没有作者；`ch` 失败时卷清单只显示「共 N 卷」，看起来像该系列没有分卷。

**改动（均在 `index.html`）**：

- 四个分片统一加「失败标记 + 尝试计数 + 事件」：`extraFailed`/`extraAttempts`、`volumesFailed`/`volumesAttempts`、`rnFailed`/`rnAttempts`、`chFailed`/`chAttempts`，`onerror` 置失败态、写 `window.__lnXxxFailed`、派发 `ln-xxx-failed`。
- **关键防护——失败后不自动重试**：`renderDetail()` 每次都会调 `loadExtra()` 与 `loadCh()`，若不拦住会形成「失败 → 重绘 → 又请求 → 又失败」的死循环。四个 `loadXxx()` 均改为 `if (xxxFailed && !force) return Promise.resolve();`，只有用户点重试（`force=true`）才再发请求。
- 详情页：`extraLoaded === false` 时按失败/加载中两态插入提示（`extraNote`），失败态带 `data-retry-extra` 按钮；`!item.rn` 才提示——扩展书目自带 `au`，不需要 extra。
- 卷清单：`!ids` 分支按 `chLoaded`/`chFailed` 提示「卷清单加载失败，重试」（`data-retry-ch`）。
- 重试第 3 次起才带 `?v=` 时间戳，前两次走原地址以保留 Service Worker 缓存优先的离线兜底（与 rest 一致）。
- 新增通用 `.linkbtn` 样式（文字型链接按钮），替代不存在的类名。

**验收**：

- `verify` 226/226（连跑无回归）。
- 新增 `scripts/check-shard-failure.mjs`（`npm run check-shards`）**8/8**：SW 未接管的断言、extra 失败提示、extra 重试入口、extra 重试后补上作者、ch 失败提示、ch 重试入口、失败后不重复请求、ch 重试后恢复。
- **为何不并入 verify**：`extra` 与 `ch` 在 `sw.js` 的 SHELL 预缓存列表里，verify 跑到中段 SW 已接管，请求走缓存优先，服务端 503 拦不到，断言会**假通过**（实测先失败 3 项后才发现）。独立脚本改为「服务端不提供 `sw.js`」，确保走真实网络。rest 不在 SHELL 里，所以仍可在 verify 内测。
- CI 的 `data-check.yml` 增加 `check-shards` 步骤（已带 linux 的 `--no-sandbox` 参数）。
- `check-data` 0、`test-merge` 28/28、`check-deploy` 通过（21 项排除）。

**同类缺陷清单（本次已全部收口）**：rest（v1.23.1）、extra、volumes、rn、ch（v1.23.2）。

- 版本 1.23.2，SW `yuc-ln-shell-v49`。

> ⚠️ **上面这条「已全部收口」是错的**，v1.23.3 已纠正：`volumes` 与 `rn` 当时只加了失败标记，没有任何 UI 读取，两个失败事件零监听者。详见 9.50。

## 9.50 v1.23.3 补完 volumes / rn 的失败提示（2026-11-26）

**背景**：复核 v1.23.2 的实现时发现它与自己的文档不符。9.49 声称「同类缺陷本次已全部收口（rest、extra、volumes、rn、ch）」，但 `volumesFailed` / `rnFailed` 全项目只有 6 处引用：4 处是赋值与「失败后不自动重试」的判断，**没有任何 UI 读取它们**；`document.addEventListener('ln-volumes-failed')` 与 `ln-rn-failed` 两个事件的监听者数量为 **0**。

**实测的用户可见后果**（故障注入，探针用完即删）：

- **volumes 失败**：`ch` 只提供子卷 id 列表，卷名 / 封面 / 日期来自 `volumes` 包。包失败后 `byId.get(cid)` 全部落空，标题退化成 `('卷 ' + cid)`——豹头王传说（51735）的 151 卷全部渲染成「卷 51736 —」「卷 51737 —」。`ch` 索引共 10040 条引用中有 **7817 条（77.9%）只在 volumes 包里**，涉及 **960 / 1128 个系列**，面很大。
- **rn 失败**：开关已高亮成「已开启」（`aria-pressed=true`），`__LN_RN_COUNT` 为 0，页脚 `dataHint` 与 v1.23.2 之前完全一样，没有任何说明。用户的合理推断是「扩展书目本来就这么少」。

**改动（均在 `index.html`）**：

- `volumeSectionHtml()`：新增 `missing` 统计（`ordered` 中 `byId` 查不到的条数）。有缺失时在卷清单头部按 `volumesFailed` 两态提示（「卷信息加载失败，重试」/「卷信息加载中…」）；`missing === total` 时**不渲染 151 行裸 ID**，改为一行说明 + 重试按钮；个别缺失时把该行标题留空并标注 `.vol-pending`（弱化斜体），不再编造「卷 51736」。
- 补 `ln-volumes-failed` 监听（重绘详情 + 刷新页脚）与 `[data-retry-volumes]` 点击处理（`loadVolumes(true)`）。
- 补 `ln-rn-failed` 监听（刷新页脚 + 重绘）。
- `updateDataHint()`：把 `rnNote` 的计算提到所有 `if` 之前。**这是第二个 bug**——原实现里 `!restLoaded` 分支会提前 `return`，首屏阶段（2026 本）点开扩展书目开关失败时提示被完全吞掉，实测 `innerHTML` 就是「正在加载全库… 已载入 2026 本」。
- **第三个 bug**：`#retryRn` 原先写在 `emptyEl` 的点击委托里，但按钮渲染在页脚 `dataHint`（`emptyEl` 之外），点击无法冒泡到委托根。改为独立的 `document` 级监听并带 `disabled` 防连点。`#retryRest` 位于空结果区内，不受此问题影响。
- 显式打开扩展书目开关（工具栏按钮 + 命令面板）改为 `loadRn(true)`，展开卷清单改 `ensureVolumeMeta()` 内部走 `loadVolumes(true)` / `loadCh(true)`——用户主动操作等于明确意图，失败过的包要能重新请求，否则「关掉再打开」这个最自然的救回动作无效。

**验收**：

- `check-shards` **8 → 15 项**，新增 volumes 3 项（提示 / 重试入口 / 不渲染裸 ID）、rn 3 项（页脚提示 / 重试入口 / 重试后 8487 部进列表）、volumes 重试恢复 1 项。实测 volumes 重试后首行恢复为「ググイン・サーガ (1) 豹頭の仮面 1979-09-29」。
- `verify` 226/226、`test-merge` 28/28、`check-data` 0 问题、`check-deploy` 通过（21 项排除）。
- 版本 1.23.3，SW `yuc-ln-shell-v50`。

**教训**：失败态变量必须连到 UI 才算修完。v1.23.2 的 grep 只查了 `onerror` 是否赋值，没查变量是否被读取、事件是否有监听者——`grep -c "addEventListener('ln-xxx-failed'"` 为 0 就该报警。后续新增分片一律按「标记 → 事件 → 监听 → 文案 → 重试 → 断言」六步走。

## 9.51 v1.24.0 搜索支持多写法与多语言（2026-11-26）

**需求**：搜索要在所有维度上都能命中——别名、不同文字、不同写法。

**先测量，不猜**（探查脚本用完即删）。逐项实测的结论：

| 输入 | 改前 | 原因 |
| --- | --- | --- |
| `ＧＲＩＤＭＡＮ`（全角） | 1 → 0 | 无全角折半 |
| `这个勇者`（简体，库里存繁体） | 0 | 无繁简互通；`這個勇者` 才命中 |
| `mofashizhiye`（全拼） | 0 | `py` 只存首字母 |
| `mahou` / `metal`（罗马字） | 0 | 无罗马字索引 |
| `道造`（作者名） | 0，**且无任何提示** | 作者不在核心包，`au`/`en`/`al` 在核心数据里 **0 条** |

最后一项最糟：不是「搜不到」，是「搜不到还告诉用户库里没有」。核心包的字段实测只有 `c,chn,chs,cn,d,gn,h,i,img,kind,n,ns,py,rk,s,sv,tg,v,ver`——`en`、`al`、`au`、`il` 一个都没有，原代码里为它们写的分支全是死代码。

**数据层**（新增 `scripts/build-search-index.mjs` + `scripts/split-shards.mjs`）：

- `py` 改成 `"首字母|全拼"` 合并形式，拆分时把全拼移入独立包，lite 体积不涨（167,784 → 167,058 gzip）。
- 罗马字用自建假名表转写，**必须处理促音双写**：`プラスチック` → `purashikku`（不是 `purasuchiku`），否则用户按标准罗马字打进来搜不到。长音 `ー` 直接省略。
- **踩过的坑**：先试过把三个索引合并成一个 `{id:[full,rpy,au,il]}` 大包，gzip 136,909 —— 比三个独立包合计 107,682 **更大**，因为 JSON 的 id 键与数组外壳开销吃掉了复用收益。已回退为三个独立包。
- 产物：全拼 4705 条（58KB gzip）、罗马字 4218 条（35KB）、作者 5050 条含插图 3997（59KB）。

**前端层**（`index.html`）：

- `normalize()`：NFC → 全角折半（`charCodeAt - 0xFEE0`）→ 小写 → t2cn。繁简用 `opencc-js` 的 `t2cn` 表，**前端运行时转换**：t2cn 52,628 B gzip，反方向 cn2t 是 452,756 B，方向选择直接决定成本。
- `normOf(x, key, raw)` 带 `Map` 缓存：5076 条 × 2~3 字段，首次搜索算一遍。实测 2026 条 / 3618 次转换 = 12ms，相比 140ms 输入防抖完全可接受。
- `matchesQuery` / `searchRank` / `filteredList` / `suggestItems` 全部改走同一套归一化。搜索**联想**也必须改——否则输入「这个勇者」结果区有书、联想框却空白。
- `highlightHtml` 有个隐藏陷阱：归一化可能改变字符串**长度**（繁→简 1:1 但 NFC 组合字符会变），拿归一化串上的命中位置去切原文，`<mark>` 会套到错误的字上。加了长度守卫——长度不一致就退回原文小写匹配，宁可这次不高亮。

**三个必须说明的边界**：

1. **索引包会晚于数据包到达，也可能早于**。原先 `loadIdx` 只在新包落地那一刻按 `byId` 合并一次，若 `rest`（184KB，慢）在 `au`（58KB，快）之后到，后到的 3050 条永远没有作者字段——表现为「首屏搜得到作者、全库搜不到」。改为：索引包保留 `sh.data` 原始映射，`rest`/`rn`/`volumes` 每次落地后调用 `applyAllIdx()` 重新铺一遍。
2. **索引未就绪 ≠ 没有这本书**。空结果现在分三态：`pendingIdxFor(q)` 非空 → 「正在加载作者索引」并自动拉取；`failedIdxFor(q)` 非空 → 「索引加载失败 · 重试」；都没问题才轮到「全库数据正在加载」。**顺序很重要**——`!fullReady` 的判断必须排在索引提示之前，否则「只搜了首屏 2026 本」会被说成「索引正在加载」，把更根本的问题掩盖掉。
3. **紧凑兜底只在全局 0 条时启用**。811 条可见条目的标题含 `＆ ・ : (1)` 这类分隔符，用户不会照抄。策略是：严格匹配有结果就用严格结果，一条都没有才放开到「忽略标点与空白」重搜一次。这样 `メタルプラスチック` 能命中 `メタル＆プラスチックマイハニー`，而 `文学少女` 的结果数不会因为兜底而变化（实测 8 = 8）。

**验收**：

- `verify` 226 → **236 项**。新增 10 项：繁简转换表就绪、三个索引包可加载、全角/半角结果一致、简体搜繁体书、繁体搜同书、全拼命中、罗马字命中、作者独立索引命中、省略标点可搜、严格命中时不启用兜底。
- `check-shards` 15 → **23 项**。新增 8 项：索引加载中提示「正在加载」、加载中提供立即加载入口、索引失败提示「索引加载失败」而非「没有找到」、失败态可重试、失败状态与「未加载」不混淆、重试后作者字段挂上（5044 条）、重试后作者名真能搜到、就绪后不重复请求。
- **测试设计上犯的错，值得记下来**：一开始把索引失败注入写在 `verify` 里，两项失败。原因不是代码错，是 `verify` 跑到中段 SW 已接管，`au` 已被缓存，服务端 503 被缓存优先策略完全挡掉——故障根本没注入进去。同时我用 `__lnResetIdxForTest('au')` 把 `au` 字段从所有条目上删掉了却没恢复，导致后面「作者标签跳转」断言拿到空作者名（1/2026）。两项修复：故障注入移到 `check-shard-failure.mjs`（该脚本故意不提供 `sw.js`，这是它存在的理由）；`verify` 里的复位用例结束后真正 `loadIdx('au', true)` 重新加载并断言 `withAu > 3000`。
- `check-deploy` 的 `RUNTIME_FILES` 补 4 项（`pyf` / `rpy` / `au` / `vendor/opencc-t2cn.js`），`runtimeRefs` 正则加 `vendor/*.js`——否则新文件不进白名单，Pages 上会 404。现在 17 个运行时文件。
- SW `yuc-ln-shell-v50` → **v51**，`opencc` 进 SHELL 预缓存（搜索依赖它，离线也要能用），三个索引包**故意不进**（首次安装不该多下 152KB）。
- `check-data` 0 问题、`test-merge` 28/28、`verify` 236/236、`check-shards` 23/23。
- 版本 1.24.0。

**留下的局限**（数据本身决定，不是代码问题）：罗马字索引只覆盖假名。汉字标题（`魔法科高校の劣等生`）无法从汉字推读音，`mahouka` 搜不到它——要补只能引入日文读音词典，当前数据源没有这个字段。同理 `rezero` 这类粉丝简称无法自动推导，除非人工维护别名表（现有的本地纠错 `al` 字段已支持手工补，且参与搜索）。

## 9.52 v1.24.1 假名与长音补全（2026-11-26）

**缘起**：v1.24.0 宣称「多语言搜索」，但它自己的 `verify` 只用 6 个抽样案例自证。用户要求「检查成果」，所以另写了 `scripts/audit-search-coverage.mjs` —— 不重跑既有断言，而是对**全库 5076 条逐条**验证 13 个维度，判据由审计脚本独立给出，不复用产品代码里的判断。结果：12 项全过，**1 项 0/207 全漏**。

**缺陷一：片假名 / 平假名不互通**

966 条可见条目标题含片假名。用户按平假名输入时全部落空——日文输入法里 `ムダに` 和 `むだに` 是同一个词，用户记不住库里存的是哪一种写法。修法是在 `normalize()` 里加一步折平：

```js
// U+30A1-U+30F6 与 U+3041-U+3096 一一对应，减 0x60
if (/[\u30A1-\u30F6]/.test(v)) {
  v = v.replace(/[\u30A1-\u30F6]/g, function (c) {
    return String.fromCharCode(c.charCodeAt(0) - 0x60);
  });
}
```

长音符 `ー`（U+30FC）**不在折叠范围**：它没有平假名对应物，折下去会把 `コーヒー` 变成别的东西。

折叠前先确认不会把不同作品混为一谈：折平后只产生 **12 组重名**，全部是原本就重名的条目（`HELLO WORLD` 之类的同名不同卷），没有因折叠而新撞车。审计复测 207/207。

**缺陷二：罗马字长音两侧不通**

构建期把 `ー` 直接删掉（`アーク`→`aku`、`コーヒー`→`kohi`），换来 `ramen` 能命中 `ラーメン`。代价是按赫本式双写元音打 `aaku`/`koohii` 的用户搜不到。库内还有反方向的情况：`王`→`ou`、`東京`→`toukyou` 是展开的，用户又常简写成 `o`。

实测 696 条受影响，**602 条漏搜**。修法是在**兜底通道**对罗马字多做一次长音折叠（`ou`→`o`、双写元音压缩）后比对：

```js
function foldLong(s) {
  return String(s == null ? '' : s).replace(/ou/g, 'o').replace(/([aiueo])\1+/g, '$1');
}
// 只在 loose 分支、只对纯字母 token、只比 rpyFull
if (/^[a-z]+$/.test(t)) {
  var ft = foldLong(t), fr = foldLong(String(x.rpyFull || ''));
  if (fr && fr.indexOf(ft) >= 0) return true;
}
```

**不挂在严格匹配上**的理由：中文拼音没有长音概念，跟着折叠会把 `zhou` 变成 `zho`，制造无谓的误报面。审计复测 256/256。

**缺陷三：审计自己的断言是空的**

修完前两项后回头查 section 10，发现它的判据是 `!/-/.test(it.rpyFull)` —— 而 `rpyFull` 在构建时已被 `.replace(/[^a-z0-9]/g, '')` 清洗成纯字母，**永远不含 `-`**，于是 `continue` 掉全部用例，`tested` 恒为 0，`0 === 0` 一路报「通过」。这条断言从写下当天起一次都没执行过。

这是本轮最有价值的发现：**它说明「13/13 通过」这个数字本身不可信**。修法是把判据换成「折叠后确有变化」的真用例，并加一条 `tested === 0 → 判 FAIL` 的空跑守卫：

```js
record(..., choonReport.tested > 0 && choonReport.hit === choonReport.tested,
  choonReport.tested === 0 ? '用例为 0，断言空跑' : ...);
```

**反向验证**（不做这一步的断言都是装饰品）：

| 状态 | 长音项 | 假名项 |
| --- | --- | --- |
| 修复前 | 34/256（漏 222） | 0/207（漏 207） |
| 修复后 | 256/256 | 207/207 |

撤销代码再跑，确认断言会 FAIL，才证明它真在测东西。

**一处口径修正**：加上假名折叠后，「繁简」项从 546 涨到 635。查清是原判据用「`normalize` 后是否等于原文」筛用例，把假名折叠和全角折半也算进了繁简桶。换成「重做一遍除 t2cn 外的所有步骤，若结果与 `normalize` 相同则差异不来自繁简」后，回到 252（口径变严，只留纯繁体用例）。**这是审计口径变化，不是回归。**

**验收**：`verify` 236 → **238 项**（新增平假名搜片假名、罗马字长音省略），`check-shards` 23/23，`audit-search-coverage` 13/13（全库逐条），`check-data` 0，`test-merge` 28/28，`check-deploy` 21 排除 / 17 运行时文件。SW `v51` → **v52**，版本 **1.24.1**。

**方法论留档**：抽样断言能过，全量审计才能发现问题。`verify` 的 6 个搜索案例全过，但其中一个维度是 0% 覆盖——因为抽样永远不会抽到「用户实际会打但开发者没想到」的写法。

## 9.53 v1.24.2 清掉无检索价值的罗马字（2026-11-26）

**怎么发现的**：查数据层质量时，顺手量了一下「同一个罗马字对应多少本不同的书」。结果很刺眼——`no` 一个串对应 **110 本**：

```
七角錐の少女    → no
8階の神話      → no
刹那の夏       → no
魔女と毒殺文芸部 → to
```

**根因**：`kanaRomaji` 只转写假名、丢弃汉字。日文书名大量是「汉字 + 助词」结构，假名部分常常只有 `の` `と` `を`，汉字全被扔掉，罗马字就退化成一个助词。

**这不是「搜不到」，是「搜什么都能搜到」**：

| 查询 | 罗马字命中 | 标题本身含该串 |
| --- | --- | --- |
| `no` | 958 | 30 |
| `to` | 490 | 12 |
| `tono` | 65 | 0 |
| `noto` | 53 | 0 |
| `nono` | 65 | 0 |

`tono` / `noto` / `nono` 三条**一条真命中都没有**，全是垃圾。搜 `no` 被放大 32 倍。

**与已知局限的区别**（HANDOVER 9.51 记过的那条不要混淆）：

- 「`mahouka` 搜不到 `魔法科高校の劣等生`」= 汉字推不出读音，**需要日文读音词典**，现有数据源没有，属已知局限，本轮不碰。
- 「搜 `no` 出 110 本无关书」= 索引里有垃圾键，**构建期就能过滤**，是缺陷。

**修法**：构建期加 `romajiWorthIndexing(rpy)`，长度 <4 不建索引。

为什么是 4 而不是更严格：实测长度分布，≤2 有 127 条（`no`/`to`/`nono`），≤3 有 142 条。取 4 覆盖全部垃圾串，且被丢弃的 **142 条全部仍有中文名或全拼可搜**，不损失任何检索能力（逐条验过）。

**连带挖出两个更隐蔽的缺陷**：

1. **`buildIndex` 的增量写回会吃掉原值**

   原写法 `if (rpy && x.rpy !== rpy) x.rpy = rpy` —— 只在**非空**时写回。于是门槛算出空串时，旧垃圾值永远删不掉，门槛形同虚设。第一次加门槛后重建，提示「罗马字新增 0 条」，一条都没清掉，就是这个原因。改为允许空串覆盖（`delete x.rpy`）。

2. **首字母被纯全拼覆盖，2997 条中文条目丢检索**

   `const initial = x.py && !/[|]/.test(x.py) ? x.py : kanaInitials(base)` —— `kanaInitials` 只处理假名，对中文返回空串。旧 `py` 是 `首字母|全拼`（含竖线）时走这条路 → 首个字母变空 → `py` 退化成纯全拼；再跑一次时 `x.py` 已不含竖线，纯全拼被当成首字母**固化**。实测 `魔法使之夜` 的 `mfszy` 搜不到了，4705 → 1546 条。

   这个 bug 平时不暴露，因为「只跑一次」看不出问题——必须重复运行才显形。改为兼容三种状态：`首字母|全拼` 取左边、纯首字母直接用、空则现算。

3. **正则写死 `\n`，Windows 上直接跑不通**

   `parseDataFile` 与 `split-shards` 都用 `\};\n` 匹配 META 行，而 git 在 Windows 上默认 `autocrlf` 把 `data/*.js` 写成 CRLF，`\r` 卡在中间就匹配不上，抛「无法解析数据文件」。**CI 跑 Linux（LF）所以从未暴露**，本地这次一跑就炸。改为 `\r?\n`。

**一处口径确认（不是回归）**：修完 `no` 仍有 841 条命中，因为长罗马字里含 `no` 子串（`akumadetenshi...tono...`）。这是**子串匹配的固有行为**——搜 `art` 也会命中 `party`。判断标准是「用户打这个串想要什么」：`tono` 本身不是检索词，没人这么搜；而 `mahou` 这类真词不受影响。所以只修「整串无价值」，不动子串匹配策略。

**验收**：审计 13 → **14 项**（新增「罗马字索引无 no/to 类无效串」），`verify` 238/238、`check-shards` 23/23、`check-data` 0、`test-merge` 28/28、`check-deploy` 21 排除 / 17 运行时文件。罗马字包 4218 → 3805 条（gzip 35,052 → 33,503，**净减少**）。SW `v52` → `v53`，版本 **1.24.2**。

**反向验证**：撤销 `romajiWorthIndexing` 后重建，断言 FAIL 并列出具体条目（`{"id":"690141","r":"no"}` 等），恢复后 14/14。

## 9.54 v1.24.3 保存纠错后新值搜不到（2026-11-27）

**怎么发现的**：`verify` 有一项「本地别名参与搜索」在四次运行里随机失败，而代码没动过。一开始当成机器负载抖动（同期确实出现过 `cards=0` 导致的连锁假失败），但「别名搜索」失败时详情页明明显示着新作者名，说明数据改到了、搜索却没跟上。顺着这条线查归一化缓存。

**根因**：`normCache` 的键是「条目 ID + 字段名」：

```js
var ck = String(x.i) + '\u0000' + key;
```

而 `applyMetaOverride(item)` 会**原地改写** `cn`（中文名）、`au`（作者）、`al`（别名）。键不变，缓存就继续返回改写前的归一化结果。实测走真实 UI：

```
把某条 cn 改成「探针改名AAA」并保存
  item.cn      → "探针改名AAA"    ✅ 字段确实改了
  搜「探针改名AAA」 → 0 条          ❌ 应为 1
  搜原来的中文名   → 1 条          ❌ 应为 0
```

**为什么时有时无**：`applyIdx()` 加载索引包时也会 `normCache.clear()`。所以「保存纠错」和「索引包加载」谁先发生，决定了缓存有没有被顺手清掉——这就是同一份代码四次运行结果不同的原因。**不是负载抖动，是竞态。**

**修法**：把被归一化的原始值并进缓存键。

```js
var ck = String(x.i) + '\u0000' + key + '\u0000' + raw;
```

字段一变键就变，不再依赖「改完记得清缓存」这种容易漏写的约定。另一条路是在每个 `applyMetaOverride` 调用点补 `normCache.clear()`（有 8 处），但那样以后新增一个改写字段的入口就又会漏——**让键自动失效比让人记得清缓存可靠**。

**新增断言**：「保存纠错后新值立即可搜（缓存已失效）」。关键是**同时验两侧**：

```js
cacheFresh.cnAfterSave === '缓存探针改名QQQ' &&
cacheFresh.hitNew >= 1 && cacheFresh.hitOld === 0
```

只验「新名字能搜到」会漏掉「旧名字还残留」那一半——两者其实是同一个 bug 的两面，但单验一侧时，只要缓存被别的路径清过就能蒙混过关。

**反向验证**：把缓存键改回 `id + key`，该断言 FAIL（`hitNew:0, hitOld:1`），其余 238 项照常全绿——说明断言确实钉住了这个缺陷，而不是跟着别的因素一起变红。

**顺带修的两处验收脆弱点**（不改产品逻辑，但都会让人误判）：

1. **端口被占用时在 `listen` 阶段直接挂**。起因是我调试时强杀了上一个实例，8791 的监听句柄挂到 `OwningProcess=0` 上不释放（Windows 强杀常见残留），之后每次运行都 `EADDRINUSE`，而这时浏览器还没启动、一行断言都没跑，报错却像「验收挂了」。改为端口被占用时自动顺延（`LN_VERIFY_PORT` 可覆盖），CDP 端口同样先探空闲再绑定，profile 被锁时换独立目录。
2. **`无 JS 异常` 报了警却不给线索**。原实现 `JSON.stringify(params).slice(0, 200)`，未捕获的 Promise 拒绝只能显示到 `Uncaught (in promise)`，异常描述和调用栈全被切掉。改为拼出描述前 3 行 + 第一个调用栈帧。

**顺带修**：`package-lock.json` 版本停在 `1.23.3`（`package.json` 已是 1.24.x），版本五处一致性检查一直漏掉它——发布清单写的是「`package-lock.json`（两处）」，但实际没人核对。

**验收**：`verify` 238 → **240 项**（新增「保存纠错后新值立即可搜」与「探针纠错已清理」），`audit-search` 14/14，`check-shards` 23/23，`check-data` 0，`test-merge` 28/28，`check-deploy` 21 排除 / 17 运行时文件 / 10 数据包。SW `v53` → `v54`，版本 **1.24.3**。连跑三次 240/240 稳定。

**自己踩的坑：探针把测试状态搞脏了**。第一版断言直接挑「任意有中文名的条目」改名，没有排除 `editPick`（后续「纠错与别名刷新后仍生效」要用的那条）；而且保存后面板 `innerHTML` 已被清空，复位代码去点 `reset` 按钮时它**根本不存在**，于是那条纠错记录残留在 `localStorage` 里。表现是：单独跑通过，连跑第二次就挂「恢复上游清除覆盖与别名」和「全库就绪后自动刷新」——**新写的断言污染了后面的断言**。修法两条：探针条目显式排除 `editPick`；复位前先重开面板再点 `reset`，并补一条「探针纠错已清理」自校验，让污染下次能被自己抓到。

**可复用的判据**：**缓存键必须包含「被缓存的输入本身」，不能只包含输入的身份（ID + 字段名）。** 只要存在「同一身份下内容会被改写」的路径（本地纠错、云端合并、索引回填），用身份做键就一定会拿到陈旧值；而靠「记得在改写处清缓存」维护，漏一处就是一个时有时无的 bug。

**另一条**：**写「会改状态」的测试时，先想清楚复位路径是否真的可达。** 「保存后关面板 → 面板被清空 → 复位按钮不存在」这条链不看渲染代码根本想不到；而它的症状（隔次失败）极容易被误判成环境抖动。

**收尾时又做的一轮（`8c2141a`，未升版本，只动 `scripts/verify.mjs`）**：

1. 新增 `waitAuthor()`，等目标条目的 `au` 真正落到数据上，而不是只等 `__LN_EXTRA_READY` 标志——标志为真不代表字段已写入，实测出现过「标志已真但 `item.au` 为空」，随后「恢复上游」拿 `''` 去比基准就 FAIL，详情区同时显示「字段加载中…」。
2. `editPick.au` 改为在 extra 就绪后重新取值。原值取自页面加载瞬间，那时 `au` 可能是空串；拿空串当基准，断言永远不可能通过。
3. 「全库就绪后按当前关键词自动刷新结果」加诊断字段（`novel` / `fullReady` / `dataLen`）。该项失败形态是 `count="0"` 且空结果区可见 = 「搜了但没结果」，与「还在加载」是两回事，修法也不同；原来只报 `hidden`/`count`，无法区分。

**必须如实记下的一点**：第 1 项做过反向验证但**没能复现失败**——把 `waitAuthor` 改成立即返回 `true`（等价于旧行为），连跑两次仍 240/240。所以它是「按失败现场的报错做的对症修正」，**没有反向验证支撑**。保留的理由是代价极低（只改等待判据、不放宽任何断言），但不应据此认为该偶发失败已被证实修复。下次再遇到时先看诊断字段给出的 `novel`/`fullReady`，别再从「负载抖动」这个结论起手——本轮就差点被它盖过去。

**CI**：`46010515197` 在 Linux 上同样 240/240、23/23、14/14，新断言与诊断字段均正常。

## 10. 已知风险与决策

1. 搜索接口 1000 条上限：必须按 `rating_count` 分区抓取，不能直接 offset 翻到底；数据增长后要重新核对各分区是否仍小于 1000 条。
2. Bangumi 书籍数据系列 / 单卷混杂：优先用关联接口的「单行本」标记，标题规则只兜底；若误判，用户可关闭开关看全部。
3. 部分条目缺日期 / 卷数 / 作者：留空，UI 显示「—」，不丢弃条目。
4. 封面为外链，首次需联网；离线显示首字占位（沿用番剧）。
5. 两个 Pages 站点同源：键名、缓存名、Gist 文件名必须唯一。
6. Gist Token 只存本机；建议只勾选 `gist` 权限。
7. 抓取是公开接口，务必限速 800ms、带 UA、失败退避，避免被风控。
8. 版本策略：补丁位修 bug / 样式，次版本加功能块，主版本才大改。

## 10.1 发布检查清单（三站统一基线）

1. **版本五处**：`index.html` meta + 页脚、`package.json`、`package-lock.json`（两处）、`manifest.webmanifest`，与 README / HANDOVER 当前状态一致。
2. **SW 缓存**：有数据或壳文件变化时把 `yuc-ln-shell-vN` 升一版；只改文档或 CI 不需要升。
3. **验收**：`check-data` 0 问题、`test-merge` 28/28、`check-deploy` 通过（21 项排除 / 17 个运行时文件 / 10 个运行时数据包）、`verify` 240/240、`check-shards` 23/23、`audit-search` 14/14。
4. **CI**：commit → push `main`，六项自动验收（`check-data`、`test-merge`、`check-deploy`、`verify`、`check-shards`、`audit-search`）全绿。
5. **线上复核**：Pages 构建后确认 meta / 页脚版本、数据条数与 SW 缓存名。
6. **收尾**：更新 README / HANDOVER / 会话日志，打 `vN` tag。
7. **同源隔离**：缓存名与清理范围固定在 `yuc-ln-` 前缀，不触碰番剧 / galgame。
8. **许可**：MIT，署名 Deckard（见 `LICENSE`）。
9. **部署边界**：`_config.yml` 只发布运行时文件，排除脚本、报告、截图、文档、`package*.json` 与全部构建输入（完整核心、`data/*.json`）；`npm run check-deploy` 校验 21 项排除、17 个运行时文件（其中 10 个数据包）未被误排除、页面/SW 引用齐全。上线后确认 `/scripts/verify.mjs`、`/screenshots/desktop.png`、`/data/light-novels.js` 返回 404，运行时文件返回 200。

## 11. 交接提示词

> 接手 `c:\Users\ASUS\Desktop\collection project\轻小说`。先读 `README.md`、`HANDOVER.md`、`reports/session-log-2026-11-23.md`，再读 `../番剧/README.md` 和 `../番剧/index.html` 的对应区段。当前 v1.24.3 已完成，后续按第 10 节风险与决策、第 9.54 节最新记录推进；任何改动后运行 `check-data` / `test-merge` / `check-deploy` / `verify`（239 项）/ `check-shards`（23 项）/ `audit-search`（14 项），push/PR 由 CI 自动跑六项，不要修改 `../番剧`。分片加载失败的处理必须连到 UI 才算修完——只给 `onerror` 赋值、没有事件监听者或没有文案/重试入口，等于没修（v1.23.2 就犯过这个错，见 9.50）。搜索相关改动必须同时过「全角 / 繁体 / 全拼 / 罗马字 / 作者 / 省略标点」六类写法，另加 v1.24.1 的平假名 ↔ 片假名与长音符两种写法，见 9.51 / 9.52；`verify` 的搜索断言是抽样，判断覆盖率必须另跑 `audit-search`（对全库逐条，见 9.52）。`verify` 在机器负载高时可能因首屏卡片未渲染而大面积假失败（失败项集中在「卡片数量」类断言），先重跑一次再怀疑代码。完成后汇报：数据统计、verify 通过数、桌面与移动端截图、线上 URL。若数据字段与本文不符，先停下来说明差异再改。
>
> **子代理授权**：任务中可以分派适量子代理以加快进度，不必再问（可独立并行的调研、代码审计、多文件排查、批量验证、独立模块实现）。数量 **2–3 个**为宜，不为凑数硬拆；**禁止多个子代理同时修改同一文件**（会互相覆盖），同一文件的改动由主线串行完成。分工上子代理只做「读取 / 分析 / 出结论」或各自负责互不重叠的文件，主线负责整合、验证、提交与最终汇报。交给子代理的提示必须自包含（目标、已知事实、已排除项、具体文件路径或行号、验收标准），不要写「根据你的发现去修复」这类放权式指令。子代理产出只回到主线，**必须核验真实文件改动后**才对用户汇报。完整准则见工作区 `../.workbuddy/memory/MEMORY.md`。
