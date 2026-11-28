# 轻小说库 · 落实与交接

- 文档日期：2026-11-23
- 当前状态：**v1.24.4 完成**（数据、页面、书评、统计、Gist 同步、PWA、本地纠错、格式与藏书、多语言搜索、自动化验收 240/240 + 全量搜索审计 16/16 + 分片失败回归 23/23）
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

### 9.54.1 补上全量维度（v1.24.4）

上面那个 bug 修完之后，覆盖面上还留一个洞：**本地纠错 / 别名这条路径在 `audit-search` 里根本没有维度**，只有 `verify` 的一条抽样断言在守着。而抽样恰好是这个 bug 的护身符——索引包加载时会顺带 `normCache.clear()`，抽中的那次要是清过缓存就顺利通过，抽不中就 FAIL，于是「时好时坏」。这类「靠时序侥幸通过」的抽样断言，等于没有。

所以给审计加了第 15 节「本地纠错改写后立即可搜」，全量逐条跑：取均匀样本（不是前 N 条），对每条改写一个可搜索字段、搜新值、搜旧值，再复原。

**三个来回才写对，每个错法都值得记**：

1. **只用 `cn` 造用例 → 覆盖率 2/200**。诊断输出 `skipNoCn: 58`（前 60 条里 58 条没中文名）才发现。数据按年份/热度排，前段同质化严重，「取前 60 条」跟随机抽样完全不是一回事。改成两步：字段优先 `cn`、没有就退到 `au`；样本从 `slice(0,60)` 改成按步长均匀取 200。覆盖率 2 → 182/200（`cn=126 / au=74`），并补一条断言要求两类字段都非零，防止将来又退化成单字段。
2. **判据写错，把 18 条正确行为判成缺陷**。第一版判据是 `hitNew && !hitOld`（新值能搜到、旧值搜不到），跑出 182/200，18 条全是 `hitNew:true, hitOld:true`。查下去发现：**很多条目的 `cn` 与上游 `n` 内容相同**（`少女不十分`、`梦想收购店`、`虐杀器官`、`河图洛书`），中文名纠错只改 `cn`，`n` 是上游原始数据本就不该被中文名覆盖，所以旧值通过 `n` 仍能命中——**这是正确行为**。加 `oldLeftElsewhere`（先查旧值是否残留在 `n`/`en`/`au`/`il` 任一处）后判据改为 `hitNew && (!hitOld || oldLeftElsewhere)`，200/200。
   教训：**新断言红了先查自己是判据错还是产品错**。这 18 条如果当时直接「放宽断言」绕过，就会把真正的漏搜也一起放过。
3. **零样本守卫**。这个维度天然可能「全部 skip」（样本里既没 `cn` 也没 `au`），`tested===0` 时 `hit===tested` 恒真会让它一路绿。`recordCoverage()` 里 `tested===0 → FAIL` 是硬要求，不是可选项。

**反向验证（这次做了，且成功）**：把 `normCache` 的键退回 `String(x.i) + '\u0000' + key`（去掉原始值），重跑审计 —— 该维度立刻由 200/200 掉成 **FAIL（1/2）**，漏搜样本清一色 `hitNew:false / hitOld:true`，正是缓存陈旧的特征形态。恢复键后回到 16/16。**这个维度确实能抓住它守护的那个 bug。**

**探针自身的安全性也验了一次**：第一版 `overrideProbe` 重建纠错记录时只复制 `cn`/`al`/`clr`，而 `META_FIELDS` 是 `['cn','n','au','il','pub','line','d']`——用户若在该条目上还改过日期、系列、出版等字段，探针期间这些字段会被临时抹掉；中途抛错更会把残缺记录留在 `metaMap` 里，变成真污染。改为对原记录做浅拷贝后只覆盖目标字段。反向验证：把代码退回窄重建，检查该项立刻 FAIL；恢复后 PASS。

**验收**：`audit-search` 14 → **16 项**，`verify` 240/240，`check-shards` 23/23，`check-data` 0，`test-merge` 28/28。SW `v54` → `v55`，版本 **1.24.4**（`index.html` 加了两个审计钩子，属于运行时文件变更，按清单第 2 条升 SW）。

**顺带修**：§11 交接提示词里 `verify`（写的是 239 项）与实际情况（240）不符，一并改正。

## 9.55 v1.24.5 存储写入失败不能再静默（2026-11-27）

### 9.55.1 这一轮修的是什么

按「检查项目漏洞并自动修复」的要求做了一轮针对性排查，把 `localStorage` 的**每一个写入点**都过了一遍。判断标准只有一条：**这次写失败，用户会不会以为已经保存了？**

写失败后用户能立刻自己发现的（设置项、偏好、排序、搜索历史、目标、打卡日期、Gist 配置）不算漏洞——界面会当场回退到旧值，看得见。真正的问题是那些「**界面显示成功、实际没落盘、且内容靠用户手打**」的写入点，一共三处：

| 写入点 | 数据 | 原 `catch` | 丢失后果 |
|---|---|---|---|
| `persistMeta` | 本地纠错：中文名 / 原名 / 作者 / 别名 / 出版社 / 发售日 | `/* 隐私模式下忽略 */` | 详情页立刻显示改后的值（改的是内存对象），刷新全没。一次一条，但要一条条重打 |
| `saveDraft` → `persistDrafts` | 书评短评与长笔记草稿 | `/* 隐私模式下忽略 */`，且**连 `canStore` 都没有** | 界面上还写着「草稿已自动保存」。用户写了十几分钟的笔记，关掉详情就没了 |
| `persistDeleted` | 删除墓碑 | `/* 忽略存储失败 */` | 不是「删不掉」，而是**删掉的书在下次云同步时自己回来**——远端没有墓碑作废，合并时又被拉回来。用户完全猜不到原因 |

另外 `saveMine`（收藏本体）原本会 toast 一句「浏览器禁止本地存储，请及时导出备份」，但**一律这么说**：配额满（约 5MB）时用户会去翻浏览器设置找「禁用」开关，什么也找不到，反而看不出是空间不够。

### 9.55.2 第一版修复是假的，被自己的断言抓住

第一版很直接：在 catch 里 toast 一句失败文案，并按 `isQuotaError()` 分流「存满了」和「被禁用」。写完跑验收，三条新断言全绿。

但绿是假的。真实链路是：

```js
persistMeta();                    // 内部 toast('本地存储已满，本次纠错未保存！')
...
toast(cleaned ? '已保存本地纠错' : '已恢复为上游数据');   // 六行之后，覆盖掉
```

`toast()` 是**单例元素**，`clearTimeout` + `innerHTML = ''` 之后重写。所以失败提示在同一帧内就被紧随其后的成功提示盖掉了，用户从头到尾只看得到「已保存本地纠错」。

`saveMine` 更典型，调用方普遍是这种写法：

```js
saveMine();
toast('已标记为「' + STATUS[status] + '」：' + item.cn);   // 下一行
```

**这就是「假修复」的标准形态：代码改了、断言绿了、用户该看到的还是看不到。** 只有把 toast 换成 MutationObserver 记录历史，才发现「发出过」和「用户看得到」根本不是一回事。

### 9.55.3 最终方案：常驻横幅做主通道，toast 只做补充

顶部本来就有 `#storageWarn`（原先只在 `!canStore` 时启动显示一次）。把它改成运行时也会亮的常驻通道：

- **按 key 记账**，`storeFailed = Object.create(null)`，键是 `META_KEY` / `STORAGE_KEY` / `DRAFT_KEY` / `DEL_KEY`。
- `reportStoreFailure(e, key)` 置位并写横幅文案；`clearStoreFailure(key)` 只清**这个 key 自己**的账，全部清空才收起横幅。
- 为什么必须按 key：纠错写失败、紧接着收藏写成功，如果用全局布尔量，横幅会被撤掉——而纠错那份数据其实已经丢了。「另一个 key 写成功」不代表丢的数据回来了。
- toast 全局**只弹一次**（`storeToasted`）。一次操作常连写两三个 key（收藏 + 墓碑），每个都弹会刷屏。
- 文案分流 `isQuotaError()`：`QuotaExceededError` / `NS_ERROR_DOM_QUOTA_REACHED` / `code 22` / `code 1014` / message 含 quota → 「已满，请先导出备份再清理」；其余 → 「被禁用，只在本次打开期间有效」。

