# 轻小说库 · 本次会话日志与交接

- 日期：2026-11-23
- 会话结论：**v1.15.1 已上线并完成验收，当前无待提交改动**
- 线上：<https://xyykmkefke.github.io/light-novel-library/>
- 最新提交：`ddbf143 perf: 首屏核心拆包并后台补载剩余书目`
- 验收：`check-data` 0 问题 / `test-merge` 20/20 / `verify` 203/203
- 版本：`1.15.1`，Service Worker 缓存 `yuc-ln-shell-v33`

## 1. 本次会话完成内容

### v1.14.0 重复版本与册/故事卷

- 同名系列按「卷数最多 → 收藏最高 → ID 最小」选主条目，其余 79 条写入 `ver`，默认隐藏，不删除。
- 新增「显示重复版本」开关，写入 hash `dup=1`、本地偏好与保存视图。
- 新增 `chs`：上/中/下拆分卷按同一故事卷统计；当前 9,799 册 → 9,707 故事卷。
- 统计页新增「库内规模」，详情显示「N 册 / M 故事卷」。

### v1.15.0 RanobeDB 扩展书目

- 新增第二书目源 RanobeDB（ODbL）：≥2 卷、日文原名、与现有 Bangumi 标题去重。
- 当前扩展书目 **8,487 个系列 / 31,254 卷**，独立懒加载包 `data/light-novels-rn.js`，默认隐藏。
- 扩展条目使用 `rn: true` / `rid`，ID 预留 `800000000 + rid`；详情显示日文名、英文名、册数、发售日、封面与 RanobeDB 链接。
- 新增「显示扩展书目」开关，hash `rn=1`、偏好、视图、导入/同步、深链与「我的阅读」自动补载均已接入。
- 用 RanobeDB 精确同名补卷：10 个系列 / 22 卷，卷 ID `810000000 + book.id`，标记 `rvol`，由 `clean-series.mjs` 合并，不参与扩展书目隐藏。
- ISBN 回填：系列首卷 ISBN 从 216 补到 421；单册 ISBN 3,364 不变；脚本每 20 条写回，可中断续跑。
- 新增脚本：`build-ranobedb.mjs`、`fill-ranobedb-volumes.mjs`；`clean-series.mjs` 重建时会保留已有 extra 字段，避免覆盖 ISBN / 日文版日期。

### v1.15.1 首屏核心拆包

- `clean-series.mjs` 额外输出：
  - `data/light-novels-lite.js`：默认可见 1,925 条；
  - `data/light-novels-rest.js`：子卷 / 一般小说 / 重复版本 2,926 条。
- 页面只同步加载 lite；`loadRest` 在首屏渲染 3 秒后后台补载，搜索、统计、我的阅读、展开子卷、版本开关等交互会主动触发。
- 首屏核心 gzip：**约 369 KB → 197 KB**；剩余核心 gzip 约 184 KB，不阻塞首屏。
- SW 只预缓存 lite + 详情包；rest、卷包、扩展书目走运行时缓存；离线重开仍可加载全库。
- `check-data` 增加核心拆包完整性校验；`verify` 增加 3 项首屏/补载检查，共 203 项。

## 2. 当前数据口径

- 核心：4,851 条（轻小说 4,062 / 一般小说 789）
- 核心拆分：轻量 1,925 / 剩余 2,926
- 子卷：2,160 条；重复版本：79 条；默认可见：1,925 条
- 卷包：7,639 条；核心 + 卷包合计 12,490 条
- 扩展书目：8,487 个系列 / 31,254 卷（默认隐藏）
- 系列册数：9,799 册 / 9,707 故事卷
- 字段：ISBN 3,364、系列首卷 ISBN 421、书系 3,595、出版社 4,793、日文版发售日 2,950
- 文件：
  - `data/light-novels.js`（完整核心，构建脚本使用）
  - `data/light-novels-lite.js`（首屏）
  - `data/light-novels-rest.js`（后台补载）
  - `data/light-novels-extra.js`（详情拆包）
  - `data/light-novels-volumes.js`（卷包）
  - `data/light-novels-rn.js`（RanobeDB 扩展）
  - `data/ranobedb-volume-fixes.json`（补卷）

## 3. 未完成事项与已知问题

