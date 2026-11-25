import { useEffect, useMemo, useState } from 'react';
import { getLinkedPrinters, isSessionAvailable } from '../../../utils/linkedPrinterStore';
import { INITIAL_STAFF_MEMBERS } from '../../../data/merchantExtendedMockData';

/* ============================================================================
 * 总览台 · 本地兜底数据源（2026-11-23）
 * ----------------------------------------------------------------------------
 * 大屏主入参只有 orders/tables/dishes；但值班要看的另外四件事的数据都在本地：
 *   · 低库存（obsidian_truck_materials：currentStock < safetyStock）
 *   · 上次交班（obsidian_shift_records：取最新一条）
 *   · 打印设备会话可用性（linkedPrinterStore：linked 但 session 不可用 = 未连接）
 *   · 告警确认（sessionStorage，30 分钟消音）
 *   · 营收日目标（localStorage，可配；未配置时相关 UI 自动隐藏）
 *
 * 这些都是「本机快照」，30s 跟随聚合 tick 刷新一次即可。
 * ========================================================================== */

export interface LowStockItem {
  id: string;
  name: string;
  current: number;
  safety: number;
  unit: string;
}

export interface LastShiftInfo {
  closedBy: string;
  successor: string;
  endTime: string;
  cashDiff: number;
  diffReasonText: string;
}

export interface AckMap {
  [anomalyId: string]: number; // 过期时间戳
}

const ACK_KEY = 'obsidian_ops_ack_v1';
const ASSIGN_KEY = 'obsidian_ops_assign_v1';
const TARGET_KEY = 'obsidian_revenue_target_daily';
const ACK_TTL = 30 * 60 * 1000;

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    const v = JSON.parse(raw);
    return v ?? fallback;
  } catch {
    return fallback;
  }
}

/** 告警确认：30 分钟内不再脉冲/告警 */
export function readAcks(): AckMap {
  let map: AckMap = {};
  try {
    const raw = sessionStorage.getItem(ACK_KEY);
    if (raw) map = JSON.parse(raw) || {};
  } catch { /* ignore */ }
  const now = Date.now();
  let changed = false;
  for (const k of Object.keys(map)) {
    if (map[k] < now) {
      delete map[k];
      changed = true;
    }
  }
  if (changed) {
    try { sessionStorage.setItem(ACK_KEY, JSON.stringify(map)); } catch { /* ignore */ }
  }
  return map;
}

export function ackAnomaly(id: string): void {
  const map: AckMap = (() => {
    try { return JSON.parse(sessionStorage.getItem(ACK_KEY) || '{}') || {}; } catch { return {}; }
  })();
  map[id] = Date.now() + ACK_TTL;
  try { sessionStorage.setItem(ACK_KEY, JSON.stringify(map)); } catch { /* ignore */ }
}

export function ackAllCurrent(ids: string[]): void {
  const map: AckMap = (() => {
    try { return JSON.parse(sessionStorage.getItem(ACK_KEY) || '{}') || {}; } catch { return {}; }
  })();
  const until = Date.now() + ACK_TTL;
  ids.forEach((id) => { map[id] = until; });
  try { sessionStorage.setItem(ACK_KEY, JSON.stringify(map)); } catch { /* ignore */ }
}

export function getRevenueTarget(): number {
  const v = Number(localStorage.getItem(TARGET_KEY));
  return Number.isFinite(v) && v > 0 ? v : 0;
}

export interface OpsLocalData {
  lowStock: LowStockItem[];
  lastShift: LastShiftInfo | null;
  printerTotal: number;
  printerOffline: number;
  acks: AckMap;
  revenueTarget: number;
  /** 骑手运力（来自骑手端活跃配送单存储）：待取 / 在途 / 单号样例 */
  rider: { pickup: number; delivering: number; samples: string[] };
  /** 在岗人员（员工中心）：在岗数 / 总数 / 可指派姓名 */
  staff: { onDuty: number; total: number; names: string[] };
  /** 异常指派（本机）：anomalyId → 员工姓名 */
  assignments: Record<string, string>;
  /** G3 告警关闭记录：anomalyId → 关闭详情 */
  closures: ClosureMap;
}

export function readAssignments(): Record<string, string> {
  try { return JSON.parse(sessionStorage.getItem(ASSIGN_KEY) || '{}') || {}; } catch { return {}; }
}

export function setAssignment(anomalyId: string, staffName: string): void {
  const map = readAssignments();
  if (staffName) map[anomalyId] = staffName;
  else delete map[anomalyId];
  try { sessionStorage.setItem(ASSIGN_KEY, JSON.stringify(map)); } catch { /* ignore */ }
}

/* ============================================================================
 * G3 告警关闭与原因（2026-11-25）
 * ----------------------------------------------------------------------------
 * 「知道了」只是 30 分钟消音，异常还在；关闭才表示这件事真的处理完了。
 * 关闭记录写 localStorage（要跨会话留痕，交接班能说清哪些已处理）。
 *
 * 重新激活规则（避免关掉之后漏警）：
 *   · 同类异常数量比关闭时**变多** → 视为新事件，重新出现
 *   · 距关闭超过 30 分钟 → 也重新出现（视作新时段）
 * ========================================================================== */
export type ClosureReason = 'handled' | 'false_alarm';

export interface ClosureEntry {
  reason: ClosureReason;
  /** 关闭时的异常条数，用于判断是否是新事件 */
  count: number;
  /** 关闭人（本机会话里的操作者名字，可为空） */
  by: string;
  /** 关闭时间戳 */
  at: number;
  /** 关闭时的标题，便于"最近解除"列表展示 */
  title: string;
}

