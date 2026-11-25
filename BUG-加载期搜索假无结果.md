# 缺陷报告：分片数据未就绪时搜索假报「没有找到」，且就绪后不刷新

- 项目：轻小说库（light-novel-library）
- 版本：v1.23.0
- 报告时间：2026-11-26
- 严重级别：**高**（影响 60% 藏书的可检索性，且错误结论不会自我纠正）
- 状态：待负责人认领修复（本报告不含代码改动）

---

## 一、缺陷摘要

页面采用「首屏加载 lite 分片，其余数据后台补」的渐进加载设计。在后台分片（`light-novels-rest.js`）尚未加载完成的时间窗口内搜索，**只会检索已加载的 2,026 条**，未命中的书会被判定为「没有找到符合条件的书目」；更严重的是，**分片加载完成后界面不会重绘**，用户看到的「没有找到」会一直停留，即使数据此刻已经进入内存。

现象等价于「书明明在库里，但搜不到，而且等多久都不会变」。

## 二、影响范围

| 项 | 数值 |
|---|---|
| lite 分片条数（首屏可见） | **2,026** |
| rest 分片条数（后台补） | **3,050** |
| 全库总条数 | **5,076** |
| 加载期无法被搜到的比例 | **60.1%**（3,050 / 5,076） |
| 其中 lite 内完全无同名条目的书 | 1,708 本 |

结论：加载窗口内，全库六成藏书处于「搜不到」状态。若用户网络较慢（rest 分片 712KB），该窗口可能持续数十秒。

## 三、复现步骤

1. 清空浏览器缓存后打开站点（确保走冷启动）
2. 在首屏出现后、页面底部「全库加载」提示消失前，立即在搜索框输入一本只存在于 rest 分片的书名，例如 `銃×石`
3. 观察结果区

**实际结果**：显示「没有找到符合条件的书目 · 试试只放宽一个条件：清除搜索「銃×石」 · 2026 本」
**预期结果**：应提示「数据还在加载，稍候」；且加载完成后自动出现该书

**关键问题**：等待 rest 分片加载完成（`window.LN_DATA` 长度从 2,026 变为 5,076）后，**结果区依然是「没有找到」**，不会自动刷新。

## 四、根因分析

### 4.1 空结果分支缺少「未就绪」判断

`index.html` 约 6200-6206 行，空结果的 `if (!list.length)` 分支按以下顺序判断：

```
state.tab === 'mine'      → 我的阅读相关文案
state.onlyMine            → 只看已收藏文案
state.hideMine            → 隐藏已收藏文案
state.hideChildren && !q  → 隐藏系列子卷文案
DATA.length               → renderEmptyRecovery()  ← 直接报「没有找到」
else                      → 数据还在生成中
```

**缺少 `!fullReady` 分支**。当 rest 未加载时分片数据不在 `DATA` 里，`filteredList()` 自然为空，代码直接走进 `renderEmptyRecovery()`，输出「没有找到符合条件的书目」这一**确定性否定结论**。

### 4.2 分片就绪后不按当前关键词重绘

`loadRest()` 的 `script.onload`（约 3611-3645 行）会 `dispatchEvent(new CustomEvent('ln-rest-ready'))`，监听器（**3649 行**）执行：

```js
fillFilterOptions();
renderYears();
updateDataHint();
if (modalId) renderDetail(modalId);
if (state.tab === 'stats') renderStatsPage();
else render();
```

这里**确实调用了 `render()`**，理论上会按 `state.q` 重新过滤。但实测未生效，需负责人进一步排查：

- 确认 `render()` 内部是否会因 `state.hideChildren`、`state.onlyMine` 等条件再次落入错误分支
- 确认 `ln-rest-ready` 监听器是否在 `DOMContentLoaded` 之后才注册（若 `loadRest` 在监听器注册前就 resolve，事件会丢失）
- 实测现象：`window.LN_DATA` 已为 5,076，页面仍显示「没有找到」，说明重绘链路存在断点

> 建议优先检查 `loadRest()` 返回的 Promise 与事件监听的就绪时序：`window.__lnLoadRest = loadRest` 在 3648 行暴露，而 `document.addEventListener('ln-rest-ready')` 在其后注册，若首次 `loadRest()` 由更早的调用点（如 7380 行 `if (!restLoaded) loadRest()`）触发，事件可能早于监听器注册而丢失。

### 4.3 对比：同架构的番剧项目已正确处理

番剧项目（v1.6.19）在相同位置有正确实现，可作为修复参考：

```js
} else if (!fullReady) {
  emptyEl.innerHTML = fullState === 'failed'
    ? '<b>全库数据加载失败</b>网络较慢或 CDN 不可用 <button class="btn" id="retryFull" type="button">重新加载</button>'
    : '<b>全库数据正在加载</b>最近一年已可用，稍候即可浏览其他年份';
} else if (DATA.length) {
  renderEmptyRecovery();
}
```

实测确认：番剧在加载期搜索全库独有番名（如「山海经密码」）会正确提示「全库数据正在加载」，且就绪后自动出结果 1 条。**该问题仅存在于轻小说项目。**

## 五、修复建议

### 建议 1（必做）补 `!fullReady` 分支