1. **RanobeDB 扩展书目没有中文名**
   - 扩展条目只有日文原名 / 英文名；RanobeDB 不提供中文标题。
   - 严格 Bangumi 回查：1,664 条 ≥5 卷条目仅命中 1 条中文名。
   - 放宽到漫画版 / 近似标题后实测覆盖率约 5%；全量 8,487 条约需 9 小时，预计只能补 300–500 条，且误配风险高。
   - 已停止实验并回滚数据，方案见 `reports/ranobedb-cn-mapping-plan-2026-11-23.md`。
2. **ISBN 回填未全量完成**
   - 单册 ISBN 3,364，系列首卷 421；仍有部分核心条目缺 ISBN。
   - 运行 `npm run find-isbn` 可从缓存继续，脚本每 20 条写回。
3. **扩展书目字段较少**
   - 没有作者、出版社、书系、Bangumi 评分；详情只显示册数、发售日、封面与 RanobeDB 链接。
4. **RanobeDB / Bangumi 镜像限速**
   - 并发 4 个分片时约 15 条/分钟；出现大量超时时降到 2 个分片、间隔 1.5 秒。
5. **导入边界**
   - 导入文件若包含尚未加载的剩余核心条目，依赖 `loadRest` 预先完成；导入按钮与文件选择已主动触发补载，但极端慢网下仍可能跳过个别记录。

## 4. 验证与部署

```bash
cd "C:/Users/ASUS/Desktop/collection project/轻小说"
node scripts/check-data.mjs   # 0 问题
node scripts/test-merge.mjs   # 20/20
node scripts/verify.mjs       # 203/203
git add -A && git commit -m "..."
git -c http.version=HTTP/1.1 push origin main
```

- 线上版本检查：`meta[name=version]` = 1.15.1；`sw.js` = `yuc-ln-shell-v33`。
- 线上文件：lite gzip 约 197 KB，rest gzip 约 184 KB，均返回 200 + gzip。

## 5. 后续建议

1. **中文名**：优先执行方案 B（只跑 ≥5 卷或前 500 条），抽查误配率；不要直接全量跑 9 小时。
2. **ISBN**：有空时运行 `npm run find-isbn` 继续回填，完成后跑 `check-data` 与 `verify`。
3. **首屏继续优化**：可做字段稀疏编码（约 -10 KB gzip）、把 `ch` 移出核心（约 -43 KB gzip）、封面 100w/200w 档；收益小于本次拆包，按需再做。
4. **数据刷新**：`fetch-data → clean-series → build-rn`；如改了卷关系或补卷，再跑 `check-data` / `verify`。

## 6. 本次提交记录

- `8537305` feat: 重复系列默认隐藏并区分册/故事卷
- `27da74e` feat: 接入 RanobeDB 扩展书目并补卷与 ISBN
- `1a8e9f1` docs: 新增 RanobeDB 中文名映射任务方案
- `ddbf143` perf: 首屏核心拆包并后台补载剩余书目

## 7. P0 收尾（2026-11-23 22:34）

- 路径迁移：接手路径由旧 `Desktop\音乐\轻小说` 改为当前 `Desktop\collection project\轻小说`，会话日志中的 `cd` 命令补引号。
- 统计口径：`scripts/check-data.mjs` 的「默认可见」统一为 `!c && !gn && !ver`，输出从 2691 / 2001 修正为 **1925**，与 lite 包一致；`问题总数：0` 不变。
- 最小 CI：新增 `.github/workflows/data-check.yml`，push `main` 与 PR 自动跑 `check-data` + `test-merge`（Node 22 / `npm ci`）；`verify` 依赖本机浏览器，继续本地执行。
- 文档同步：第 5 节 SW 缓存名 `v18` → `v33`；第 11 节接手提示词改为当前 v1.15.1 维护口径并加入 CI 说明；中文名方案文档的线上版本改为 v1.15.1，并标注为历史记录。
- 验证：`check-data` 问题总数 0（默认可见 1925）、`test-merge` 20/20、`npm ci --dry-run` 通过。

## 8. v1.15.2 扩展书目中文名映射（2026-11-23 22:41–23:55）

