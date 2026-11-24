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
