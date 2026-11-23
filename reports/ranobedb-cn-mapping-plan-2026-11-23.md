# RanobeDB 扩展书目中文名映射 · 任务方案

- 日期：2026-11-23
- 当前线上版本：v1.15.1（本方案为历史记录，未执行）
- 状态：**已按方案 B 全量执行并随 v1.15.2 发布**（8487 条，定稿 240 条），过程见 `reports/ranobedb-cn-pilot-2026-11-23.md`
- 目标：为 `data/light-novels-rn.js` 的 8,487 个扩展系列补 Bangumi 中文名，接受漫画版中文名与近似标题

## 1. 现状

- 扩展书目：8,487 个系列 / 31,254 卷，默认隐藏，`cn` 为空，只显示日文原名与英文名。
- 中文名只能从 Bangumi 回查；RanobeDB 本身只有 `ja` / `en` 标题。
- 已实测：
  - 严格规则（日文完全同名、年份 ±2、排除漫画、排除已收录）：1,664 条 ≥5 卷条目只命中 **1 条**。
  - 放宽规则（近似标题、接受漫画版）：前 300 条命中 **1 条**；后半段随机 21 条命中 **1 条**（约 5%）。
  - 4 分片并行速度约 **15 条/分钟**，全量 8,487 条约需 **9 小时**，预计最终补 **300–500 条**。
- 结论：瓶颈是 Bangumi 覆盖，不是并行度；全量继续跑收益低且误配风险高，已停止并回滚实验改动。

## 2. 方案选择

### 方案 A：全量映射（仅在可接受约 9 小时空跑时）

1. 重建 `scripts/link-ranobedb-cn.mjs`，按 4 个分片运行：
   ```bash
   node scripts/link-ranobedb-cn.mjs --shard=1 --shards=4
   node scripts/link-ranobedb-cn.mjs --shard=2 --shards=4
   node scripts/link-ranobedb-cn.mjs --shard=3 --shards=4
   node scripts/link-ranobedb-cn.mjs --shard=4 --shards=4
   ```
2. 匹配规则：
   - 用 Bangumi `/v0/search/subjects`，`keyword = 日文原名`，`type=1`，`sort=match`，`limit=10`；
   - 候选必须有 `name_cn`；
   - 标题：完全同名 > 包含关系（最短长度 ≥5）> 二元组 Dice ≥0.82；
   - 年份：完全同名允许 ±5 年，其余 ±3 年；
   - 漫画版允许，但降权；优先「有插图、无作画」的小说条目；
   - 卷数比例、评分、收藏数作为次级排序；
   - 每个标题结果缓存到 `data/build/ranobedb-cn-full/search/`，支持中断续跑。
3. 分片输出：`data/build/ranobedb-cn-full/shard-{N}.json`，每 25 条写回一次。
4. 合并：
   ```bash
   node scripts/link-ranobedb-cn.mjs --merge
   ```
   输出 `data/ranobedb-cn.json`：
   ```json
   { "source": "Bangumi", "checked": 8487, "matched": 0, "matches": { "ranobeSeriesId": { "cn": "中文名", "bgm": 123, "how": "exact|contain|near", "manga": true } } }
   ```
5. `scripts/build-ranobedb.mjs` 读取该文件，为条目写入 `cn`、`bgm`，并把 `py` 改为 `initials(cn || n)`；`LN_RN_META` 增加 `cnMapped`。
6. `check-data.mjs` 校验 `cn` 非空字符串、`bgm` 正整数、`meta.cnMapped` 与实际一致。
7. `verify.mjs` 增加：
   - `LN_RN_META.cnMapped > 100`；
   - 用一条有 `cn` 的扩展条目搜索中文名，确认能打开详情；
   - 详情显示中文名与 Bangumi 来源。
8. 版本：1.15.1，SW 缓存 `yuc-ln-shell-v33`；README/HANDOVER 更新映射数量与覆盖率说明。
9. 验收后提交、推送、检查 Pages。

### 方案 B：只补能稳定命中的子集（推荐）

- 只跑 `v >= 5` 的 1,664 条，预计 1.5–2 小时，补几十到一百多条。
- 或先跑热门/高卷数前 500 条，确认样本质量和误配率后再扩大。
- 好处：成本可控，人工抽查容易；代价：大部分短篇扩展仍无中文名。

### 方案 C：维持现状

- 扩展条目继续显示日文原名；中文搜索只对 Bangumi 核心库生效。
- 无额外请求、无版权/误配风险。

## 3. 执行清单（方案 A）

- [ ] 重建 `scripts/link-ranobedb-cn.mjs`（含 `--shard` / `--merge`，缓存与增量写回）
- [ ] 4 个分片后台并行，定期检查 `shard-*.json` 的 `checked` / `matches`
- [ ] 合并 `data/ranobedb-cn.json`
- [ ] `node scripts/build-ranobedb.mjs` 重建 `data/light-novels-rn.js`
- [ ] `node scripts/check-data.mjs`
- [ ] `node scripts/test-merge.mjs`
- [ ] `node scripts/verify.mjs`（版本改为 1.15.1 / SW v33）
- [ ] 抽查 30 条映射：中文名、Bangumi 链接、是否漫画版、是否外传
- [ ] 更新 README / HANDOVER / 版本 / SW
- [ ] `git add -A && git commit && git push`，检查 Pages 版本与 `LN_RN_META.cnMapped`

## 4. 风险

1. **误配**：近似标题可能把外传、漫画版、不同系列挂到同一中文名；必须抽查样本，必要时只保留 `exact` / `contain`。
2. **漫画版中文名**：中文名可能来自漫画改编，和小说版译名不完全一致；详情已标注 `bgm` 来源，可按需回退。
3. **接口限速**：并发超过 4 个分片容易超时；出现大量失败时降到 2 个分片、间隔 1.5 秒。
4. **缓存与中断**：分片文件每 25 条写回；中断后重跑会复用搜索缓存，但会从头遍历分片，耗时较短。
5. **数据体积**：`cn`/`bgm` 会让 `light-novels-rn.js` 增大约 100–200 KB，仍远小于 2.4 MB 的扩展包。

## 5. 验收标准

- `check-data` 问题总数 0；
- `test-merge` 20/20；
- `verify` 全部通过（含中文名映射检查）；
- `LN_RN_META.cnMapped > 0`，抽查中文名可搜索、详情链接正确；
- 线上 v1.15.1，SW `yuc-ln-shell-v33`；
- 若误配率超过抽查样本的 10%，只保留 `exact`/`contain` 并重新构建。

## 6. 回滚

1. 删除 `data/ranobedb-cn.json`；
2. 重新运行 `node scripts/build-ranobedb.mjs`（无映射文件时 `cn` 为空）；
3. 版本回退 1.15.0 / SW v32（或保留 1.15.1 但说明无中文名）；
4. 提交并推送，Pages 自动回滚数据。

## 7. 结论

- 并行加速本身有效，但 Bangumi 对这批扩展书目的覆盖只有约 5%，全量映射属于「高成本、低产出」。
- 建议先执行方案 B（≥5 卷或前 500 条），根据抽查质量再决定是否扩大到全量。
- 已按本方案执行完毕：全量 8487 条命中 240 条，人工剔除 6 条错配，随 v1.15.2 上线；实际耗时约 44 分钟，远低于原估的 9 小时，原因是 4 分片并行 + 缓存复用。