- 脚本：新建 `scripts/link-ranobedb-cn.mjs`（`--shard/--shards/--merge/--limit/--min-volumes/--delay/--out`），按标题哈希缓存到 `data/build/ranobedb-cn-pilot/search/`，分片每 25 条写回，支持中断续跑与 `blocklist.json` 人工剔除。
- 试点：`v>=5` 前 500 条 → 命中 51 条（10.2%），抽查 30 条误配 1 条，结论见 `reports/ranobedb-cn-pilot-2026-11-23.md`。
- 全量：8487 条 4 分片并行（1.2s 间隔）约 44 分钟，命中 246 条（2.9%）；命中率随系列变短明显下降，与方案判断一致。
- 复核：自动标记 56 条可疑项，再拆 3 份交子代理独立判定，交叉比对后确认 6 条错配并写入 `blocklist.json`：漫画译名错位（美石家）、不同作品（F91 → 初代高达小说版）、产品类型不同（哥布林杀手 TRPG → 漫画）、系列标记降级（寒蝉「解」、大圣女「ZERO」、蔷薇少女「0 Zero」）。定稿 **240 条**。
- 应用：`build-ranobedb.mjs` 读取 `data/ranobedb-cn.json` 写入 `cn` / `bgm`，`py` 改用中文名首字母，`LN_RN_META` 增 `cnMapped: 240`；`data/light-novels-rn.js` 2,376,812 → 2,385,844 字节（+8.8 KB）。
- 校验：`check-data` 新增 cn/bgm/cnMapped 断言，问题总数 0；`test-merge` 20/20；`verify` 新增「扩展条目可用中文名搜索」，共 **204/204**。
- 版本：1.15.1 → **1.15.2**，SW `yuc-ln-shell-v33` → **v34**；README / HANDOVER（新增第 9.34 节）/ manifest / 页脚 / 验收断言同步。
- 生效口径：扩展书目默认隐藏，中文名只在开启「显示扩展书目」后参与显示与搜索，默认 1925 条不变。

## 9. v1.15.3 扩展书目详情与导入修复（2026-11-24 00:03–01:05）

- 新增 `scripts/fetch-ranobedb-detail.mjs`：抓 RanobeDB 系列详情的作者 / 出版社 / 文库，只存必要字段，全量 8487 个系列 6 分片约 34 分钟（缓存 `data/build/ranobedb-series-detail/`）。
- `build-ranobedb.mjs` 写入 `au` / `pub` / `line`：覆盖 8468 / 8484 / 8232 条；`LN_RN` gzip 581 → 719 KB（+138 KB，仅在开启扩展书目时下载）。
- 导入竞态修复：合并逻辑改为 `loadRest().then(合并)`。修复前慢网下未补载的剩余核心条目会被判为无效记录永久丢弃；40 KB/s + 600ms 延迟实测，修复后导入成功写入「新增 1 本」。
- 深链修复：`hashchange` 命中剩余核心条目时补触发 `loadRest()`。
- ISBN 续跑：查询 653 条，系列首卷 421 → 850，单册 3364 → 3367，任一覆盖 3785 → 4217（87%）。
- 中文名 fallback：新增变体查询（去副标题 / 尾括号 / シリーズ），补查 375 次命中 0 条，变体多命中别部作品，匹配器正确拒绝；保留开关。
- 脚本健壮性：分片状态加 `shards` 校验、合并按 `rid` 去重（此前换分片数会导致重复计数）。
- 校验：`check-data` 0 问题（新增 au/pub/line 断言）、`test-merge` 20/20、`verify` 205/205（新增「扩展条目详情显示作者」）。
- 版本 1.15.2 → 1.15.3，SW `yuc-ln-shell-v34` → `v35`。

## 10. v1.15.4 中文名扩容：接入 RanobeDB 官方中文标题（2026-11-24 01:28–10:55）

- 结论先行：Bangumi 对这批冷门书目覆盖 2.8% 已接近天花板；RanobeDB 详情自带官方多语言标题（约 3%、与 Bangumi 重叠极低），是最合适的补充源。Wikidata 仅 8% 有 ID 且接口慢，放弃。
- 抓取：`fetch-ranobedb-detail.mjs` 缓存加入 `titles` 并支持 `--refresh` 重抓，6 分片约 31 分钟。
- 构建：`build-ranobedb.mjs` 引入 `opencc-js` 繁转简；优先级 Bangumi > RanobeDB 官方标题，且须含汉字。
- 结果：中文名 240 → 310 条（3.7%），RanobeDB 官方 70 条全部人工核对无误配；gzip 719 → 721 KB。
- 校验：`check-data` 0、`test-merge` 20/20、`verify` 205/205。版本 1.15.4，SW `yuc-ln-shell-v36`。

## 11. 接手复核与文档校准（2026-11-24）

