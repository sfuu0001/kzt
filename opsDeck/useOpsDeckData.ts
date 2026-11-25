import { useEffect, useMemo, useRef, useState } from 'react';
import type { Order, TableItem, DishItem } from '../../../types';

/* ============================================================================
 * 运营总控大屏 · 数据派生与分层刷新
 * ----------------------------------------------------------------------------
 * 设计稿 §5.1：三层节奏
 *   L1 1s  —— 时钟、倒计时（本文件只暴露 clock，渲染层按需订阅）
 *   L2 5s  —— 4 个巨指标、异常计数
 *   L3 30s —— 渠道/支付占比、曲线全量重算
 *
 * 为什么用单一 rAF 循环而不是三个 setInterval：
 * 12 张卡片各自 setInterval 会在同一帧堆积 setState，造成掉帧；
 * 一个循环分发三个 tick 号，重计算全部走 useMemo，帧成本可控。
 * ========================================================================== */

export interface OpsTicker {
  /** 秒级：每 1000ms +1，仅用于时钟与秒级倒计时 */
  clockTick: number;
  /** 聚合级：每 5000ms +1 */
  aggTick: number;
  /** 结构级：每 30000ms +1 */
  slowTick: number;
  /** 当前时间戳（随 clockTick 更新，避免渲染层各自 new Date） */
  now: number;
  /** 页面是否在前台（后台标签页全暂停） */
  visible: boolean;
}