在 `state.hideChildren` 分支之后、`DATA.length` 之前插入：

```js
} else if (!fullReady) {
  emptyEl.innerHTML = restFailed
    ? '<b>全库数据加载失败</b>当前只搜了首屏书目 <button class="btn" id="retryRest" type="button">重新加载</button>'
    : '<b>全库数据正在加载</b>已加载 ' + DATA.length + ' 本，完成后会自动刷新结果';
} else if (DATA.length) {
```

需要新增 `restFailed` 状态标记：`loadRest()` 的 `script.onerror`（**3640 行**）目前只做 `restLoading = null; resolve();`，**失败与成功无法区分**，建议补 `restFailed = true` 并触发重绘，否则「加载失败」会被误报为「没有找到」。

### 建议 2（必做）确保就绪后按当前关键词重绘

排查 4.2 的重绘断点。稳妥做法是在 `loadRest()` 的 `onload` 内、`resolve()` 之前直接调用一次 `render()`，不依赖自定义事件的传递：

```js
restLoaded = true;
fullReady = true;
...
document.dispatchEvent(new CustomEvent('ln-rest-ready'));
if (state.q.trim()) render();   // 兜底：不依赖事件监听是否已注册
resolve();
```

### 建议 3（建议）失败可重试

参考 galgame v2.29.4 的实现，提供显式重试入口（带 `?v=` 时间戳绕过缓存），避免网络抖动后必须整页刷新。

### 建议 4（可选）首屏分片策略

当前 lite 仅 2,026 / 5,076（40%）。若希望降低该窗口影响，可评估把「最近 3 年 + 高热度」纳入 lite，或缩小 rest 体积。此项非必须，建议 1、2 落地后再评估。

## 六、验收标准

1. 模拟慢网（人为延迟 `light-novels-rest.js` 10 秒）：
   - 加载期搜索 rest 独有书名 → 显示「全库数据正在加载」，**不得**出现「没有找到」
   - rest 就绪后 → **自动**出现正确结果，无需手动重搜
2. 模拟失败（`light-novels-rest.js` 返回 503）：
   - 显示「全库数据加载失败」并提供可点击的重试按钮
   - 点击重试后能恢复全库检索
3. 回归：`npm run check-data` 0 问题；`npm run verify` 全绿；`npm run test-merge` 通过
4. 正常网络下真机验证：冷启动后立即搜索冷门书名，结果与加载完成后一致

## 七、附：本缺陷的通用模式（供参考）

凡「渐进加载 + 空结果即否定」的组合都存在同一风险。判断清单：

- [ ] 空结果分支是否区分「数据未就绪 / 加载失败 / 真的没有」三态？
- [ ] 后加载的数据完成后，是否按当前筛选与关键词**主动重绘**？
- [ ] 「就绪」标记的赋值是否在 `render()` **之前**？（顺序颠倒会导致重绘瞬时误判）
- [ ] 加载失败后，「仅部分数据」状态是否可恢复？（不要把 ready 置 true 了事）

番剧项目（v1.6.19）与 galgame 项目（v2.29.4 已修复）均满足以上四条，轻小说项目尚未满足第 1、2、4 条。

---

## 八、负责人复核结论（2026-11-26，v1.23.1 已修）

**采纳并修复**：空结果区分「加载中 / 加载失败 / 真的没有」三态；失败提供重试入口；就绪后按当前关键词重绘兜底。

**以下三处判断经实测不成立，已更正**：

1. **4.2「就绪后不重绘」是误判。** `ln-rest-ready` 监听器注册在脚本顶层，早于文件底部启动段的 `render()` 与 `loadRest()` 调用，事件不会丢失；`onload` 里的 `render()` 实测有效。测试方式：服务端把 rest 延迟 8 秒，加载期搜 rest 独有书 → 返回 0；放行后不重搜，`resultCount` 自动变 1。
2. **复现用例 `銃×石`（702088）不成立。** 该条 `gn:true`，属「一般小说」，默认口径下**全库加载完成后依然搜不到**（`resultCount=0`），打开「含一般小说」后才出 1 条。因此「等就绪后仍显示没有找到」看到的是**正确行为**，不是重绘失败。
3. **「加载期 60.1% 的书搜不到」在默认口径下不成立。** rest 分片 3050 条构成为：一般小说 788 + 子卷 2223 + 重复版本 79，**默认可见 0 条**；lite 2026 条恰好等于全部默认可见书目。真实影响面是：已开启「含一般小说 / 显示子卷 / 显示重复版本」的用户，或有收藏记录落在 rest 分片的用户（此类场景下缺陷真实存在，已复现）。

**真实缺陷（原报告未准确归因）**：rest 加载失败时静默降级，搜索仍报「没有找到」，页脚永远停在「正在加载全库…」。复现：rest 返回 503 → 打开「含一般小说」→ 搜 rest 独有书 → 显示「没有找到」，无重试入口。

**验证脚本**：`scripts/repro-rest-503.mjs`（失败场景）；延迟加载与默认口径反证已转成 `verify.mjs` 内的 `fault.restDelay` / `fault.restFail` 钩子与 4 项断言，随 CI 长期回归。