- 接手状态：HEAD `9d69ac1`，工作树干净，`main...origin/main` 同步；版本五处一致（1.15.4，SW v36）；`check-data` 问题 0、`test-merge` 20/20（本次实测）。
- README 校准 3 处：`verify（203 项）` → 205；ISBN 3364/421 → 3367/850，并补「任一 ISBN 覆盖 4217 条（87%）」；`extra` 589 → 596 KB、`light-novels-rn.js` 2.38 → 2.9 MB（gzip 721 KB）。
- 复核「展开后共 11625 条轻小说」：3986 条非一般小说、非重复版本 + 7639 卷包 = 11625，口径正确，未改。
- ISBN 续跑结论：目标 221 条（220 条命中缓存、1 条新查询），新增 0；其中 57 条 RanobeDB 有结果但标题不匹配，164 条无结果。当前缺 ISBN 634 条 = 一般小说 291 + 日文标题 221 + 中英文标题 122；RanobeDB 可匹配部分已查尽，不建议放宽标题规则以免错配。
- 本次仅改文档，未改代码、数据与版本；无需重跑 `verify`。

## 12. 三站基线对齐（2026-11-24）

- 新增 MIT `LICENSE`（署名 Deckard）。
- CI 的 `data-check` workflow 接入 `verify`（205 项）：Ubuntu 安装 stable Chromium，`verify.mjs` 支持 `CHROME_PATH` 与 Linux 无沙箱参数；失败时上传 `screenshots/`。
- HANDOVER 新增 §10.1 发布检查清单，README 的 CI 说明同步。
- 版本不变（1.15.4，SW `yuc-ln-shell-v36`），无运行时改动。
- 本地 `check-data` 0、`test-merge` 20/20、`verify` 205/205；CI 三项全绿。

## 13. 部署边界与历史 tag 回填（2026-11-24）

- 部署边界：新增 `_config.yml`，用 Jekyll `exclude` 把构建/校验用完整核心 `data/light-novels.js`（1.24 MB）排除出 Pages；文件仍保留在仓库供 `check-data`、`find-isbn`、`build-*` 使用，页面与 Service Worker 均不引用它。
- 守卫：新增 `scripts/check-deploy.mjs`（`npm run check-deploy`），校验 `_config.yml` 排除项、5 个运行时数据文件存在、页面/SW 不引用完整核心；已接入 `data-check` workflow，CI 现为四项（`check-data`、`test-merge`、`check-deploy`、`verify`）。
- 历史 tag：回填 annotated tag `v1.15.0` → `27da74e`、`v1.15.1` → `1869d66`、`v1.15.2` → `0258e18`、`v1.15.3` → `f77294e`；`v1.15.4` 原指向 `9d69ac1`。远端 `git ls-remote --tags` 已确认全部存在且 peeled 提交正确。
- 版本与 SW 不变（1.15.4 / `yuc-ln-shell-v36`），无运行时改动，按 §10.1 不升版本、不升缓存。
- 本地：`check-data` 0、`test-merge` 20/20、`check-deploy` 通过。
- CI：commit `9658bf4` 四项全绿；Pages 构建 `built`。
- 线上复核：`/data/light-novels.js` 返回 **404**，`/data/light-novels-lite.js` 返回 **200**（554,085 字节），首页 meta/页脚仍为 1.15.4，`sw.js` 仍为 v36。

## 14. v1.15.5 缺失日期与系列字段补全（2026-11-24）

- 只读审计：核心 4851 条中缺日期 235、作者 106、出版社 58、插图 1158、书系 1256、封面 2；其中可本地推导的约 110 个字段，其余多为上游确实缺失。
- 详情补全：新增 `scripts/enrich-bgm-detail.mjs`（`npm run enrich-detail`），900ms 间隔查询 Bangumi 详情，342 条目标全部缓存到 `data/build/bgm-subject/`；候选写入 `data/bgm-detail-fills.json` 并随仓库提交。
- 命中：日期 **125/235**（47 条年精度、66 条月精度、12 条完整日期）；作者 0/106、出版社 0/58、封面 0/2——详情页同样为空，确认上游缺失，不再空跑。13 条明代 / 清代 / 多版本日期保持缺失。
- 本地继承：`clean-series.mjs` 新增「子卷→系列」共识继承（书系 8 / 插图 18 / 作者 12 / 出版社 4 / 首卷日 14 / 封面 0）与「重复版本」作者 / 插图继承（0 / 3）；只填空字段，不覆盖已有值。
- 结果：缺日期 235→96、作者 106→94、出版社 58→54、插图 1158→1137、书系 1256→1248；封面仍 2 条。
- 日期精度：`d` 允许 `YYYY` / `YYYY-MM` / `YYYY-MM-DD`；`check-data` 改为日历回验，页面新增 `dateText()` 显示「YYYY 年」「YYYY 年 M 月」，不臆造具体日。
- 测试：`check-data` 0、`test-merge` 20/20、`check-deploy` 通过、`verify` 205/205。`verify` 的页脚 / manifest / SW 断言改为读取 `package.json` 版本与 `yuc-ln-shell-vN` 模式，避免下次升版再次硬编码失败。
- 版本 1.15.4 → **1.15.5**，SW `yuc-ln-shell-v36` → **v37**；commit `bd5fbae`。
- CI 四项全绿；Pages `built`；线上 `/data/light-novels.js` 404、lite 200（554,377 字节）、首页 1.15.5、SW v37，lite 包内已含年精度日期。