**草稿那条还多改了一处**：`refreshReviewCount(draftSaved)` 接收 `saveDraft` 的返回值，失败时把「· 草稿已自动保存」改说「· 草稿未能保存」。光有横幅不够——用户打字时眼睛在输入框上，那行字数统计是他唯一会瞄的地方。

### 9.55.4 四条新断言与反向验证

`verify` 240 → **247**。四条新断言的共同点是**走真实入口**（真点保存 / 真触发 input / 真点移除），不是直接调内部函数：

1. `存储写满时会发出失败提示` —— MutationObserver 记录 toast 全部历史，断言「历史里出现过含『未保存』的一条」。不能只看最终文本，实测它会先后被 `已保存本地纠错` 和 PWA 的 `安装到主屏幕` 覆盖两次。
2. `存储写满时失败信息常驻可见（不依赖 toast，不会被别的提示覆盖）` —— 只认横幅。两条一起才能堵住「裸 toast 被覆盖」和「提示一闪而过」两个方向。
3. `草稿写失败时不谎报「已自动保存」` —— 断言 `hint` 含「未能保存」**且不含**「已自动保存」。只验前者会被「两句话都有」蒙过去。
4. `删除墓碑写失败时亮出常驻横幅` —— 断言横幅亮起且书确实已移出收藏（`inMine === false`），确认走的是「移除」而非「加入」分支。

**反向验证（四次，全部成功）**：

| 撤掉的修复 | 结果 |
|---|---|
| toast 改回裸提示 | 3 条同时 FAIL |
| `persistDrafts` 改回静默 + 提示改回固定文案 | 2 条 FAIL，诊断显示 `draftWritten:false` 却仍写「草稿已自动保存」 |
| `persistDeleted` 改回静默 | 1 条 FAIL |
| — | — |

### 9.55.5 这一轮踩到的三个坑

**坑一：断言自己污染了被测环境。** 为了模拟配额满，第一版写 `localStorage.setItem = function () { throw ... }`。给 Storage **实例**挂自有属性，`Object.keys(localStorage)` 里就多出一个 `'setItem'`，把后面那条「本地存储全部使用 `yuc_ln_` 前缀」的断言搞挂了。而且「恢复」时 `localStorage.setItem = rawSet` 只是又把它换回一个同名自有属性，污染永久留下。正解是改 `Storage.prototype.setItem`。

**坑二：`bannerRestored` 是恒真断言。** 缺陷态下横幅从头到尾没显示过，`hidden` 天然为 `true`，于是「能收起」永远通过。反向验证时它照样 PASS，一眼看出不对。修法：先记 `bannerWasShown = (warnHidden === false)`，`bannerRestored` 改成 `bannerWasShown && hidden === true`。**「能收起」必须以「曾经显示过」为前提。**

**坑三：`reset` 按钮点不到。** 测完配额失败要清理探针，直接点「恢复上游」——但它只在面板展开且 `metaMap` 有该条目时才渲染，而保存后 `metaEditing = false`、面板已收起。于是清理静默失败，探针留在 `metaMap` 里污染后续断言。改成先点「编辑」重新展开、再存一次新值覆盖。

### 9.55.6 评估过但**不改**的写入点

`SETTINGS_KEY` / `PREFS_KEY` / `HIST_KEY` / `GOAL_KEY` / `DAYS_KEY` / `GIST_KEY` / `SYNCLOG_KEY` / `VIEWS_KEY` 共 8 处仍是静默 `catch`，有意保留：

- 丢的都是**可重建的派生状态**（排序、视图、搜索历史、打卡日期、目标、同步日志），页面重开时会回落默认值，用户看得见「设置没保住」。
- 这些写入**高频**（每次筛选变更、每次搜索、每次翻页都会写）。接上横幅会在配额满时持续弹提示，把真正的数据丢失信号淹掉。
- 例外是 `DAYS_KEY`（阅读打卡）：丢失会少一天记录。但它每天只写一次，且当天可见「今天没打上」，不需要常驻横幅。

**判断标准写在这里，供以后复查**：写入的内容**是不是用户手打、且界面上会显示「已保存」**。是 → 必须上报；不是 → 静默可接受。

### 9.55.7 顺带核过、结论是「没问题」的项

排查时一并查了这几处，都是能过但值得留下结论的：

- **`JSON.parse` 全部有保护**：脚本内共 14 处，逐处检查「向前 8 行内是否包在 `try` 里」，14/14 均受保护。`loadDrafts` / `loadDeleted` / `loadSettings` 等还有字段级校验（`/^\d+$/` 验 id、`typeof` 验对象、`slice` 截长度），坏数据不会流进内存。
- **函数声明提升已验证**：`isQuotaError`（4478 行附近）被 `persistMeta`（3432）前向调用，两者同在顶层作用域，`function` 声明提升保证可用。这是刻意的位置安排——放在统一上报旁边便于阅读，不必为「定义在前」而上移。
- **`storeFailed` 用 `Object.create(null)`**：不用 `{}`，避免 key 叫 `__proto__` 之类的写法污染原型链。虽然本项目的 key 都是常量，改一行不增加成本。
- **剩下 19 处空 catch 逐个确认过归属**：除本次修的 3 处，其余分两类——①可重建的派生状态（设置 / 偏好 / 搜索历史 / 打卡 / 目标 / 同步配置与日志 / 视图 / 备份时间戳）；②有意降级（`T2CN` 单字符异常不该拖垮整个搜索、`execCommand` 复制失败退回、`fetch` 不支持时退回普通请求、`sessionStorage` 隐私模式）。没有第三类。

### 9.55.8 验收

`verify` **247/247**（240 → 247），`check-shards` 27/27，`audit-search` 17/17，`check-data` 0 问题，`test-merge` 28/28，`check-deploy` 21 项排除 / 17 个运行时文件 / 10 个数据包。

版本 **1.24.4 → 1.24.5**，SW `yuc-ln-shell-v55` → **`v56`**（`index.html` 是运行时文件，按清单第 2 条升 SW）。版本五处一致：`index.html` meta + 页脚、`package.json`、`package-lock.json` 两处、`manifest.webmanifest`。

## 9.56 v1.24.6 导出安全、撤销不吞字段、横幅能销账（2026-11-27/28）

### 9.56.1 这一轮修的是什么

上一轮（9.55）解决的是「写失败不吭声」。这一轮顺着同一条线继续往下走，换了个问法：**数据已经写对了，有没有哪条路径会把它悄悄弄丢、弄坏、或者让用户误判状态？** 一共查出并修掉三处，全部做了反向验证。

### 9.56.2 CSV 导出：单元格里的裸 `\r` 会把一条记录拆成两行

`csvCell()` 本来已经防了公式注入（`^[=+\-@\t\r]` 前缀加 `'`），但「是否需要加引号」的判据是 `/["，\n]/` —— **漏了 `\r`**。而整行是用 `\r\n` 拼接的，于是含裸 `\r` 的单元格不会被引号包裹，表格软件读到单元格里的 `\r` 就当作行结束：一条记录被拆成两行，**后面所有列全部错位**。用户导出的备份表看起来还在，但已经不能用了。

`\r` 的来源不是手打 —— `textarea.value` 会把 `\r\n` / `\r` 归一成 `\n`，用户敲不进裸 `\r`。真实入口是**导入的 JSON** 和**云同步拉回的远端记录**，两处都是 `String(entry.note).slice(0, 1000)` 直接落地。所以这不是理论问题：一台 Windows 机器导出的备份，换到另一台再导入，笔记里的回车就变成了能拆行的字符。

修法：`return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;`

### 9.56.3 断言第一版是恒真的 —— `split('\r\n')` 抓不到裸 `\r`

诊断器最初写的是 `rows = body.split('\r\n')`，再判断「有没有哪一行含『第二行』却不含『第一行』」。这条判据**恒为 false**：`split('\r\n')` 只在 `\r\n` 序列处切分，裸 `\r` 后面不是 `\n`，根本切不开。缺陷态下实测 `rows:2 / split:false`，断言照样 PASS —— 典型的装饰性断言。