export type ClosureMap = Record<string, ClosureEntry>;

const CLOSE_KEY = 'obsidian_ops_close_v1';
const CLOSE_REACTIVATE_MS = 30 * 60 * 1000;

export function readClosures(): ClosureMap {
  return readJson<ClosureMap>(CLOSE_KEY, {});
}

export function closeAnomaly(id: string, reason: ClosureReason, title: string, count: number, by: string = ''): void {
  const map = readClosures();
  map[id] = { reason, count, by, at: Date.now(), title };
  // 只保留最近 50 条，避免长期使用后无限膨胀
  const entries = Object.entries(map).sort((a, b) => b[1].at - a[1].at).slice(0, 50);
  try {
    localStorage.setItem(CLOSE_KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch { /* ignore */ }
}

export function reopenAnomaly(id: string): void {
  const map = readClosures();
  if (!(id in map)) return;
  delete map[id];
  try { localStorage.setItem(CLOSE_KEY, JSON.stringify(map)); } catch { /* ignore */ }
}

/** 关闭是否仍然有效（有效 = 从活动异常里隐藏） */
export function isClosureActive(entry: ClosureEntry | undefined, currentCount: number, now: number): boolean {
  if (!entry) return false;
  if (now - entry.at >= CLOSE_REACTIVATE_MS) return false;
  return currentCount <= entry.count;
}

/** 今日已解除（按关闭时间落在今天算），供异常带顶部展示 */
export function todaysClosures(now: number): ClosureEntry[] {
  const d = new Date(now);
  const startOfToday = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  return Object.values(readClosures())
    .filter((e) => e.at >= startOfToday)
    .sort((a, b) => b.at - a.at);
}

/** 跟随聚合节奏读取本地兜底数据（deps 用 aggTick 驱动 30s 刷新） */
export function useOpsLocalData(aggTick: number, bump: number = 0): OpsLocalData {
  const base = useMemo(() => {
    // ---- 低库存 ----
    let lowStock: LowStockItem[] = [];
    try {
      const materials = readJson<{ id: string; name: string; currentStock: number; safetyStock: number; unit?: string }[]>('obsidian_truck_materials', []);
      lowStock = materials
        .filter((m) => Number(m.safetyStock) > 0 && Number(m.currentStock) < Number(m.safetyStock))
        .map((m) => ({ id: m.id, name: m.name, current: Number(m.currentStock), safety: Number(m.safetyStock), unit: m.unit || '份' }))
        .sort((a, b) => a.current / Math.max(1, a.safety) - b.current / Math.max(1, b.safety))
        .slice(0, 10);
    } catch { /* ignore */ }

    // ---- 上次交班 ----
    let lastShift: LastShiftInfo | null = null;
    try {
      const shifts = readJson<{ endTime: string; closedBy: string; successor: string; cashDiff: number; diffReasonText?: string }[]>('obsidian_shift_records', []);
      if (shifts.length) {
        const latest = [...shifts].sort((a, b) => new Date(b.endTime).getTime() - new Date(a.endTime).getTime())[0];
        if (latest) {
          lastShift = {
            closedBy: latest.closedBy || '—',
            successor: latest.successor || '—',
            endTime: latest.endTime,
            cashDiff: Number(latest.cashDiff) || 0,
            diffReasonText: latest.diffReasonText || ''
          };
        }
      }
    } catch { /* ignore */ }

    // ---- 打印设备 ----
    let printerTotal = 0;
    let printerOffline = 0;
    try {
      const list = getLinkedPrinters();
      printerTotal = list.length;
      printerOffline = list.filter((d) => !isSessionAvailable(d.id)).length;
    } catch { /* ignore */ }

    // ---- 骑手运力 ----
    let rider = { pickup: 0, delivering: 0, samples: [] as string[] };
    try {
      const list = readJson<{ orderNo?: string; phase?: string; pickupVerified?: boolean }[]>('obsidian_rider_active_orders', []);
      const pickupList = list.filter((o) => o.phase === 'pickup' && !o.pickupVerified);
      rider = {
        pickup: pickupList.length,
        delivering: list.filter((o) => o.phase === 'dropoff').length,
        samples: pickupList.slice(0, 3).map((o) => o.orderNo || '—')
      };
    } catch { /* ignore */ }

    // ---- 在岗人员 ----
    let staff = { onDuty: 0, total: 0, names: [] as string[] };
    try {
      // 本地名单为空（换设备/未同步）时回退内置种子，保证「指派」始终可用
      let list = readJson<{ name?: string; status?: string }[]>('obsidian_staff_members', []);
      if (!list.length) {
        list = INITIAL_STAFF_MEMBERS.map((m) => ({ name: m.name, status: m.status }));
      }
      const onDuty = list.filter((m) => m.status === 'active' || m.status === 'on_break');
      staff = {
        onDuty: onDuty.length,
        total: list.length,
        names: onDuty.map((m) => m.name || '').filter(Boolean).slice(0, 12)
      };
    } catch { /* ignore */ }

    return {
      lowStock,
      lastShift,
      printerTotal,
      printerOffline,
      revenueTarget: getRevenueTarget(),
      rider,
      staff
    };
  }, [aggTick, bump]);

  // acks 每次渲染新鲜读取（读 sessionStorage 极便宜）：点击「知道了」立即生效，不等 5s 聚合 tick
  return { ...base, acks: readAcks(), assignments: readAssignments(), closures: readClosures() };
}