## 15. Pages 部署边界收口与部分日期验收（2026-11-24）

- 部署边界：`_config.yml` 从「只排除完整核心」扩为完整排除清单（18 项）：`node_modules`、`scripts`、`reports`、`screenshots`、`data/build`、完整核心、5 个构建用 JSON、`.github`、`.automation`、`package*.json`、README / HANDOVER / LICENSE。
- 运行时白名单 12 个文件：`index.html`、`manifest.webmanifest`、`sw.js`、`icon.svg`、3 个图标、5 个运行时数据包；线上确认全部 200。
- 守卫：`scripts/check-deploy.mjs` 改为解析 `_config.yml`、校验 18 项排除、12 个运行时文件未被误排除、页面/SW 引用存在且未排除、完整核心不被引用。
- 验收：`verify.mjs` 新增第 206 项「部分日期按精度显示」——取一条 `d` 长度为 4 或 7 的条目，打开详情断言显示「YYYY 年」/「YYYY 年 M 月」。
- 文档：README / HANDOVER / §10.1 / 交接提示词同步为 206 项与完整部署边界。
- 无运行时改动，版本与 SW 不变（1.15.5 / `yuc-ln-shell-v37`）。
- 本地：`check-data` 0、`test-merge` 20/20、`check-deploy` 通过、`verify` **206/206**。
- CI：commit `75e072f` 四项全绿；Pages `built`。
- 线上复核：运行时 12 个文件全部 200；`/data/light-novels.js`、`/scripts/verify.mjs`、`/reports/…`、`/screenshots/desktop.png`、`/README.md`、`/HANDOVER.md`、`/package.json`、`/_config.yml` 等排除项均 404（少数首次探测遇到 CDN 503，重试后 404）。

## 16. v1.15.6 子卷索引拆包（2026-11-24）

- 首屏减负：`ch` 从 lite / rest 移除，完整核心保留供构建与校验，新增 `data/light-novels-ch.js`（1071 个系列 / 9799 条引用，95,721 B，gzip 34,442 B）。
- 体积：lite 554,377 → **469,286 B**（gzip 191,748 → **153,492 B，约 -20%**，线上 gzip 传输 157,696 B）；rest 689,394 → 682,633 B（gzip 170,490 B）。
- 运行时：`loadCh()` 在打开系列详情或一键加入子卷时加载并合并；`loadRest` 合并剩余核心时同步补 `ch`；`ln-ch-ready` 重渲染当前详情。
- PWA：SW 缓存升到 `yuc-ln-shell-v38`，`SHELL` 预缓存 ch 包（34.4 KB）以保住离线系列详情；首屏关键路径仍不等待 ch。
- 校验：`check-data` 新增索引包与核心 `ch` 的逐条一致性、系列归属、重复检查；`check-deploy` 运行时白名单加入 ch 包（13 个文件 / 6 个数据包）。
- 验收：`verify` 首屏断言不加载 ch 脚本；加载 rest/volumes/extra 后补载 ch，再校验 `chSeries` / `chRefs` 完整。
- 结果：`check-data` 0、`test-merge` 20/20、`check-deploy` 通过、`verify` 206/206。
- 版本 1.15.6，SW `yuc-ln-shell-v38`；commit `a7e889e`。
- CI 四项全绿；Pages `built`；线上版本 1.15.6、SW v38，lite / ch / rest / volumes / rn 均 200，完整核心 404。
- 口径说明：lite 关键路径减少约 34 KB；因 ch 预缓存供离线使用，首次安装总传输约等于旧的 lite（157.7 + 35.6 KB），收益在首屏解析/执行不被 ch 阻塞。