改成 `split(/\r\n|\n|\r/)` 后反向验证成功（缺陷态 `rows:3 / split:true`），但**修复态也 FAIL**（`badQuotes:2`）：引号内的 `\r` 也被切了。来回三次才对，最终改成按 RFC 4180 逐字符解析（引号内的分隔符不算行结束、`""` 转义）。

断言还加了 `hasProbe` 守卫生。第一版是空跑：探针只写 `localStorage`，而导出读的是内存 `myMap[id].nt`，CSV 里根本没有 `\r`，`hasProbe:false` 才把它暴露出来。修法是先走详情面板 UI 清空笔记（让内存与磁盘一致），再走导入写入探针。

### 9.56.4 批量操作撤销会永久吞掉书评与笔记

`bulkApply()` 撤销用的是 `myMap[id] = snapshot[id]` **整体替换**，而 `snapshot` 只存了 `s/t/vol/u/f/fm/ow/mu` 八个字段。于是 `r`（评分）、`rv`（短评）、`nt`（笔记）、`rvU`（短评时间）会被整个对象替换掉 —— 用户先写了几百字书评，再批量标记为「读完」，点一下「撤销」，**书评永久消失，没有任何提示**。

而批量操作本身完全不碰这四个字段，撤销当然也不该碰。修法改为逐字段写回：

```js
Object.keys(snapshot).forEach(function (id) {
  if (!myMap[id]) myMap[id] = {};
  Object.keys(snapshot[id]).forEach(function (k) {
    myMap[id][k] = snapshot[id][k];
  });
});
```

顺带核实了 `clearBtn`（清空我的阅读）的快照含全部 12 个字段，`toggleMine` 的 `prev` 是完整对象引用，云同步合并构造的 `next` 也是全字段 —— 这三处都没有同类问题，**不需要改**。

反向验证：把撤销改回整体替换，该断言 FAIL，诊断器输出 `after:{"s":"doing"}` —— `r/rv/nt/rvU` 全部消失。同时「按评分排序」和「统计页评分分布」两条断言也一起红了，说明数据是真的丢了，不是断言空跑。

### 9.56.5 失败横幅只会亮，不会收

`clearStoreFailure(key)` 按 key 粒度销账、全部销完才收起横幅 —— 设计是对的，但**只被 `META_KEY`（本地纠错）和 `DEL_KEY`（删除墓碑）两处调用**。`saveMine`（`STORAGE_KEY`）和 `persistDrafts`（`DRAFT_KEY`）完全没有销账调用。

后果：存储满时用户看到「有改动没能保存，刷新后会丢失」，按提示导出备份、清掉旧收藏、重新操作一次 —— 这一次**真的写进去了**（实测 `mineSaved:true`），但界面仍在喊「有改动没能保存」。用户无法判断数据到底救回来没有，只能反复导出、反复清理，最后干脆不信这个横幅。

修法：在 `saveMine` 与 `persistDrafts` 的 `setItem` 成功后各加一句 `clearStoreFailure(KEY)`。**不能用全局布尔量** —— 那正是 9.55 里已经踩过的坑：纠错写失败、收藏写成功，全局标志会把横幅撤掉，而纠错那份数据其实已经丢了。销账必须按 key 粒度。

新断言独立于既有的纠错用例（META 路径本来就有销账，只测它永远暴露不出 STORAGE_KEY 的问题）。反向验证：把 `clearStoreFailure(STORAGE_KEY)` 注掉，断言 FAIL（`bannerHiddenAfter:false`）；恢复后 PASS。

`SETTINGS_KEY` / `BACKUP_KEY` / `VIEWS_KEY` 属于偏好类配置，写失败不影响数据完整性，不纳入横幅记账。

### 9.56.6 已排查但确认无问题的方向

`escapeHtml` 唯一缺失的单引号转义未用于任何单引号属性；动态拼 `href` 仅 `#d=<数字ID>`；`highlightHtml` 用 `indexOf` + 分段转义、不构造 `RegExp`（无正则注入）；`metaFieldHtml` 全部转义；`parsePayload` 后 `mergeRemoteState` 有完整边界（id 正则、`Math.min/max` 夹取、`slice` 截长、`STATUS`/`FORMAT_KEYS` 白名单）；导入逻辑同样有边界与去重；14 处 `JSON.parse` 全部有 `try`；`textarea` 的 `maxlength` 与 `slice(0,140)/(0,1000)` 一致，不会静默截断。

已知但**未修**（评估后优先级低）：Markdown 导出中书名含 `]` 会提前闭合链接标签，属渲染问题、不丢数据。

### 9.56.7 验收

`verify` **247 → 251/251**（新增 4 条：CSV 裸回车前置条件、CSV 不拆行、撤销保留书评笔记、横幅销账），`check-shards` 27/27，`audit-search` 17/17，`check-data` 0 问题，`test-merge` 28/28，`check-deploy` 21 项排除 / 17 个运行时文件 / 10 个数据包。

版本 **1.24.5 → 1.24.6**，SW `yuc-ln-shell-v56` → **`v57`**（`index.html` 是运行时文件，按清单第 2 条升 SW）。版本五处一致：`index.html` meta + 页脚、`package.json`、`package-lock.json` 两处、`manifest.webmanifest`。

### 9.56.8 这一轮的方法论沉淀

1. **「断言绿了」不等于「断言在守护东西」。** `split('\r\n')` 那版在缺陷态下全绿，是靠反向验证才抓出来的。凡是新写的断言，必须把代码退回缺陷态重跑一次，确认它真的会 FAIL。
2. **筛样本再统计的断言必须加空跑守卫。** `hasProbe` 是后补的 —— 没有它，探针没进导出时断言会因为「没找到坏样本」而 PASS。判据：用例数为 0 就 FAIL。
3. **修一处的模式，要顺着同一模式查完所有同类点。** 修完 `bulkApply` 的整体替换，立刻 grep 了全部 `myMap[...] = ` 与快照构造点，逐个确认快照字段集是否完整 —— 这是 9.55「修根因要顺着扇出查完」的延续。
4. **状态记账要按 key 粒度，别用一个全局布尔量。** 这条在 9.55 已经写进教训，本轮又验证了一遍：两个写入点共用一条提示时，全局标志会让「A 写失败、B 写成功」把提示撤掉，而 A 的数据其实已经丢了。

## 9.57 v1.24.7 批量选择与可见范围对齐（2026-11-28）

### 9.57.1 这一轮修的是什么

沿着「数据已经写对了，有没有哪条路径会把它悄悄弄丢、弄坏、或者让用户误判状态」继续问，这轮盯的是**批量操作的作用范围**。查出一处，会让用户在完全看不见的情况下改到书。

### 9.57.2 切换筛选后批量选择不清空 —— 会在视野外改书

`bulkSel` 是一张「选中了哪些条目」的登记表。它的写入只有两处（点卡片、点选择框），清理也只有四类时机：进入/退出批量态、执行批量操作、切换 tab、应用保存的视图。**筛选条件变化时从来不清。**

于是这条路径成立：用户在「我的阅读」进入批量态，选中 2 本 → 点「已读」把状态筛选切过去 → 这 2 本里可能有一本根本不是「已读」，它从视图里消失了 → 底栏仍然写着「已选 2 本」 → 用户点「标记为想读」→ **那本他看不见的书也被改了**。而操作完成的提示仍然是「已标记为想读 2 本」，他没有任何线索知道多改了一本。

筛选入口有二十多处（`state.status` / `state.q` / `state.onlyMine` / `state.genre` / `state.fmt` / `state.ownedOnly` …），全部只改 `state` 再 `render()`，没有一处碰 `bulkSel`。逐处补清理不但要改二十几个地方，将来新增筛选条件时还会再漏一处。

修法：在 `render()` 里按**当前可见集合**统一对齐 —— 看得见的留下，看不见的从选择集里移除。

```js
function pruneBulkSel(list) {
  var keep = Object.create(null);
  for (var i = 0; i < list.length; i += 1) {
    keep[typeof list[i] === 'object' ? list[i].i : list[i]] = true;
  }
  var changed = false;
  Object.keys(bulkSel).forEach(function (id) {
    if (!keep[id]) { delete bulkSel[id]; changed = true; }
  });
  return changed;
}
```

