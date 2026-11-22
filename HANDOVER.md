# 轻小说库 · 落实与交接

- 文档日期：2026-11-23
- 当前状态：**v1.1.4 完成**（数据、页面、书评、统计、Gist 同步、PWA、自动化验收 128/128）
- 模板项目：`../番剧`（Bangumi Anime Library v1.6.8）
- 模板线上：<https://xyykmkefke.github.io/bangumi-anime-library/>
- 目标版本：v1.1.4（已达成，补丁：书评草稿自动保留）

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
- 单页最多 20 条（`limit` 传 50 也只返回 20）。
- 2026-11-23 实测 `total = 4007`，日期范围约 1865–2026。
- **搜索接口有 1000 条上限**：`offset` 最多到 980，`offset=1000` 起返回空数组。因此不能直接按 offset 翻完 4000 多条。
- 解决：按 `rating_count` 分区（0-9、10-19、20-29、30-39、40-49、50-74、75-99、100-499、500-999、1000+），每区都小于 1000 条，区内再按 offset 翻页，最后合并去重。实测十个分区合计 4007 条。
- 搜索结果已包含 `infobox`、`tags`、`rating`、`collection`，无需逐条请求详情。
- 建议请求间隔 800ms，失败重试 4 次（2s / 4s / 6s 退避）。

数据构成（实测 4007 条）：

- `series: true` 1123 条（28%）：系列主条目
- `series: false` 2884 条（72%）：单册，或某个系列的卷
- 经 `/v0/subjects/{id}/subjects` 清洗后，`c = true` 子卷 2028 条，默认可见 1979 条
- 需要「隐藏系列子卷」清洗，否则搜索一个系列会出现多条重复

## 3. 抓取与产出

新增 `scripts/fetch-books.mjs`，参考 `../番剧/scripts/fetch-bangumi.mjs`：

- 复用 `requestPage` 的重试、`slim` 的压缩思路、`initials` 拼音
- 去掉季度逻辑，按 `rating_count` 分区，在各分区内按 offset 翻页
- 每页缓存到 `data/build/page-{分区}-{页码}.json`，中断可续跑；`--refresh` 清空缓存重抓
- 输出 `data/light-novels.js`：

```js
// 由 scripts/fetch-books.mjs 生成，请勿手动修改
window.LN_META = { generatedAt: '...', count: 4007, minDate: '...', maxDate: '...' };
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
| SW 缓存 | `yuc-ln-shell-v6` |
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
  rvU: 0         // 书评更新时间戳，独立于状态合并
}
```

- 状态文案：想读 / 在读 / 读完 / 弃读
- 状态改为 `done` 时自动 `f = Date.now()` 且 `vol = v`；离开 `done` 保留 `vol`，`f` 置 0
- 合并规则：同一条目按 `u` 取新；`vol` 取两者较大值；书评按 `rvU` 单独取新；删除用墓碑（保留 180 天）
- 导出 / Gist payload（version 2）：

```json
{
  "app": "yuc-light-novel-list",
  "version": 2,
  "exportedAt": "2026-11-22T00:00:00.000Z",
  "items": [
    { "id": 499, "status": "done", "vol": 8, "addedAt": 0, "updatedAt": 0, "finishedAt": 0,
      "rating": 9, "review": "短评", "note": "笔记", "reviewUpdatedAt": 0 }
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

1. `sw.js` 缓存名 `yuc-ln-shell-v6`，SHELL 包含 `./data/light-novels.js`；封面缓存上限 400 张，超出按插入顺序清理。
2. manifest 为「轻小说库」/「轻小说库」，主题色沿用石墨黑 + 靛蓝。
3. 已生成 180 / 192 / 512 PNG 图标，iOS meta 完整。

### Step 5 验收（已完成：124/124）

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
- [x] iOS 添加到主屏幕全屏启动
- [x] 375×812 筛选抽屉、44px 触控、无横向滚动

## 9.1 实施记录

- 页面为单文件 `index.html`，数据一次加载，不再有 `anime-lite` 分层。
- 新增「隐藏系列子卷」开关，默认开启；关闭后显示全部 4007 条。
- 类型筛选：`novel` 表示数据中无 `kind` 的普通轻小说。
- 卷进度仅在 `v > 0` 且条目在「我的阅读」时显示；读满自动转「读完」并写入 `f`。
- 相似推荐改为同类型 + 题材重叠 + 评分接近。
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

## 10. 已知风险与决策

1. 搜索接口 1000 条上限：必须按 `rating_count` 分区抓取，不能直接 offset 翻到底；数据增长后要重新核对各分区是否仍小于 1000 条。
2. Bangumi 书籍数据系列 / 单卷混杂：优先用关联接口的「单行本」标记，标题规则只兜底；若误判，用户可关闭开关看全部。
3. 部分条目缺日期 / 卷数 / 作者：留空，UI 显示「—」，不丢弃条目。
4. 封面为外链，首次需联网；离线显示首字占位（沿用番剧）。
5. 两个 Pages 站点同源：键名、缓存名、Gist 文件名必须唯一。
6. Gist Token 只存本机；建议只勾选 `gist` 权限。
7. 抓取是公开接口，务必限速 800ms、带 UA、失败退避，避免被风控。
8. 版本策略：补丁位修 bug / 样式，次版本加功能块，主版本才大改。

## 11. 交接提示词

> 接手 `c:\Users\ASUS\Desktop\音乐\轻小说`。先读 `README.md`、`HANDOVER.md`，再读 `../番剧/README.md` 和 `../番剧/index.html` 的对应区段。按第 8 节顺序实现 v1.0.0，每步运行 `check-data` / `verify`，不要修改 `../番剧`。完成后汇报：数据统计、verify 通过数、桌面与移动端截图、线上 URL。若数据字段与本文不符，先停下来说明差异再改。