export function useOpsTicker(): OpsTicker {
  const [clockTick, setClockTick] = useState(0);
  const [aggTick, setAggTick] = useState(0);
  const [slowTick, setSlowTick] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const [visible, setVisible] = useState(() => (typeof document === 'undefined' ? true : !document.hidden));

  const lastRef = useRef({ clock: 0, agg: 0, slow: 0 });

  useEffect(() => {
    let raf = 0;

    const loop = () => {
      raf = requestAnimationFrame(loop);
      if (typeof document !== 'undefined' && document.hidden) return;

      const t = Date.now();
      const last = lastRef.current;

      // L1：秒级
      if (t - last.clock >= 1000) {
        last.clock = t;
        setNow(t);
        setClockTick((v) => (v + 1) % 100000);
      }
      // L2：聚合级
      if (t - last.agg >= 5000) {
        last.agg = t;
        setAggTick((v) => (v + 1) % 100000);
      }
      // L3：结构级
      if (t - last.slow >= 30000) {
        last.slow = t;
        setSlowTick((v) => (v + 1) % 100000);
      }
    };

    raf = requestAnimationFrame(loop);

    // 标签页切回：先补一次全量，再恢复节奏（避免补帧风暴）
    const onVisible = () => {
      const isVisible = !document.hidden;
      setVisible(isVisible);
      if (isVisible) {
        lastRef.current = { clock: 0, agg: 0, slow: 0 };
        setNow(Date.now());
        setAggTick((v) => v + 1);
        setSlowTick((v) => v + 1);
      }
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  return { clockTick, aggTick, slowTick, now, visible };
}

/* ============================ 派生结构 ============================ */

export interface OpsMetrics {
  revenue: number;
  /** 与昨日同时段对比的百分比；昨日无数据时为 null */
  deltaPct: number | null;
  prevRevenue: number;
  inProgress: number;
  /** 平均出餐（分钟），无已完成单时为 null */
  avgServeMin: number | null;
  p50: number | null;
  p90: number | null;
  occupied: number;
  totalTables: number;
  occupancyPct: number;
  /** 24 点迷你趋势：近 12 个 5 分钟桶 */
  revenueTrend: number[];
  orderTrend: number[];
}

export type AnomalySeverity = 'danger' | 'warn' | 'info';

export interface OpsAnomaly {
  id: string;
  severity: AnomalySeverity;
  title: string;
  count: number;
  /** 首条明细，例如「A3 · 超时 18 分钟」 */
  detail: string;
  /** 点击跳转的页签 id */
  tab?: string;
  kind: 'serve_timeout' | 'pending_timeout' | 'refund' | 'soldout' | 'table_long_stay' | 'low_stock' | 'printer_offline' | 'shift_diff' | 'rider_capacity';
  /** 30 分钟内被值班经理确认过：不再脉冲，视觉降级 */
  acked?: boolean;
  /** 展开明细（最多 3 条）：spec §10「每条可展开首 3 条明细」 */
  items?: string[];
}

export interface OpsEventItem {
  id: string;
  at: number;
  text: string;
  tone: 'normal' | 'warn' | 'danger' | 'ok';
}

export interface RevenuePoint {
  /** 桶起点时间戳 */
  t: number;
  amount: number;
  cum: number;
}

export interface ChannelSlice {
  key: 'dine_in' | 'delivery' | 'pickup';
  label: string;
  count: number;
  amount: number;
  color: string;
}

export type PaymentKey =
  | 'wechat'
  | 'alipay'
  | 'cash'
  | 'member'
  | 'card'
  | 'dcep'
  | 'enterprise'
  | 'pos'
  | 'unknown';

export interface PaymentSlice {
  key: PaymentKey;
  label: string;
  count: number;
  amount: number;
}

const IN_PROGRESS_STATUS: Order['status'][] = [
  'pending',
  'cooking',
  'ready',
  'rider_heading',
  'waiting_pickup',
  'reassigning_rider'
];

const VOID_STATUS: Order['status'][] = ['cancelled', 'refunded', 'merchant_rejected', 'rider_rejected'];

const sameDay = (a: Date, b: Date) =>
  a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

/** 纯时间格式：09:05 / 12:36:20（这是本项目 order.createdTime 的真实格式） */
const TIME_ONLY_RE = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/;

/**
 * 订单时间 → 绝对毫秒。
 * - 带日期（ISO / "2026-11-25 13:23:04"）直接解析
 * - 纯时间用 anchorIso 的日期补全；无 anchor 时按「今天」
 *
 * 历史 bug（2026-11-25 修）：`new Date('13:23:04')` 在 V8 里是 Invalid Date，
 * 原实现直接返回 0，导致 `t >= startOfToday` 恒 false —— 今日营收 / 昨日同时段 /
 * 营收曲线 / 营收趋势 / 平均出餐 全部恒为 0/空，而大屏看起来"正常渲染"。
 */
const toMs = (value?: string, anchorIso?: string): number => {
  if (!value) return 0;
  const direct = new Date(value).getTime();
  if (Number.isFinite(direct)) return direct;
  const m = TIME_ONLY_RE.exec(value.trim());
  if (!m) return 0;
  const anchorMs = anchorIso ? new Date(anchorIso).getTime() : NaN;
  const base = Number.isFinite(anchorMs) ? new Date(anchorMs) : new Date();
  return new Date(
    base.getFullYear(),
    base.getMonth(),
    base.getDate(),
    Number(m[1]),
    Number(m[2]),
    Number(m[3] || 0)
  ).getTime();
};

/**
 * 订单自身的时间基准。
 * createdTime 是纯时间（无日期），用 updatedAt（ISO，云端行级 updated_at 回填）补日期；
 * 没有 createdTime 时退化到 updatedAt。
 */
export const orderMs = (o: Order): number => toMs(o.createdTime, o.updatedAt) || toMs(o.updatedAt);

/** 数据新鲜度窗口：超过 12 小时的单不再参与「超时」判定。
 *  原因：演示/历史数据的 createdTime 可能是几天甚至几年前，
 *  直接做 now - createdTime 会算出「已超 302 万分钟」这种假告警。 */
const FRESH_MS = 12 * 60 * 60 * 1000;

/** 5 分钟桶 */
const BUCKET_MS = 5 * 60 * 1000;
/** 曲线窗口：最近 8 小时（48 个 5 分钟桶的 2 倍，够看晚高峰） */
const WINDOW_MS = 8 * 60 * 60 * 1000;

export function useOpsMetrics(
  orders: Order[],
  tables: TableItem[],
  now: number,
  aggTick: number
): OpsMetrics {
  return useMemo(() => {
    void aggTick; // 依赖 tick 以触发 5s 重算
    const nowDate = new Date(now);
    const startOfToday = new Date(nowDate.getFullYear(), nowDate.getMonth(), nowDate.getDate()).getTime();
    const startOfYesterday = startOfToday - 86400000;
    const elapsedToday = now - startOfToday;

    const todayOrders = orders.filter((o) => {
      const t = orderMs(o);
      return t >= startOfToday && !VOID_STATUS.includes(o.status);
    });

    const revenue = todayOrders.reduce((sum, o) => sum + (Number(o.totalAmount) || 0), 0);

    // 昨日同时段：昨日 00:00 ~ 昨日相同 elapsed
    const prevWindowEnd = startOfYesterday + elapsedToday;
    const prevRevenue = orders
      .filter((o) => {
        const t = orderMs(o);
        return t >= startOfYesterday && t <= prevWindowEnd && !VOID_STATUS.includes(o.status);
      })
      .reduce((sum, o) => sum + (Number(o.totalAmount) || 0), 0);

    const deltaPct = prevRevenue > 0 ? ((revenue - prevRevenue) / prevRevenue) * 100 : null;

    const inProgress = orders.filter((o) => IN_PROGRESS_STATUS.includes(o.status)).length;

    // 平均出餐：近 50 单已完成，剔除 > 60 分钟异常值
    const serveDurations = orders
      .filter((o) => o.status === 'completed' && now - orderMs(o) <= FRESH_MS)
      .map((o) => (toMs(o.updatedAt) - orderMs(o)) / 60000)
      .filter((m) => m > 0 && m <= 60)
      .sort((a, b) => a - b)
      .slice(-50);

    const avgServeMin = serveDurations.length
      ? serveDurations.reduce((a, b) => a + b, 0) / serveDurations.length
      : null;
    const percentile = (arr: number[], p: number) =>
      arr.length ? arr[Math.min(arr.length - 1, Math.max(0, Math.round((arr.length - 1) * p)))] : null;

    const totalTables = tables.length;
    const occupied = tables.filter((t) => t.status === 'dining').length;
    const occupancyPct = totalTables ? Math.round((occupied / totalTables) * 100) : 0;

    // 迷你趋势：近 12 个 5 分钟桶（1 小时）
    const trendFrom = now - 12 * BUCKET_MS;
    const revenueTrend: number[] = new Array(12).fill(0);
    const orderTrend: number[] = new Array(12).fill(0);
    for (const o of todayOrders) {
      const t = orderMs(o);
      if (t < trendFrom) continue;
      const idx = Math.min(11, Math.floor((t - trendFrom) / BUCKET_MS));
      revenueTrend[idx] += Number(o.totalAmount) || 0;
      orderTrend[idx] += 1;
    }

    return {
      revenue,
      deltaPct,
      prevRevenue,
      inProgress,
      avgServeMin,
      p50: percentile(serveDurations, 0.5),
      p90: percentile(serveDurations, 0.9),
      occupied,
      totalTables,
      occupancyPct,
      revenueTrend,
      orderTrend
    };
  }, [orders, tables, now, aggTick]);
}

/* ============================ 异常派生 ============================ */

/** 业务阈值（设计稿 §12 第 2 问的默认取值：全店统一，不做店型区分） */
export const OPS_THRESHOLDS = {
  serveTimeoutMin: 15,
  serveCriticalMin: 30,
  pendingTimeoutMin: 5,
  longStayMin: 90
} as const;

export function useOpsAnomalies(
  orders: Order[],
  tables: TableItem[],
  dishes: DishItem[],
  now: number,
  aggTick: number,
  /** 2026-11-23 扩展：低库存/打印/交班差异 来自本地兜底数据源 */
  extra?: {
    lowStock?: { id: string; name: string; current: number; safety: number; unit: string }[];
    printerOffline?: number;
    printerTotal?: number;
    lastShiftCashDiff?: number;
    lastShiftReason?: string;
    /** 骑手端待取/在途（B2） */
    riderPickup?: number;
    riderDelivering?: number;
    riderSamples?: string[];
  },
  acks?: Record<string, number>
): OpsAnomaly[] {
  return useMemo(() => {
    void aggTick;
    const list: OpsAnomaly[] = [];

    // 1) 出餐超时：制作中且超过阈值
    const cooking = orders.filter((o) => o.status === 'cooking' && now - orderMs(o) <= FRESH_MS);
    const overServed = cooking
      .map((o) => ({
        o,
        min: Math.floor((now - orderMs(o)) / 60000)
      }))
      .filter((x) => x.min >= OPS_THRESHOLDS.serveTimeoutMin)
      .sort((a, b) => b.min - a.min);

    if (overServed.length) {
      const top = overServed[0];
      const isCritical = top.min >= OPS_THRESHOLDS.serveCriticalMin;
      list.push({
        id: 'serve_timeout',
        kind: 'serve_timeout',
        severity: isCritical ? 'danger' : 'warn',
        title: isCritical ? '出餐严重超时' : '出餐超时',
        count: overServed.length,
        detail: `${top.o.tableCode || top.o.orderNo} · 已超 ${top.min} 分钟`,
        items: overServed.slice(0, 3).map((x) => `${x.o.tableCode || x.o.orderNo} · ${x.min} 分钟`),
        tab: 'kds'
      });
    }

    // 2) 待接单超时
    const pending = orders
      .filter((o) => o.status === 'pending' && now - orderMs(o) <= FRESH_MS)
      .map((o) => ({ o, min: Math.floor((now - orderMs(o)) / 60000) }))
      .filter((x) => x.min >= OPS_THRESHOLDS.pendingTimeoutMin);

    if (pending.length) {
      list.push({
        id: 'pending_timeout',
        kind: 'pending_timeout',
        severity: 'warn',
        title: '待接单超时',
        count: pending.length,
        detail: `${pending[0].o.orderNo} · 等待 ${pending[0].min} 分钟`,
        items: pending.slice(0, 3).map((x) => `${x.o.orderNo} · ${x.min} 分钟`),
        tab: 'orders'
      });
    }

    // 3) 退款待审
    const refunds = orders.filter((o) => o.status === 'refund_pending');
    if (refunds.length) {
      list.push({
        id: 'refund',
        kind: 'refund',
        severity: 'danger',
        title: '退款待审',
        count: refunds.length,
        detail: `${refunds[0].orderNo} · ¥${(Number(refunds[0].totalAmount) || 0).toFixed(2)}`,
        items: refunds.slice(0, 3).map((o) => `${o.orderNo} · ¥${(Number(o.totalAmount) || 0).toFixed(2)}`),
        tab: 'contingency'
      });
    }

    // 4) 沽清
    const soldOut = dishes.filter((d) => d.available === false);
    if (soldOut.length) {
      list.push({
        id: 'soldout',
        kind: 'soldout',
        severity: 'warn',
        title: '菜品沽清',
        count: soldOut.length,
        detail: soldOut
          .slice(0, 3)
          .map((d) => d.name)
          .join(' · '),
        items: soldOut.slice(0, 3).map((d) => d.name),
        tab: 'menu'
      });
    }

    // 4.5) 低库存（物料低于安全库存）
    if (extra?.lowStock?.length) {
      list.push({
        id: 'low_stock',
        kind: 'low_stock',
        severity: 'warn',
        title: '低库存',
        count: extra.lowStock.length,
        detail: extra.lowStock.slice(0, 3).map((m) => `${m.name} ${m.current}/${m.safety}${m.unit}`).join(' · '),
        items: extra.lowStock.slice(0, 3).map((m) => `${m.name} ${m.current}/${m.safety}${m.unit}`),
        tab: 'materials'
      });
    }

    // 4.6) 打印设备未连接（linked 但本会话不可用）
    if (extra?.printerOffline && extra.printerOffline > 0) {
      list.push({
        id: 'printer_offline',
        kind: 'printer_offline',
        severity: 'warn',
        title: '打印设备未连接',
        count: extra.printerOffline,
        detail: `${extra.printerOffline}/${extra.printerTotal} 台本会话未连接，出票可能失败`,
        tab: 'printing_v2'
      });
    }

    // 4.7) 交接班现金差异
    if (extra?.lastShiftCashDiff && extra.lastShiftCashDiff !== 0) {
      list.push({
        id: 'shift_diff',
        kind: 'shift_diff',
        severity: 'info',
        title: '交班现金差异',
        count: 1,
        detail: `上次交班差异 ¥${Math.abs(extra.lastShiftCashDiff).toFixed(2)}${extra.lastShiftReason ? ' · ' + extra.lastShiftReason : ''}`,
        tab: 'shifts'
      });
    }

    // 4.8) 骑手运力不足（B2）：待取积压，超过 3 单警告、6 单严重
    if (extra?.riderPickup && extra.riderPickup > 0 && extra.riderPickup >= 3) {
      list.push({
        id: 'rider_capacity',
        kind: 'rider_capacity',
        severity: extra.riderPickup >= 6 ? 'danger' : 'warn',
        title: '骑手运力不足',
        count: extra.riderPickup,
        detail: `待取 ${extra.riderPickup} 单 · 在途 ${extra.riderDelivering ?? 0} 单`,
        items: (extra.riderSamples && extra.riderSamples.length ? extra.riderSamples : []).map((no) => `待取 · ${no}`),
        tab: 'orders'
      });
    }

    // 5) 台位久坐（无排队数据，用久坐替代「等位超时」）
    const longStay = tables
      .filter((t) => t.status === 'dining' && (t.elapsedMinutes || 0) >= OPS_THRESHOLDS.longStayMin)
      .sort((a, b) => (b.elapsedMinutes || 0) - (a.elapsedMinutes || 0));

    if (longStay.length) {
      list.push({
        id: 'table_long_stay',
        kind: 'table_long_stay',
        severity: 'info',
        title: '台位久坐',
        count: longStay.length,
        detail: `${longStay[0].code} · ${longStay[0].elapsedMinutes} 分钟`,
        tab: 'tables'
      });
    }

    const order: Record<AnomalySeverity, number> = { danger: 0, warn: 1, info: 2 };
    const withAck = list.map((it) => ({ ...it, acked: Boolean(acks && acks[it.id]) }));
    // 已确认的排在同严重度末尾，未确认优先
    return withAck.sort(
      (a, b) => order[a.severity] - order[b.severity] || (Number(a.acked) - Number(b.acked)) || b.count - a.count
    );
  }, [orders, tables, dishes, now, aggTick, extra, acks]);
}

/* ============================ 事件流 ============================ */

const STATUS_TEXT: Record<string, string> = {
  pending: '待接单',
  cooking: '制作中',
  ready: '已出餐',
  waiting_pickup: '待取餐',
  rider_heading: '骑手前往',
  picked_up: '已取餐',
  delivering: '配送中',
  completed: '已完成',
  cancelled: '已取消',
  refund_pending: '退款待审',
  refunded: '已退款',
  reassigning_rider: '改派中'
};

export function useOpsEvents(orders: Order[], now: number, aggTick: number): OpsEventItem[] {
  return useMemo(() => {
    void now;
    void aggTick;
    return orders
      .filter((o) => toMs(o.updatedAt) > 0 || orderMs(o) > 0)
      .map((o) => ({
        id: o.id,
        at: toMs(o.updatedAt) || orderMs(o),
        text: `${o.orderNo || o.id} · ${STATUS_TEXT[o.status] || o.status}${
          o.tableCode ? ` · ${o.tableCode}` : ''
        } · ¥${(Number(o.totalAmount) || 0).toFixed(2)}`,
        tone:
          o.status === 'refund_pending'
            ? ('danger' as const)
            : o.status === 'completed'
            ? ('ok' as const)
            : o.status === 'cancelled' || o.status === 'refunded'
            ? ('warn' as const)
            : ('normal' as const)
      }))
      .sort((a, b) => b.at - a.at)
      .slice(0, 50);
  }, [orders, now, aggTick]);
}

/* ============================ 图表数据 ============================ */

export function useRevenueSeries(orders: Order[], now: number, slowTick: number): RevenuePoint[] {
  return useMemo(() => {
    void slowTick; // L3：30s 全量重算
    const end = now;
    const start = now - WINDOW_MS;
    const buckets = Math.ceil(WINDOW_MS / BUCKET_MS);
    const amounts = new Array(buckets).fill(0);

    for (const o of orders) {
      if (VOID_STATUS.includes(o.status)) continue;
      const t = orderMs(o);
      if (t < start || t > end) continue;
      const idx = Math.min(buckets - 1, Math.floor((t - start) / BUCKET_MS));
      amounts[idx] += Number(o.totalAmount) || 0;
    }

    let cum = 0;
    return amounts.map((amount, i) => {
      cum += amount;
      return { t: start + i * BUCKET_MS, amount, cum };
    });
  }, [orders, now, slowTick]);
}

/**
 * 昨日同时段曲线（A2，2026-11-25）。
 * 窗口整体平移 24h 取数，但返回点的 t 仍落在「今日时间轴」上，
 * 这样两条线在图上天然对齐，X 轴标签也仍是今天。
 */
export function usePrevRevenueSeries(orders: Order[], now: number, slowTick: number): RevenuePoint[] {
  return useMemo(() => {
    void slowTick;
    const end = now - 86400000;
    const start = end - WINDOW_MS;
    const buckets = Math.ceil(WINDOW_MS / BUCKET_MS);
    const amounts = new Array(buckets).fill(0);

    for (const o of orders) {
      if (VOID_STATUS.includes(o.status)) continue;
      const t = orderMs(o);
      if (t < start || t > end) continue;
      const idx = Math.min(buckets - 1, Math.floor((t - start) / BUCKET_MS));
      amounts[idx] += Number(o.totalAmount) || 0;
    }

    let cum = 0;
    return amounts.map((amount, i) => {
      cum += amount;
      return { t: now - WINDOW_MS + i * BUCKET_MS, amount, cum };
    });
  }, [orders, now, slowTick]);
}

export function useChannelSplit(orders: Order[], now: number, slowTick: number): ChannelSlice[] {  return useMemo(() => {
    void slowTick;
    const nowDate = new Date(now);
    const startOfToday = new Date(nowDate.getFullYear(), nowDate.getMonth(), nowDate.getDate()).getTime();
    const today = orders.filter((o) => orderMs(o) >= startOfToday && !VOID_STATUS.includes(o.status));

    const buckets: Record<ChannelSlice['key'], ChannelSlice> = {
      dine_in: { key: 'dine_in', label: '堂食', count: 0, amount: 0, color: 'var(--gd-brand)' },
      delivery: { key: 'delivery', label: '外卖', count: 0, amount: 0, color: 'var(--gd-info)' },
      pickup: { key: 'pickup', label: '自提', count: 0, amount: 0, color: 'var(--gd-amber)' }
    };

    for (const o of today) {
      const k = (o.channelType || 'dine_in') as ChannelSlice['key'];
      const b = buckets[k] || buckets.dine_in;
      b.count += 1;
      b.amount += Number(o.totalAmount) || 0;
    }

    return [buckets.dine_in, buckets.delivery, buckets.pickup];
  }, [orders, now, slowTick]);
}

export const PAY_LABELS: Record<PaymentKey, string> = {
  wechat: '微信',
  alipay: '支付宝',
  cash: '现金',
  member: '会员储值',
  card: '银联 / 云闪付',
  dcep: '数字人民币',
  enterprise: '企业餐补',
  pos: 'POS 刷卡',
  unknown: '未标记'
};

/**
 * 归一化支付方式。
 *
 * 【2026-11-25 修】原来只读 `o.payMethod`，但真实下单链路写的是 `o.paymentMethod`
 * （App.tsx `paymentMethod: paymentMethod || 'wechat'`，取值来自结账页的 channelId：
 * wechat / alipay / card / dcep / enterprise），所以支付分布卡永远只有「未标记」一条。
 *
 * 两处字段并存（types.ts L394 payMethod / L476 paymentMethod），老单据可能只有前者，
 * 新单据只有后者，因此两个都读；再用关键字兜底，兼容 mock / 历史数据里的中文或混合文案
 * （如「微信支付 · 已完成」「在线微信支付 · 已结算」）。
 */
export function normalizePayKey(o: Order): PaymentKey {
  const raw = String(o.payMethod || o.paymentMethod || '').trim().toLowerCase();
  if (!raw) return 'unknown';

  // 1) code 直命中（结账页 channelId 与旧 payMethod 的并集）
  if (raw in PAY_LABELS) return raw as PaymentKey;

  // 2) 关键字兜底（中文文案 / 带后缀的混合串 / 历史别名）
  if (/微信|wechat|wxpay|wx_/.test(raw)) return 'wechat';
  if (/支付宝|alipay|ali_|花呗/.test(raw)) return 'alipay';
  if (/数字人民币|dcep|e-cny|ecny|硬钱包/.test(raw)) return 'dcep';
  if (/银联|云闪付|刷卡|银行卡|unionpay|apple ?pay|credit|debit/.test(raw)) return 'card';
  if (/企业|餐补|挂账|月结|对公|enterprise|corp/.test(raw)) return 'enterprise';
  if (/会员|储值|余额|member|balance/.test(raw)) return 'member';
  if (/现金|cash|货到付款|cod/.test(raw)) return 'cash';
  if (/^pos|pos ?机|收银机/.test(raw)) return 'pos';

  return 'unknown';
}

export function usePaymentSplit(orders: Order[], now: number, slowTick: number): PaymentSlice[] {
  return useMemo(() => {
    void slowTick;
    const nowDate = new Date(now);
    const startOfToday = new Date(nowDate.getFullYear(), nowDate.getMonth(), nowDate.getDate()).getTime();
    const today = orders.filter((o) => orderMs(o) >= startOfToday && !VOID_STATUS.includes(o.status));

    const map = new Map<PaymentKey, PaymentSlice>();
    for (const o of today) {
      const k = normalizePayKey(o);
      const cur = map.get(k) || { key: k, label: PAY_LABELS[k], count: 0, amount: 0 };
      cur.count += 1;
      cur.amount += Number(o.totalAmount) || 0;
      map.set(k, cur);
    }

    return [...map.values()].sort((a, b) => b.amount - a.amount);
  }, [orders, now, slowTick]);
}