**关键点：用 `list` 而不是 `shown`。** 列表是分页渲染的（`shown = list.slice(0, PAGE_SIZE)`），若按 `shown` 裁剪，用户翻页选中第 3 页的条目、再翻回第 1 页，第 3 页的选择就会被误清。`list` 是完整筛选结果，语义正确。

### 9.57.3 反向验证

把 `pruneBulkSel(list)` 注掉（改成 `if (0)` 保留调用形式），该断言 FAIL：

```
FAIL  切换筛选后批量选择清空  → {"selectedBefore":"已选 1 本","selectedAfter":"已选 1 本","barHiddenAfter":false}
```

恢复后 PASS：`selectedAfter:"已选 0 本"`、`barHiddenAfter:true`。

### 9.57.4 新断言污染了后续断言（第五次踩，这次自己抓到了）

第一版探针只做了「选中 → 切筛选 → 读计数」，**没有复原**。结果筛选停在「想读」，批量态也没退出，紧接着的「继续阅读快捷条」直接崩：

```
FAIL  我的阅读显示继续阅读快捷条  → {"hidden":true,"n":0,"id":"","meta":""}
Error: 页面脚本异常："TypeError: Cannot read properties of null (reading 'click')"
```

崩溃点是「继续阅读一键加一卷」找不到 `[data-cont="next"]` —— 因为筛选条件把那张卡过滤掉了。

这正是 MEMORY 里记的「验收脚本的新断言会污染后续断言」。修法是把「状态复原」当成断言块的一部分来写：切回 `[data-status="all"]`、退出批量态，并且**额外加一条断言验证复原本身成功**：

```js
check('批量筛选探针事后复原了视图状态',
  bulkStale.restoredStatus === true && bulkStale.restoredBulk === true, ...);
```

为什么复原也要断言：若复原失败，后面那批红是探针造成的**假红**，会把人引到完全错误的方向去排查。把「复原成功」显式写成一条断言，假红就会指向真正的原因。

### 9.57.5 顺带核实（确认不需要改）

- `setTab`、`applyStateMap`（应用视图）、`toggleBulk`、`bulkApply` 结束时都已显式清空 `bulkSel`，我的 `render()` 对齐是双保险，不冲突。
- 无任何代码持有 `bulkSel` 的对象引用（全部是 `bulkSel[id]` 直接访问），因此重建对象安全。
- 非批量态下只有在**确实有残留**时才重建对象（`Object.keys(bulkSel).length`），避免每次 render 无谓分配。
- `filteredList()` 返回的 `list` 是完整结果而非分页子集，裁剪语义正确。

### 9.57.6 验收

`verify` **251 → 253/253**（新增 2 条：批量选择对齐、探针复原自检），`check-shards` 27/27，`audit-search` 17/17，`check-data` 0 问题，`test-merge` 28/28，`check-deploy` 21 项排除 / 17 个运行时文件 / 10 个数据包。

版本 **1.24.6 → 1.24.7**，SW `yuc-ln-shell-v57` → **`v58`**（`index.html` 是运行时文件，按清单第 2 条升 SW）。版本六处一致。

## 9.58 v1.24.8 多标签页同时打开时的数据覆盖（2026-11-28）

### 9.58.1 这一轮修的是什么

前三轮修的都是「单页内的路径」。这轮换到**页面之外**：同时开两个标签页会怎样。

查出一条会真正丢数据的缺陷，而且场景极其常见。

### 9.58.2 saveMine 用内存整体覆盖磁盘 —— 另一个标签页的写入直接消失

`saveMine()` 原来是这一句：

```js
localStorage.setItem(STORAGE_KEY, JSON.stringify(myMap));
```

拿**内存里的整个对象**去覆盖磁盘。而 `loadMine()` 只在页面启动时读一次，之后永远不重新读。

于是同时开两个标签页：

1. A 页往收藏里加了 3 本 → 磁盘上有 7 本
2. B 页（早先打开的，内存里还是那 4 本）随便点一下收藏、改个状态、切一下进度
3. B 的 `saveMine` 把 4 本写回磁盘
4. **A 那 3 本直接从磁盘消失**。无报错、无提示。A 页内存里还显示着，刷新才发现没了

丢的不只是「加了一本书」这件事——连用户手写在那几本上的书评与笔记一起没了。

触发场景很常见：详情页链接在新标签页打开、手机上从主屏幕又开一次、误触「在新标签页中打开」、桌面端开两个窗口对比着看。

### 9.58.3 修法：写之前先与磁盘对齐

新增 `adoptForeignState()`，在 `saveMine` 写盘**之前**先读一眼磁盘，只把「本页完全不知道」的条目并入内存：

| 情况 | 处理 | 理由 |
|---|---|---|
| 本页已有该条目 | 以内存为准 | 内存才是本页的最新意图，磁盘可能更旧 |
| 本页墓碑里有 | 不并入 | 是本页刚删的，不能复活 |
| 磁盘墓碑里有 | 不并入 | 另一端删过，不能复活 |
| 磁盘有、本页没有 | 并入 | 另一端新增的，必须保住 |

反向也做了一次：磁盘墓碑比本页条目的更新时间更晚时，说明另一端删了，本页跟着删。

顺序不能反——写在前面就又把别人的数据盖掉了。

### 9.58.4 反向验证（两次，第二次才真正有效）

**第一次是恒真断言，没抓出来。** 探针走「移出我的阅读 → 看会不会复活」，然后拆掉 `myDeleted` 那行守卫 —— 断言照样 PASS。

原因是 `markDeleted()` 内部会**立刻** `persistDeleted()`：墓碑先一步写到磁盘，于是 `adoptForeignState` 里 `diskDeleted[id] > 0` 那条判断已经把复活挡住了，`myDeleted` 那行在实战中通常是冗余的。两条守卫互相兜底，拆任何一条都测不出来。

**第二次才构造出真正只考 `myDeleted` 的场景**：让墓碑写盘失败（`Storage.prototype.setItem` 拦 `del` 这个 key，抛 QuotaExceededError —— 这正是现实里墓碑写失败的原因：存储满）。此时内存有墓碑、磁盘没有，只有 `myDeleted` 能挡住复活。

```
缺陷态：{"deletedGone":false, "tombOnDisk":false}   → FAIL（书被复活了）
修复态：{"deletedGone":true,  "tombOnDisk":false}   → PASS
```

断言里还加了 `tombOnDisk === false` 作为**前提守卫**：如果盘上其实有墓碑，这条用例考的是另一条守卫，等于空跑。

### 9.58.5 顺带修的两处探针污染

两条新探针都需要「这本书在收藏里」，而它们中间会点「移出我的阅读」。第一版没复原，把后面四条移动端断言全带崩（`移动端筛选入口可见` / `筛选抽屉` ×3）。

修法：
- 每条探针末尾统一 `cleanup()`，且**任何提前 return 路径都要先 cleanup**；
- 探针自己保证前置条件（书不在收藏就先加回来），不依赖上一条探针留下的状态；
- 断言里加 `restoredInMine` / `restoredTab`，把「复原成功」也验一遍——复原失败时的红是假红，会把人引到错误方向。

### 9.58.6 顺带修的一个语法坑

探针注释里写了 `` `if (next === entry.vol) return;` `` —— **反引号在模板字符串里把字符串提前闭合了**，整个 `verify.mjs` 语法错误（`missing ) after argument list`）。这是第二次踩「verify 模板字符串吞东西」，写在注释里也一样会中招。改法：模板字符串内的注释不要用反引号。

### 9.58.7 验收

`verify` **253 → 255/255**（新增 2 条：跨标签不覆盖、墓碑未落盘时不复活），`check-shards` 27/27，`audit-search` 17/17，`check-data` 0 问题，`test-merge` 28/28，`check-deploy` 21 项排除 / 17 个运行时文件 / 10 个数据包。

版本 **1.24.7 → 1.24.8**，SW `yuc-ln-shell-v58` → **`v59`**。

### 9.58.8 未做但值得记

真正的多标签实时同步（`storage` 事件 + 合并后重绘）没有做。当前修复只保证**不丢数据**，不保证另一端立刻看到变化——用户仍需刷新。这是有意的取舍：`storage` 事件在部分浏览器/隐私模式下不可靠，而「不丢」比「实时」重要得多。若将来要做，注意别在事件回调里再 `saveMine`，否则两端会互相触发。

