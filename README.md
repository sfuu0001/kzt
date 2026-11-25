# 运营总控大屏 · 视觉皮肤源码包

导出时间：2026-11-25　　来源工程：`C:/Users/Public/wb-p0-ws`　　来源提交：`442a33b`　　本地构建：`v2.9.8bd1cb56`

> 这是一个**源码包**。`showcase/` 下的样品间与截图只是设计说明，用来让不装环境的人也能看到皮肤长什么样；
> 真正要复用的东西在 `opsDeck/` 和 `tokens/`。

---

## 一、源码清单（主体）

| 文件 | 行数 | 是什么 |
|---|---|---|
| `opsDeck/OpsDeckV2.tsx` | 1668 | **大屏主体**。指挥条 → 巨指标带 → 主图表区 → 异常带 → 事件流，全部结构与 Tailwind 类名都在这 |
| `opsDeck/opsDeckTheme.css` | 358 | **皮肤本体**。`--gd-*` 令牌 + 全部 `.ops-*` 组件类（卡片 / 巨指标 / 严重度 / 脉冲 / 热区 / 骨架 / 空态…） |
| `opsDeck/OpsDeckPrimitives.tsx` | 125 | 滚动数字 `RollingNumber`、迷你趋势线 `Sparkline`，纯展示、无业务依赖 |
| `opsDeck/RevenueChart.tsx` | 261 | 营收曲线（柱状增量 + 今日累计实线 + 昨日同时段灰虚线 + hover 三值），Canvas 手绘，不依赖图表库 |
| `opsDeck/useOpsDeckData.ts` | 683 | 数据层：ticker / 指标 / 异常 / 事件流 / 曲线 / 三端 / 支付分布 + `orderMs` 日期锚点修复 |
| `opsDeck/useOpsLocalData.ts` | 273 | 本地状态层：消音、指派、关闭留痕（已处理 / 误报）、布局偏好、localStorage 读写 |
| `tokens/tokens.css` | 61 | 从 `opsDeckTheme.css` 抽出的 `--gd-*` 令牌，做成 `:root` 版，可脱离大屏单独引 |

合计约 3,429 行。

## 二、设计说明（非源码，供对照）

| 文件 | 说明 |
|---|---|
| `showcase/skin-gallery.html` | 零依赖样品间。只引 `opsDeckTheme.css` + 少量内联栅格，双击即开，不需要 Node / 构建 / 网络 |
| `showcase/screenshots/deck-1600.jpg` | 真实大屏首屏（1600×1000） |
| `showcase/screenshots/deck-1600-bottom.jpg` | 真实大屏下半屏（退款与取消 + 事件流） |
| `showcase/screenshots/anomaly-band.jpg` | 异常带细节（两行布局、按钮不竖排） |
| `SKIN-SPEC.md` | 令牌表、字号、间距、圆角、动效纪律、颜色口径 |
| `INVENTORY.csv` | 每个文件的行数与体积 |

## 三、这个包里**没有**什么

这是「大屏皮肤层」切片，**不能独立编译**。要跑起来还缺：

| 缺的东西 | 引用处 | 说明 |
|---|---|---|
| `src/types` 的 `Order` / `TableItem` / `DishItem` | `OpsDeckV2`、`useOpsDeckData` | 领域类型。本包假定外部注入 |
| `src/utils/realtimeSync` 的 `isRealtimeConnected` / `getRealtimeDiag` | `OpsDeckV2` | 通道健康探测（决定顶部红色「数据通道异常」条） |
| `src/components/merchant/OperationsControlHub.tsx` | — | 页签壳，把 `<OpsDeckV2 ... />` 挂到「总览台」页签 |
| Tailwind v4 | `OpsDeckV2` | 结构用的全部是 Tailwind 工具类；`opsDeckTheme.css` 只负责皮肤词表 |

外部 npm 包：`react`、`lucide-react`、`tailwindcss`。

> 移植时替换掉上面三处 import 即可（`Order` 类型至少要有 `id / orderNo / status / totalAmount / createdTime / updatedAt / channelType / paymentMethod / payMethod / tableCode / refundReason / items`）。

## 四、怎么用

**只想看效果**：双击 `showcase/skin-gallery.html`。

**想在自己项目里用皮肤**：

```html
<!-- A. 挂容器类，令牌随作用域走（推荐，可与其它主题共存） -->
<link rel="stylesheet" href="opsDeck/opsDeckTheme.css">
<div class="ops-deck-scope">
  <div class="ops-card"><div class="ops-card-head">...</div></div>
</div>

<!-- B. 只想拿变量，令牌落 :root -->
<link rel="stylesheet" href="tokens/tokens.css">
<div style="background: var(--gd-brand)">...</div>
```

**想改配色**：只改 `opsDeckTheme.css` 里 `.ops-deck-scope { --gd-* }` 那一段，全局跟着变。**不要**在组件里写死 hex。

## 五、几条硬约束（改之前务必知道）

1. **两套色板不许混**：全站主色是冷蓝 `--sc-*`（#006494），运营台刻意用暖中性底 + 深绿，跟菜品沽清页同母版。混用会立刻显脏。
2. **涨跌是经营口径**：涨绿、跌红（不是证券的红涨绿跌）。
3. **严重度双编码**：圆点 / 三角 / 空心圆 + 颜色，色弱可辨，不许只用颜色。
4. **动效只碰描边和圆点**，绝不碰文字。`prefers-reduced-motion` 下全关。
5. **异常卡必须两行**：一行放标题+指派，一行放详情+操作。挤成一行时（异常带列宽仅 280/320）「知道了」会被压成 27×51px 竖排三字，2026-11-25 实测踩过。
6. **巨指标字号用 `clamp(28px, 2.3vw, 40px)`**：1280 以下内容区只有 ~1000px，4 列时单卡不足 260px，固定 40px 会溢出。