## 17. v1.15.7 封面 100w 档（2026-11-25）

- 实测封面：`r/100` 4,622 B / `r/200` 15,022 B / `r/400` 48,749 B；`r/300` 返回 400，不可用。
- `coverSrcset()` 改为 `100w / 200w / 400w` 三档；列表 `sizes=64px`、看板 `56px` 在 1x 屏取 100w，2x 屏取 200w；网格与详情行为不变。
- 继续阅读、想读队列的小缩略图从 `r/200` 改为 `r/100`。
- 验收：列表 / 看板断言同时校验 `sizes` 与 srcset 含 `100w`，总项数仍 206。
- 结果：`check-data` 0、`test-merge` 20/20、`check-deploy` 通过、`verify` 206/206。
- 版本 1.15.7，SW `yuc-ln-shell-v39`；commit `0287929`。
- CI 四项全绿；Pages `built`；线上版本 1.15.7、SW v39，首页已含 100w srcset。

## 18. v1.16.0 系列卷清单与自动进度（2026-11-25）

- 系列详情新增「卷清单」：默认折叠，标题显示「已读 X / N」与进度条；展开时补载剩余核心与卷包，逐卷显示标题、发售日与勾选状态。
- 自动进度：勾选一卷写入该卷「读完」记录；系列条目自动汇总已读卷数，全部子卷读完转「读完」；取消勾选回退为「在读 / 想读」。系列不在阅读列表时，首次勾选自动加入。
- 「标记下一卷已读」按卷号 / 发售日顺序取第一条未读；卷号从标题（第 N 卷 / (N) / 上中下）提取，缺失时按发售日与 ID 排序。
- 复用 `ch` 索引包：打开系列详情加载 ch；展开卷清单时再加载 rest 与卷包，不增加首屏负担。
- 验收：`verify` 新增 3 项（卷清单显示、展开加载、勾选与下一卷自动进度），共 209 项。
- 结果：`check-data` 0、`test-merge` 20/20、`check-deploy` 通过、`verify` 209/209。
- 版本 1.16.0，SW `yuc-ln-shell-v40`；commit `4ceef0d`。
- CI 四项全绿；Pages `built`；线上版本 1.16.0、SW v40，首页已含卷清单逻辑。

## 19. v1.17.0 卷清单封面与卡片入口（2026-11-25）

- 卷清单每行新增 36×48 封面缩略图，统一取 `r/100`（约 4.6 KB/张），懒加载；无图时显示书名首字占位。
- 系列卡片新增「子卷」按钮（`data-act="vols"`），点击直接打开详情并展开卷清单；按钮只在有子卷的系列上出现。
- 数据新增 `chn`（子卷数）：lite / rest 携带，完整核心同时保留 `ch`；`check-data` 校验 `chn` 与 `ch` 一致。
- 顺带修复 rest / 卷包条目封面路径未补图片域名的问题，卡片和卷清单缩略图现在都能正常显示。
- 验收：`verify` 新增 3 项（卡片入口、入口直接展开、卷清单封面），共 212 项。
- 结果：`check-data` 0、`test-merge` 20/20、`check-deploy` 通过、`verify` 212/212。
- 版本 1.17.0，SW `yuc-ln-shell-v41`；commit `70a79c8`。
- CI 四项全绿；Pages `built`；线上版本 1.17.0、SW v41，首页已含「子卷」入口。

## 20. v1.18.0 同步状态面板与合并统计（2026-11-25）

- 同步弹窗新增摘要：连接状态、上次同步时间、待同步改动、最近合并结果与最近 6 条同步记录（本地保留 20 条，键 `yuc_ln_synclog_v1`）。
- `mergeRemoteState` 增加可选统计对象，记录新增 / 远端较新 / 本地较新 / 同时更新 / 进度合并 / 墓碑删除；既有调用与返回值不变。
- 同步成功与失败都会写日志；常驻同步状态追加「待同步 N」，`bumpDirty` / `markBackup` 时实时刷新。
- 日志只存时间、结果与计数，不存书名或书评；Gist payload 协议未变。
- 验收：`test-merge` 新增 1 项合并统计，共 21 项；`verify` 新增 1 项面板断言，共 213 项。
- 结果：`check-data` 0、`test-merge` 21/21、`check-deploy` 通过、`verify` 213/213。
- 版本 1.18.0，SW `yuc-ln-shell-v42`；远端 commit `a6ce823`（Git HTTPS 被重置，改用 Git Data API 推送并对齐 tree）。
- CI 四项全绿；Pages `built`；线上版本 1.18.0、SW v42，首页已含同步状态面板。