## 9.59 v1.24.9 保存失败时的连带丢失，与导出时的静默跳过（2026-11-28）

### 9.59.1 这一轮修的是什么

上一轮管住了「写盘前先对齐磁盘」。这一轮往下问一层：**如果写盘本身就失败了呢**？以及**导出时悄悄跳过了一些条目，用户知不知道**？

两处都指向同一件事——**失败时用户看不出来**。

### 9.59.2 保存书评失败时，草稿跟着一起没了

原来是这三行：

```js
clearDraft(id);      // 先清草稿
saveMine();          // 再写收藏
render();
```

`clearDraft()` 排在 `saveMine()` **前面**。而 `saveMine()` 在存储写失败时（配额满、隐私模式、被浏览器清理）不会抛到调用方，它只是内部记账。于是：

1. 用户写了三百字书评
2. 点保存，存储满了
3. 草稿先被清掉 → 三百字没了
4. 收藏写不进去 → 那条书评也没进去
5. 屏幕上照旧弹「书评已保存」

两份全丢，而提示说的是成功。这是最坏的一种组合：**数据没了 + 用户以为还在**。

修法是把顺序反过来，并且让提示跟着结果走：

```js
var saved = saveMine();
if (saved) clearDraft(id);
render();
renderDetail(id);
if (saved) {
  toast('书评已保存：' + (byId.get(id).cn || byId.get(id).n));
} else {
  toast('书评未能保存，内容已留在草稿里，请导出备份后重试');
}
```

`saveMine()` 改成返回布尔值（它本来就在内部记账，只是没把结果交出来）。**草稿只有在确实写成功之后才清**——写失败时草稿就是用户唯一的副本，不能动。

### 9.59.3 导出时跳过的条目，一个字都不说

`exportCSV()` 和 `exportMarkdown()` 里都有这么一句：

```js
var x = byId.get(id);
var e = myMap[id];
if (!x || !e) return;   // 没有书目信息的跳过
```

静默 `return`。跳过的情况是真实存在的：云同步合并过来的旧 ID，在当前书目快照里已经找不到对应条目。用户点了「导出 CSV」，看到「已导出 50 本」，而收藏里其实有 53 本——少的三本他不会知道，除非去数。

这两处都不丢原始数据（JSON 导出是全量的），但**用户不知道少的是哪部分、为什么少**。修法是分别计数并在出口处说明：

```js
// CSV
toast('已导出 CSV：' + (rows.length - 1) + ' 本' +
  (csvMissing ? '（另有 ' + csvMissing + ' 本缺书目信息，未列出；JSON 导出含全部记录）' : ''));

// Markdown —— 提示是 toast，一瞬就过，所以在文件里也写一条
if (mdMissing) {
  lines.push('', '> 另有 ' + mdMissing + ' 本在收藏里，但当前书目数据中没有对应条目' +
    '（多为云同步保留的旧 ID），未能列出。完整记录见 JSON 导出。');
}
```

Markdown 那边特意在**文件正文**里也留一条：toast 三秒就消失，而文件会被保存、发出去、几天后再打开；只有在文件里写明，看文件的人才知道少了什么。

### 9.59.4 反向验证

两条都各自独立回退验证过：

| 回退内容 | 缺陷态实测 | 结论 |
|---|---|---|
| `if (1) clearDraft(id)`（恢复「先清后备」） | `contentSurvives:false` | FAIL ✅ |
| 去掉 `csvMissing` 三元分支 | `csvToast` 无「另有 N 本」 | FAIL ✅ |
| `if (0) {` 包住 `mdMissing` 那段 | `mdMentions:false` | FAIL ✅ |

草稿那条断言带前提守卫，先确认「保存失败时草稿确实还在用户眼前」这件事真的被测到了：

```
{"draftBefore":"存满时写的短评","draftAfterFail":"存满时写的短评",
 "savedRv":"未保存草稿","contentSurvives":true,"bannerCleared":true}
```

`contentSurvives` 为真还不算完——`bannerCleared` 同时为真，说明失败记账在写成功后被正常销账了，横幅不会一直挂着。这两个性质互不依赖，都得验。

### 9.59.5 探针把 ghost 留在了内存里（第三次污染，这次是自己发现的）

写「导入跳过未知条目」那条新探针时，为了构造「磁盘有、内存没有」的状态，直接把 `6652` 写进了 localStorage。断言本身过了，但 `6652` 在内存里既没进 `myMap` 也删不掉——下一次 `saveMine` 又把它写回磁盘，把后面「导入跳过未知条目」的断言带崩（实际值 `6652,643973,666873`）。

修法：`Page.reload` 把内存清空。但这又引出第二个问题——刷新把「清除筛选后恢复列表」依赖的搜索态一起重置了。

所以刷新之后**立刻重建最小必要状态**：

```js
await page.reload(...);
await page.evaluate(() => { /* tab=all + 清空搜索框 */ });
```

教训是：**探针的清理动作本身也会产生副作用**。`reload` 看起来是最彻底的清理手段，但它清的是「整个页面状态」，不只是你想清的那一部分。凡是动过 `reload` 的探针，后面必须跟一段状态重建，不能假设「刷新完就干净了」。

### 9.59.6 顺带核实（确认不需要改）

- `exportJSON` 是全量导出，不含跳过逻辑，无需计数
- 「年度小结」的「另有 N 本未列出」是早就有的明示，与这轮同源，不用重复处理
- `clearDraft` 在删除路径上无害：删除本来就是要连草稿一起清

### 9.59.7 验收

`verify` **255 → 257/257**（新增 2 条：保存失败保草稿、导出跳过告知），`audit-search` 17/17，`check-data` 0 问题，`test-merge` 28/28，`check-deploy` 21 项排除 / 17 个运行时文件 / 10 个数据包。

`check-shards` 本轮连跑四次：**24/27 → 27/27 → 26/27 → 27/27**。失败项只在
「`ch` 重试后卷清单恢复」这条渲染类断言（`重试后仍未见 __LN_CH_READY`），每次出现的位置不同、
重跑即过，属 10.0 已记录的高负载假失败——本机同时跑着 `verify` 的无头浏览器时尤其明显。
判断依据：`verify` 的 257 项（含同类渲染断言）全绿，而版本号改动只涉及 meta / manifest / SW 缓存名，
不触及加载逻辑。**如实记录在这里，是因为「偶发失败」不能因为重跑过了就当作没发生** —— 若后续
连续三次稳定复现在同一条，就要按真缺陷查。

版本 **1.24.8 → 1.24.9**，SW `yuc-ln-shell-v59` → **`v60`**。

### 9.59.8 这一轮的判据

「写成功」和「写失败」在代码里往往只差一个返回值，但在用户那里差的是**要么东西还在、要么东西没了**。所以凡是「先清后备」的顺序，都要问一句：**如果后面那步失败，前面清掉的那份还有副本吗**？

导出那条的判据是另一句：**能力有边界不丢人，边界不说出来才丢人**。跳过就跳过，但得让用户知道跳过了几个、为什么跳过、完整数据在哪。

## 9.60 v1.24.10 保存筛选视图的三处静默（2026-11-28）

### 9.60.1 这一轮修的是什么

前几轮都在「收藏 / 书评 / 导出」这条主干上。这轮换到一条从来没被检查过的支线：**保存筛选视图**（`VIEWS_KEY`）。

三处问题，同一形状——**用户以为存上了，其实没有**。

### 9.60.2 上限 12 只写在逻辑里，界面上一个字都没有

```js
try { localStorage.setItem(VIEWS_KEY, JSON.stringify(arr.slice(0, 12))); } catch (e) { /* 忽略 */ }
```

`slice(0, 12)` 静默截断。存第 13 个视图时，**最早那个被挤掉**，而 toast 照旧是「已保存视图：XXX」。

这条比一般的静默失败更值得修，因为：视图是**用户自己命名**的东西。被挤掉的那个没法从数据里重新推出来——用户当初是按什么条件筛的、怎么起的名，只有他自己知道。而发现时机极晚：要等到某天打开视图菜单，才发觉少了一个，那时已经记不清少了什么。

