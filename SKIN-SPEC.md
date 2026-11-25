# 运营总控大屏 · 视觉规范（SKIN-SPEC）

配套源码：`opsDeck/opsDeckTheme.css`（令牌与组件类）、`tokens/tokens.css`（`--gd-*` 独立版）。
可视化对照：`showcase/skin-gallery.html`。

---

## 一、令牌表

### 文字

| 令牌 | 值 | 用途 | 备注 |
|---|---|---|---|
| `--gd-ink-strong` | `#37352f` | 标题、巨指标数字 | |
| `--gd-ink-body` | `#5a5854` | 正文 | |
| `--gd-ink-muted` | `#66635e` | 标签、次要说明 | 原 `#787774` 在 `#fbfbfa` 上对比度仅 **4.32**（低于 AA 4.5），已加深，实测 **5.78–5.98** |

### 描边（三档）

| 令牌 | 值 | 用途 |
|---|---|---|
| `--gd-line-main` | `#d3d1cb` | 卡片外框（沿用沽清母版） |
| `--gd-line-section` | `#e6e6e4` | 区块分隔（标题栏下缘等） |
| `--gd-line-soft` | `#efefed` | 行分隔 |

### 面

| 令牌 | 值 | 用途 |
|---|---|---|
| `--gd-surface` | `#fbfbfa` | 卡片标题栏、指挥条 |
| `--gd-canvas` | `#f6f6f4` | 画布底。**比卡片深半阶**，卡片靠这个色差浮起来 |

### 主色（深绿）

| 令牌 | 值 | 用途 |
|---|---|---|
| `--gd-brand` | `#2b593f` | 主色、达成、涨 |
| `--gd-brand-soft` | `#edf3ec` | 淡底（徽标底、热区在席） |
| `--gd-brand-line` | `#c4dcbc` | 描边（热区在席边框） |

### 语义色

| 令牌 | 值 | 用途 | 备注 |
|---|---|---|---|
| `--gd-danger` | `#d44333` | 严重、退款、跌 | |
| `--gd-info` | `#1c5598` | 信息、指派徽标、预留 | |
| `--gd-amber` | `#965400` | 预警 | 原 `#c26d00` 在 `#fdf6e3` 上仅 **3.55**，已加深，实测 **5.46** |
| `--gd-amber-soft` | `#fdf6e3` | 预警淡底、清台 | |

### 圆角与字号

| 项 | 值 | 说明 |
|---|---|---|
| `--gd-radius-card` | `4px` | 刻意做小，是「墨线表格」气质，不是卡片式 App |
| `--gd-radius-chip` | `2px` | 徽标、芯片、按钮 |
| 巨指标 `.ops-kpi-value` | `clamp(28px, 2.3vw, 40px)` | **1280 以下内容区约 1000px，4 列时单卡不足 260px，固定 40px 会溢出** |
| 卡片标题 `.ops-card-title` | `10px` / `letter-spacing .06em` / 大写 | |
| 异常标题 | `11px` / 600 | |
| 异常详情 | `10.5px` / `--gd-ink-muted` | |
| 图例 `.ops-legend` | `9.5px` | |
| 操作按钮 | `9px` | 配 `white-space: nowrap` |

## 二、深度与层次

**不用投影。** 卡片浮起来靠三件事叠加：

1. 画布 `#f6f6f4` 比卡片 `#fff` 深半阶；
2. `1px solid var(--gd-line-main)` 描边；
3. `box-shadow: inset 0 -1px 0 rgba(0,0,0,.02)` —— 底部一条内阴影，制造"压住"的实感。

卡片标题栏 `#fcfcfb` 比正文区浅一阶，形成纵向分区，避免整块白。

## 三、动效纪律

| 规则 | 原因 |
|---|---|
| 脉冲只作用于**描边与圆点**，不作用于文字 | 闪烁文字不可读 |
| 数字滚动逐位进行，每位固定 `1ch` 列宽 | 整体位移会在位数变化时抖动（9,999 → 10,002） |
| 位数变化时**不做**滚动，直接切换 | 新高位没有旧值可比 |
| `@media (prefers-reduced-motion: reduce)` 下全站动效关闭 | 无障碍 |

关键帧：`ops-pulse-danger`（2s 描边脉冲）、`ops-dot-breathe`（2s 圆点呼吸 0.86→1）、`ops-skeleton`（1.4s 流光）。

## 四、颜色语义口径

- **涨绿跌红**。这是经营指标口径（达成 = 好），不是证券的红涨绿跌。运营台没有证券语义。
- **严重度双编码**：`.ops-sev--danger` 实心圆、`--warn` 三角（`clip-path` 画，不引图标资源）、`--info` 空心圆。色弱也能分辨。
- **异常卡左侧 4px 红条**由 `.ops-anomaly-danger::before` 生成，不要额外加 DOM。

## 五、无障碍

| 项 | 做法 |
|---|---|
| 对比度 | 正文与标签均 ≥ AA 4.5（已实测修正两处不达标色） |
| 焦点 | `.ops-deck-scope :focus-visible` 统一 1px 墨绿描边 + 1px 外扩，不用蓝色 ring |
| 深色底焦点 | `.ops-hud :focus-visible` 改白描边 |
| 数字 | `.ops-num` 统一 `font-variant-numeric: tabular-nums`，避免跳动 |

## 六、已知坑（实测踩过，别重犯）

| 现象 | 根因 | 规避 |
|---|---|---|
| 异常带「知道了」被压成 27×51px 竖排三字 | 标题+数量+指派+知道了+关闭+箭头全挤一行，列宽仅 280/320 | 拆两行；操作控件加 `flex-shrink:0` + `white-space:nowrap` |
| 支付分布永远只有「未标记」一条 | 读了废弃字段 `payMethod`，真实写入的是 `paymentMethod` | 两个都读再归一化（见 `useOpsDeckData.ts` 的 `normalizePayKey`） |
| 事件流时间看起来倒流 | 跨天数据只渲染 `HH:MM:SS`，丢了日期维度 | 非今日补「昨 / MM-DD」前缀 |
| 事件流底部切半行 | 容器高度 115px，单行实际 33px | 按行对齐：4 行 132px / 7 行 231px |
| 三端对比 TOP3 芯片被下张卡遮住 | 固定 `h-[240px]` 只给内容 206px，实际需要 230px | `min-h-[240px]` + 内部 `h-full` → `min-h-full` |
| 营收在大屏上恒为 0 | `createdTime` 是纯时间（`"13:23:04"`）没有日期，`new Date()` 得 Invalid Date | 用 `orderMs()`，以 `updatedAt` 补日期锚点 |