## 21. v1.19.0 本地纠错与别名（2026-11-25）

- 详情页新增「本地纠错」：可改中文名 / 原名 / 作者 / 插图 / 出版社 / 书系 / 发售日，并补别名（≤8 个，逗号分隔）；日期接受「2019年5月3日」等写法并归一为 `YYYY` / `YYYY-MM` / `YYYY-MM-DD`。
- 纠错存 `yuc_ln_meta_v1`：只记被修正字段、别名、清空标记与更新时间；详情出现「本地」已纠错标记，可一键「恢复上游」。
- 覆盖在首屏与 rest / volumes / extra / rn 各数据包写入时套用；详情包后到时先把上游值记进快照再压覆盖，恢复时才回得去。
- 别名与书名 / 原名 / 作者同档参与搜索与相关度排序。
- JSON 导出与 Gist payload 升 version 3，新增 `meta` 一节按 `u` 双向合并；同步日志新增「纠错 N 条」。
- 验收：`test-merge` 新增 3 项（纠错合并、较新优先、字段清洗），共 24 项；`verify` 新增 5 项（纠错面板、保存覆盖、别名搜索、刷新保留、恢复上游），共 218 项。
- 结果：`check-data` 0、`test-merge` 24/24、`check-deploy` 通过、`verify` 218/218。
- 版本 1.19.0，SW `yuc-ln-shell-v43`；commit `f745259`。

## 22. v1.20.0 格式与藏书（2026-11-25）

- 阅读记录新增 `fm`（纸质 / 电子 / Web / 有声，空为未标记）、`ow`（藏书）与 `mu`（格式 / 藏书更新时间）。
- 详情页收藏后出现「格式」行，点选立即写入；「我的阅读」新增格式下拉与「只看藏书」，支持 chips 移除、hash / 偏好记忆与保存视图，清除筛选一并重置。
- 合并按 `mu` 整体取新：旧客户端不带 `formatUpdatedAt` 不会冲掉本地标记；远端显式取消可同步。`sameRecord` 改为逐字段比较，避免旧记录缺字段被误判为变化。
- payload 升 version 4，新增 `format` / `owned` / `formatUpdatedAt`；CSV / Markdown 导出补「格式」「藏书」。
- 统计页新增「藏书与格式」卡片（藏书数 + 四类格式计数 + 未标记）。
- 验收：`test-merge` 新增 4 项，共 28 项；`verify` 新增 4 项，共 222 项。
- 结果：`check-data` 0、`test-merge` 28/28、`check-deploy` 通过、`verify` 222/222。
- 版本 1.20.0，SW `yuc-ln-shell-v44`；commit `3ef895b`。

## 23. v1.21.0 数据刷新与 ISBN 补全（2026-11-25）

- `fetch-books.mjs --refresh-pages` 重抓全部分页（约 380 页，保留 rel 缓存）：核心 4851→5076（+231 新增；6 条上游已改标「漫画」按规则移除），轻小说标签 4201 / 小说 3427 去重后一般小说 788；系列 1306→1394，子卷 2160→2223，默认可见 1925→2026。
- 卷包 7639→7817；子卷索引 1071→1128 个系列 / 9799→10040 条引用。
- `find-isbn` 查询 285 条缺 ISBN 的日文条目：补 57 个系列首卷 ISBN（850→906），单册无新增；任一 ISBN 覆盖 4217→4396 条（86.6%）。
- `enrich-detail` 复查 143 条缺字段条目，上游仍为空（0 候选）；修复增量运行会用空结果覆盖既有 `bgm-detail-fills.json` 的问题（先载入旧候选再合并），125 条历史补全得以保留。
- 修复 `clean-series` 离线重算丢失 gn 修正的问题：抽出 `adjustGeneralFlags`，与在线抓取口径一致，87 条关联轻小说不再被误隐藏。
- 验收：`check-data` 0、`test-merge` 28/28、`check-deploy` 通过、`verify` 222/222（数据条数断言动态跟随 `LN_META`）。
- 版本 1.21.0，SW `yuc-ln-shell-v45`；commit `9ddfcda`。

## 24. v1.22.0 数据补全（2026-11-25）