这正是项目里那条判据：**丢的是什么、可再生吗、多久后才会发现**。三条全中。

修法两件：
1. 上限提成常量 `VIEWS_MAX`，逻辑和文案引用同一个值（否则改一处就静默不一致）；
2. 溢出时**说出被挤掉的那个名字**：

```
已保存视图：视图A13（已达上限 12 个，最早的「视图A1」被移除）
```

### 9.60.3 saveViews 的 catch 是空的，写失败照样说「已保存」

```js
} catch (e) { /* 忽略 */ }
```

存储满时 `setItem` 抛异常，被吞掉，函数正常返回，调用方接着 `toast('已保存视图：XXX')`。用户以为存上了，刷新后没有。

修法：`saveViews` 返回布尔，失败时走 `reportStoreFailure(e, VIEWS_KEY)` 记账（与其他存储键同一套横幅机制），调用方按结果分两句提示。

删除路径同样处理，并且**写失败时不重绘菜单**——按磁盘内容重绘会把刚删的那个画回来，看起来像「点了没反应」。保留旧菜单 + 常驻提示，至少状态自洽。

### 9.60.4 同名保存会存成两份

原来是 `arr.unshift(currentView(name))`，不做重名判断。用户改完筛选回菜单再存一次「高分未读」，就有了两条同名视图：占掉两个名额、菜单里长得一样、分不清哪个是新的。

修法：先按名字找，找到就 splice 掉再 unshift（等价于「移到最前并更新」），提示改成「已更新视图：XXX」以便和新建区分。

### 9.60.5 反向验证（四条，其中一条第一次是恒真的）

| 回退内容 | 缺陷态实测 | 结论 |
|---|---|---|
| `else if (0)` 跳过溢出告知 | `toastMentionsLimit:false` / `toastMentionsDropped:false` | FAIL ✅ |
| `var replaced = false`（不覆盖同名） | `same:2` | FAIL ✅ |
| `catch` 改回空、末尾 `return true` | toast 变成「已保存视图：写不进去的视图…」 | FAIL ✅ |
| 上限告知整段跳过 | 同上第一条 | FAIL ✅ |

**第一次反向验证时 `toastMentionsDropped` 在缺陷态下仍是 `true`。** 原因是我给视图起名 `视图1`…`视图13`，而 `'视图13'.indexOf('视图1') === 0` —— 子串命中，判断恒真。改成 `视图A1`…`视图A13` 且要求带书名号精确匹配 `「视图A1」`，才真正能区分。

这是本项目第 N 次踩「断言里的字符串匹配太宽松」。判据：**凡是用 `indexOf` 判断「文案里有没有提到某个值」，都要先确认这个值不是另一个值的子串**；最稳妥的是连同周围的定界符一起匹配。

### 9.60.6 探针怎么走真实入口

无头浏览器里原生 `prompt()` 会阻塞且无法交互，必须替身。第一版想用 `cloneNode` 换菜单节点，但 **clone 不复制事件监听器**，委托监听器会一起丢。实际不需要：`renderViewsMenu()` 只重设 `innerHTML`，而委托监听器挂在外层 `#viewsMenu` 上，不随 innerHTML 重建而丢失。

所以探针很简单：

```js
window.prompt = () => (names.length ? names.shift() : null);
// 点 #viewsBtn 开菜单 → 点 [data-view-save] → 每次都会 renderViewsMenu()
```

`menu.hidden = true` 复位成「关闭」再点按钮，才是真正的开菜单动作。

探针末尾复原三样并单独断言：`prompt` 还原成原生、`VIEWS_KEY` 清空、菜单 innerHTML 清空。**探针的复原动作本身也要被验**——复原失败时后续断言的红是假红，会把人引到完全错误的方向。

### 9.60.7 验收

`verify` **257 → 261/261**（新增 4 条：溢出声明、同名覆盖、写失败不谎报、探针复原），`check-shards` 27/27，`audit-search` 17/17，`check-data` 0 问题，`test-merge` 28/28，`check-deploy` 21 项排除 / 17 个运行时文件 / 10 个数据包。

版本 **1.24.9 → 1.24.10**，SW `yuc-ln-shell-v60` → **`v61`**。

### 9.60.8 顺带核实（确认不需要改）

- `saveSyncLog` 也截断到 20 条，但那是同步流水账，不是用户命名的东西，丢了不影响任何操作，**有意不动**；
- `loadViews` 的 `filter` 已挡掉非对象项，`applyView` 复用 `applyStateMap` 的校验，损坏的视图不会写入非法 `year` / `kind`；
- `renderViewsMenu` 用 `escapeHtml(v.name)` 输出，视图名里的 `<` `&` 不会破坏菜单结构。

## 9.61 v1.24.11 「显示更多」与首屏补齐抢同一个位置（2026-11-28）

### 9.61.1 这一轮怎么找到的

前几轮都是「读代码 → 怀疑某处 → 验证」。这轮换了方法：**先统计哪些交互入口从未被断言点过**。

```js
// 提取 index.html 里所有 $('id').addEventListener 的 id，
// 再看 verify.mjs 有没有提到过它
```

结果：**70 个绑定入口里有 26 个从未被 verify 提及**（`loadMoreBtn` / `copyViewBtn` / `detailShare` / `helpBtn` / `syncNowBtn` / `importBtn` / `moreMenu` …）。挑要写数据或动 DOM 结构的入口逐一看，`loadMoreBtn` 第一个就中了。

**覆盖率统计本身比读代码有效**：代码读起来每条路径都「看起来对」，而「从没被点过」是个客观事实，不用猜。

### 9.61.2 缺陷：两处追加互不知情

`render()` 首屏只建 `FIRST_BATCH = 60` 张，其余 180 张交给空闲回调补：

```js
var initial = paged ? shown.slice(0, FIRST_BATCH) : shown;
…
if (paged && shown.length > initial.length) {
  var appendRest = function () {
    var rest = shown.slice(initial.length);   // 补 60..240
    …
  };
  requestIdleCallback(appendRest, { timeout: 500 });
}
```

「显示更多」则这样算起点：

```js
var start = gridEl.querySelectorAll('.card').length;   // ← 数 DOM
var next = list.slice(start, start + PAGE_SIZE);
```

**用 DOM 卡片数当「已渲染到第几条」。** 用户抢在空闲补齐**执行前**点「显示更多」：

1. 首屏 60 张已出，补齐回调已排队但没跑
2. 点击 → `start = 60` → `slice(60, 300)` → 又插 240 张
3. 这 240 张里，第 60..240 条与首屏本批内容**完全重复**
4. 排队中的补齐回调随后执行 → 再插一遍 60..240

实测（探针）：**卡片 480 张，其中 180 张重复**。按钮文字也从 1726 倒退成 1786。

触发条件很现实：网络慢 / 主线程忙（首屏 240 张卡片 + 封面解码）/ 用户手快。而且重复卡片长得一模一样，用户会以为「这本书怎么出现了两次」。

### 9.61.3 修法：记账取代数 DOM

新增两个变量：

```js
var renderedCount = 0;   // 本批已渲染到第几条
var pendingFill = null;  // 待执行的空间补齐句柄
```

三处配合：

| 位置 | 改动 |
|---|---|
| `render()` | 渲染后记 `renderedCount = initial.length`；排队前先 `cancelPendingFill()` |
| 补齐回调 | 开头清 `pendingFill`；用 `if (renderedCount >= shown.length) return` 守卫；按 `renderedCount` 切片；执行后更新 `renderedCount` |
| `loadMoreBtn` | 先 `cancelPendingFill()`，起点用 `renderedCount`，完成后更新 |

**为什么不数 DOM**：DOM 里既可能有迟到的补齐插入，也可能有批量删除留下的空洞。「已渲染到哪」是逻辑状态，必须由逻辑自己记账。

### 9.61.4 反向验证（两次，第一次是假的）

**第一次：完全回退到修复前 → 主断言 FAIL（`dupFinal:180`），但第二条「剩余数不会倒退」PASS。**

那条断言是**恒真**的：迟到的回调把 DOM 插到 480，同时算出 `total - 240 = 1786`，而点击前也正好是 1786 —— 数字「没变大」，判据成立，可它根本没反映问题。

改成**UI 自洽性**：同一时刻取「按钮剩余 + DOM 卡片数」，总和应恒定（两者只是把同一批数据切成已显示/未显示两段）。缺陷态下 DOM 被插到 480 而按钮仍按 240 算，和从 **2026 跳到 2206**，立刻 FAIL。

第二次回退验证：

```
主断言：dupFinal:180          → FAIL
自洽性：sumAfter:2206 ≠ 2026  → FAIL
```

### 9.61.5 又一个「两条守卫互相兜底」

想单独撤 `renderedCount` 或单独撤 `cancelPendingFill` 来精确定位是哪条在起作用，结果**两次都 PASS** —— 因为另一条会兜住。只有同时撤掉三条改动（起点、取消、回调切片）才 FAIL。

这与 v1.24.8 的墓碑用例同形。**遇到「拆一条测不出来」，不要以为那条是废代码**：先确认它是不是被另一条覆盖了；要判断某条是否真的必要，得单独隔离出「只有它能挡住」的场景，否则两份都留着（冗余但正确），并在注释里说明这是双保险。

### 9.61.6 验收

`verify` **261 → 263/263**（新增 2 条：不产生重复卡片、按钮与 DOM 之和恒定），`check-shards` 27/27，`audit-search` 17/17，`check-data` 0 问题，`test-merge` 28/28，`check-deploy` 21 项排除 / 17 个运行时文件 / 10 个数据包。

版本 **1.24.10 → 1.24.11**，SW `yuc-ln-shell-v61` → **`v62`**。

### 9.61.7 还没查的入口（下一轮候选）

26 个未覆盖入口里，这轮只处理了 `loadMoreBtn`。剩下值得看的：

- `copyViewBtn` / `detailShare` —— 都复制 `location.href`，依赖 hash 已实时同步（`writeHash` 有 9 处调用，看起来完备，但没验过「复制出来的链接真的能还原视图」）；
- `importBtn` —— 导入 JSON，已有其他断言覆盖其数据层，但按钮本身没点过；
- `syncNowBtn` / `syncDisconnectBtn` —— 云同步，只在 `test-merge` 里测过合并逻辑，UI 路径未测；
- `helpBtn` / `moreMenu` / `paletteMask` —— 纯展示，优先级低。

**方法论沉淀**：覆盖率统计（哪些 id 从未出现在 verify 里）可以随时重跑，是低成本找盲区的手段，比逐行读代码靠得住。

## 9.62 v1.24.12 「复制视图链接」把正在看的书也复制出去了（2026-11-28）

### 9.62.1 这一轮查的是 9.61.7 的候选清单第一项

上一轮统计出 26 个从未被断言点过的入口。这轮取 `copyViewBtn` / `detailShare`（都复制 `location.href`）。

先做了一次 hash 往返测试：给一组非默认状态，看加载后能否还原——`view` / `theme` / `year` / 搜索词（含中文）都正确还原，`writeHash` 与 `parseHash` 参数表也对称（`ln` 有类型校验、`gb` 有白名单）。**往返本身没问题。**

问题出在「复制」这一步：复制的不是「视图」，而是「当前完整 URL」。

### 9.62.2 缺陷：视图链接里带着 d=<id>

`copyViewBtn` 原来只有一句：

```js
copyText(location.href, function (ok) { … });
```

而 `openDetail()` 末尾会 `writeHash()`，把详情 id 写进 hash：

```js
var deepId = modalId || pendingDetail;
if (deepId) parts.push('d=' + encodeURIComponent(deepId));
```

于是用户在详情面板里点「复制视图链接」，复制出来的是：

```
…/#tab=all&y=all&…&v=grid&t=dark&d=37782
```

对方打开后**直接弹开那本书的详情**，而不是看到筛选好的列表。按钮 `title` 写的是「复制包含当前筛选与视图的链接」——**视图里不含「我正在看哪本书」**。

顺带发现同一条链上的第二个问题：`t=`（深浅色）也在里面。深浅色是本机偏好，不该因为打开别人的分享链接就被改掉。

### 9.62.3 修法：重建参数表，剔除 d 与 t

```js
var url = location.href.split('#')[0];
var parts = [];
try { writeHash(); } catch (e) {}
String(location.hash || '').replace(/^#/, '').split('&').forEach(function (pair) {
  if (!pair) return;
  var key = pair.slice(0, Math.max(0, pair.indexOf('=')) || pair.length);
  if (key === 'd') return;   // 详情深链不属于「视图」
  if (key === 't') return;   // 深浅色是本机偏好
  parts.push(pair);
});
```

先 `writeHash()` 再读，是为了保证参数是最新的（页面刚打开、还没写过 hash 时 `location.hash` 可能是空的，直接读会复制出一个没有筛选的链接）。

### 9.62.4 反向验证

回退成 `copyText(location.href, …)` 后：

```
copiedHasDetail: true   → FAIL（复制结果里真的有 d=666873）
copiedHasTheme:  true   → FAIL
```

两条断言都带前提守卫：`hashHasDetail === true` / `hashHasTheme === true`。若 hash 里本来就没有这两个参数，用例考的是别的东西，等于空跑。

### 9.62.5 探针自己踩了子串陷阱（第三次）

第一版探针用 `copied.indexOf('d=') >= 0` 判断「有没有详情参数」。修复后的 URL 是：

```
…&kd=all&…
```

`'kd=all'.indexOf('d=')` —— **命中了**。于是修复态也报 `copiedContainsDetail: true`，差点误判「修复无效」。

改成按参数名精确匹配 `/[#&]d=/` 才对。这是本项目第三次踩同一类坑（前两次：`视图13` 命中 `视图1`、`'视图1'` 判据恒真）。**判据：凡「A 是否出现在 B 里」，先确认 A 不是另一个合法值的子串；URL 参数必须带上前导 `#` 或 `&`。**

### 9.62.6 顺带核实（确认无问题）

- `openDetail()` 末尾有 `writeHash()`，所以详情打开后 hash 是同步的，`detailShare` 复制的链接**确实能还原那本书**，无需修改；
- `copyText` 的三层降级（`navigator.clipboard` → `execCommand` → 失败提示）逻辑正确，失败时提示「复制失败，请手动复制地址栏链接」，不谎报成功；
- `navigator.share` 的 `AbortError`（用户主动取消）静默、其他错误回退复制，处理得当；
- hash 往返：`tab` / `y` / `kd` / `hc` / `gn` / `dup` / `rn` / `gr` / `o` / `st` / `om` / `hs` / `hm` / `v` / `ms` / `fmt` / `owd` / `q`（中文）/ `gb` 均可正确还原。

### 9.62.7 验收

`verify` **263 → 265/265**（新增 2 条：不带详情深链、不带主题），`check-shards` 27/27，`audit-search` 17/17，`check-data` 0 问题，`test-merge` 28/28，`check-deploy` 21 项排除 / 17 个运行时文件 / 10 个数据包。

版本 **1.24.11 → 1.24.12**，SW `yuc-ln-shell-v62` → **`v63`**。

### 9.62.8 还剩的入口

`detailShare`（本轮只验了它的前置 hash 同步，按钮本身仍未被点过——因为无头环境下 `navigator.share` 与剪贴板都不可用，需要替身）、`importBtn`（`fileInput` 的数据层已被 `test-merge` 覆盖，提示也已完整）、`syncNowBtn` / `syncDisconnectBtn`（云同步 UI 路径）。纯展示类（`helpBtn` / `moreMenu` / `paletteMask`）优先级低。

## 10. 已知风险与决策

### 10.0 验收基建：profile 隔离与等待上限（2026-11-27，三站对齐）

起因是跨项目对比时发现三份 `verify.mjs` 的浏览器启动/清理逻辑已经漂移出四种实现，本项目与 galgame 都缺番剧那边已验证的几项。本项目的两处改动：

**① profile 目录每次运行独立。** 原先写死 `ln-verify-profile`，只在 `rm` 失败时兜底改名。能跑，但每次都要白抛一次 `EBUSY` 异常，而且残留浏览器仍抱着旧目录。改为 `ln-verify-profile-<pid>-<时间戳>`，从源头避开竞争。

**② `finally` 补 `taskkill /T`（Windows）+ 等待 + 清理。**