- `enrich-openbd` 扩展：系列首卷 ISBN 也作为查询目标（此前 906 个只有 `fisbn` 的系列从未查过 openBD）。查询 651 个新 ISBN，补书系 307、日文版首发 968、出版社 3。
- 新增 `enrich-bgm-persons.mjs`：走 Bangumi `/persons`（relation 为中文「插图 / 作者 / 出版社 / 书系」），查询 1223 条缺插图或作者的条目，空数据 330，补插图 126、作者 69、出版社 2、书系 3；缓存可续跑。
- 新增 `fill-ranobedb-counts.mjs`：离线读 RanobeDB 目录，按日文原名精确匹配 1449 条，补 719 条缺失册数（取 max(RN 卷数, chn)）与 15 条首发日，产物 `data/ranobedb-counts.json` 由 clean-series 应用。
- 部署排除增至 19 项（新增 `data/ranobedb-counts.json`）；check-deploy 同步。
- 缺口：作者 101→32、插图 1205→1079、书系 1396→1086、出版社 60→55、日期 113→98、未知册数 3910→3191；日文版首发 2950→3918。
- 调研未采用：NDL Search（无 key、可 ISBN 反查，但新刊盲区 + 需本机代理，抽样 1/8 有 seriesTitle）、Google Books（匿名 429、要求 key）、RanobeDB release（无 imprint，补不了书系）。
- 结果：`check-data` 0、`test-merge` 28/28、`check-deploy` 通过（19 项排除）、`verify` 222/222。
- 版本 1.22.0，SW `yuc-ln-shell-v46`；commit `1a48339`。

## 25. v1.23.0 卷包日期与中文名试点（2026-11-26）

- C 卷包日期：新增 `enrich-volume-dates.mjs`，逐卷查 `/v0/subjects/{id}`；3 并发 + 700ms 间隔，缓存复用 `bgm-subject/`，`checked` 记录续跑。查询 7693 条，补发售日 7644、封面 2；卷包缺日期 7798→54，缺封面 51→49。
- F 中文名试点：新增 `fill-bgm-cn.mjs`，RanobeDB 繁中标题（opencc 转简）命中 0，Bangumi 同名条目回查 300 条命中 20；累计候选 23 条，缺中文名 2101→2078。
- E NDL：新增 `enrich-ndl.mjs`（OpenSearch、代理、429 退避）但**网络不可达**——直连与 IPv4 均超时，`iss.ndl.go.jp` 303 跳转到被墙域名，本机 7897 代理未运行；脚本就绪，代理恢复即可跑。
- `clean-series` 增加 `cn-fills` / `volume-fills` 应用；部署排除 19→21。
- 结果：`check-data` 0、`test-merge` 28/28、`check-deploy` 通过（21 项排除）、`verify` 222/222。
- 版本 1.23.0，SW `yuc-ln-shell-v47`；commit `29080fb`。

## 26. v1.23.1 修复加载期搜索假报「没有找到」（2026-11-26）

- 缺陷：首屏 lite 2026 本、rest 3050 本后台补；补齐前搜索未命中直接进 `renderEmptyRecovery()`，输出「没有找到」。`loadRest().onerror` 静默降级，失败不可辨。
- 复核推翻报告的三处判断：①`ln-rest-ready` 监听器注册在脚本顶层，早于底部启动 `render()`，事件不丢，`onload` 的 `render()` 本来就生效；②复现用例 `銃×石`(702088) 是 `gn:true` 一般小说，默认口径下全库加载完也搜不到，属正确行为；③rest 3050 条默认可见数为 0，lite 2026 条恰等于全部默认可见，「加载期 60.1% 搜不到」在默认口径下不成立。真实影响限于打开了「含一般小说/子卷/重复版本」或有收藏落在 rest 的用户。
- 真实缺陷：rest 失败时搜索仍报「没有找到」，页脚一直「正在加载全库…」。
- 修复：新增 `restFailed`/`restAttempts`；空结果插入 `!fullReady` 分支区分「加载中/失败」；`onload` 补 `if (state.q.trim()) render()` 兜底；新增 `ln-rest-failed` 监听与 `#retryRest` 重试（第 3 次起才带 `?v=`，保住 SW 离线兜底）；`updateDataHint` 区分失败态。
- verify 新增 4 项 + 测试服务 `fault.restDelay`/`fault.restFail` 钩子；新测试置于序列末尾并先清 SW 缓存。
- 结果：`check-data` 0、`test-merge` 28/28、`check-deploy` 通过（21 项排除）、`verify` 226/226（连跑两次）。
- 版本 1.23.1，SW `yuc-ln-shell-v48`。