- `child.kill()` 只杀父进程，Edge 派生的 renderer/GPU 子进程可能继续抱着 profile。Windows 用 `taskkill /PID x /T /F` 杀整棵树，其他平台退回 `kill()`。
- `taskkill` 返回时句柄常未释放，立刻 `rm` 会 `EBUSY`。补 `await sleep(600)`。
- 原来的 `rm` 失败被 `.catch(() => {})` **静默吞掉**——不报错，但 profile 永远留在临时目录。改为打印提示。

**反向验证（这一步很关键，我第一版结论是错的）**：把 `verify.mjs` 退回修复前，连跑两次，第 2 次出现 `239/240`，失败项是「全库就绪后按当前关键词自动刷新结果」，详情 `fullReady:false, dataLen:2026`。当时归因为「profile 未清理导致污染」，**但恢复修复版后同样连跑第 2 次仍然失败**——证明归因错了，profile 清理并不是这条失败的原因。

**真正的根因是等待上限不足**。查下去：

- 该场景由服务端注入 `fault.restDelay = 6000`（6 秒延迟）；
- 这个分片请求要等首屏渲染后由 idle 回调发出，**实测 reload 后约 3.0s 才发出**；
- 6s 延迟后返回、再解析，纯脚本实测「全库就绪」`__FULL_DATA_READY` 耗时 **9.1s**；
- 而代码里的等待是 `for (i<80) { ...; sleep(150) }` = **12s**，只剩不到 3s 余量；
- `verify` 跑到这里页面已累积大量状态、CPU 更忙，连跑时就把 12s 耗光；第一段循环**超时后静默退出、不报任何提示**，于是失败详情只显示末态的 `fullReady:false`，看起来像「刷新逻辑坏了」。

**改法**：上限 80 → 134 次（12s → 20s）；并把 `fullReady` 提出来作为独立字段计入判据与详情——「20s 内全库没加载完」是等待超时，「加载完了但结果没刷新」才是刷新逻辑缺陷，两者必须分得开，否则排查方向会被误导。改后连跑 3 次全绿，该断言详情显示 `{"fullReady":true,"hidden":true,"count":"1",...}`。

**教训**：① 断言超时后静默退出，会把「没等到」伪装成「功能坏了」；等待循环超时必须至少体现在失败详情里。② 偶发失败先做**归因实验**（回退修复、看是否复现），不要因为「改了某处之后不常见了」就认定是它导致的——我第一次就是这么错的。

**③ 补记（同日稍晚）：上面第 ② 条的 `taskkill /T` 并不够用。**

跑完一轮后仍有临时 profile 残留、`rm` 报 `EBUSY`，而日志里**没有任何清理失败提示**。查下去是两个独立问题：

1. **`taskkill /PID <pid> /T` 会静默失效。** Edge 首次用新的 `--user-data-dir` 启动时，`spawn` 出来的进程可能只是 launcher，它拉起真正的 browser 后自己就退了。`child.pid` 一失效，`/T` 无从展开子树，一个子进程都杀不到——但 `taskkill` 仍返回 0，从外部看像「已经处理过了」。实测残留 9～11 个 `msedge.exe` 仍引用着该 profile。
   兜底改为**按命令行含本轮 profile 目录名**精确匹配（`Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like "*<目录名>*" }`），不依赖父子关系、也不依赖 pid 存活。用目录**名**而不是完整路径：`-like` 里反斜杠是字面量，曾把它转义成双反斜杠导致匹配恒假、兜底静默失效。`wmic` 在新版 Windows 已移除，不要用。
2. **报告打完进程不退出。** `server.close()` / `ws.close()` 不保证句柄释放，残留句柄把事件循环拽住，进程挂着不走，它建的临时目录就一直被占用——所以「谁占着目录」的答案有时是这个没退出的 node 自己，而不是 Edge 子进程。改为 `main()` 完成后显式 `process.exit(process.exitCode || 0)`。

**这里必须如实标注反向验证的局限**：撤掉兜底后**并没有稳定复现残留**（连跑两次都是干净的），说明该失效是间歇性的、与 Edge 是否走 launcher 路径有关。因此不能宣称「已证明兜底必要」，只能说明「观察到 3 次残留、兜底后 3 次干净、撤掉后 2 次干净」。兜底的成本是几行代码，收益是消除偶发故障，保留。

**另记一个自己踩的坑**：显式退出最初写成模块顶层 `setImmediate(() => process.exit(...))`，而 `main()` 是 async、一调用就返回 Promise——`setImmediate` 在第一个 `await` 之前就触发，进程**当场退出**（实测只跑 1 秒、日志全空、什么都没验）。必须放在 `main().then(...)` 里。

三份 `verify.mjs`（番剧 / galgame / 轻小说）已按同一套结构对齐。


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
3. **验收**：`check-data` 0 问题、`test-merge` 28/28、`check-deploy` 通过（21 项排除 / 17 个运行时文件 / 10 个运行时数据包）、`verify` 265/265、`check-shards` 27/27、`audit-search` 17/17。
4. **CI**：commit → push `main`，六项自动验收（`check-data`、`test-merge`、`check-deploy`、`verify`、`check-shards`、`audit-search`）全绿。
5. **线上复核**：Pages 构建后确认 meta / 页脚版本、数据条数与 SW 缓存名。
6. **收尾**：更新 README / HANDOVER / 会话日志，打 `vN` tag。
7. **同源隔离**：缓存名与清理范围固定在 `yuc-ln-` 前缀，不触碰番剧 / galgame。
8. **许可**：MIT，署名 Deckard（见 `LICENSE`）。
9. **部署边界**：`_config.yml` 只发布运行时文件，排除脚本、报告、截图、文档、`package*.json` 与全部构建输入（完整核心、`data/*.json`）；`npm run check-deploy` 校验 21 项排除、17 个运行时文件（其中 10 个数据包）未被误排除、页面/SW 引用齐全。上线后确认 `/scripts/verify.mjs`、`/screenshots/desktop.png`、`/data/light-novels.js` 返回 404，运行时文件返回 200。

## 11. 交接提示词

> 接手 `c:\Users\ASUS\Desktop\collection project\轻小说`。先读 `README.md`、`HANDOVER.md`、`reports/session-log-2026-11-23.md`，再读 `../番剧/README.md` 和 `../番剧/index.html` 的对应区段。当前 v1.24.12 已完成，后续按第 10 节风险与决策、第 9.62 节最新记录推进；任何改动后运行 `check-data` / `test-merge` / `check-deploy` / `verify`（265 项）/ `check-shards`（27 项）/ `audit-search`（17 项），push/PR 由 CI 自动跑六项，不要修改 `../番剧`。分片加载失败的处理必须连到 UI 才算修完——只给 `onerror` 赋值、没有事件监听者或没有文案/重试入口，等于没修（v1.23.2 就犯过这个错，见 9.50）。搜索相关改动必须同时过「全角 / 繁体 / 全拼 / 罗马字 / 作者 / 省略标点」六类写法，另加 v1.24.1 的平假名 ↔ 片假名与长音符两种写法，见 9.51 / 9.52；`verify` 的搜索断言是抽样，判断覆盖率必须另跑 `audit-search`（对全库逐条，见 9.52）。`verify` 在机器负载高时可能因首屏卡片未渲染而大面积假失败（失败项集中在「卡片数量」类断言），先重跑一次再怀疑代码。完成后汇报：数据统计、verify 通过数、桌面与移动端截图、线上 URL。若数据字段与本文不符，先停下来说明差异再改。
>
> **子代理授权**：任务中可以分派适量子代理以加快进度，不必再问（可独立并行的调研、代码审计、多文件排查、批量验证、独立模块实现）。数量 **2–3 个**为宜，不为凑数硬拆；**禁止多个子代理同时修改同一文件**（会互相覆盖），同一文件的改动由主线串行完成。分工上子代理只做「读取 / 分析 / 出结论」或各自负责互不重叠的文件，主线负责整合、验证、提交与最终汇报。交给子代理的提示必须自包含（目标、已知事实、已排除项、具体文件路径或行号、验收标准），不要写「根据你的发现去修复」这类放权式指令。子代理产出只回到主线，**必须核验真实文件改动后**才对用户汇报。完整准则见工作区 `../.workbuddy/memory/MEMORY.md`。
