import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Maximize2,
  Minimize2,
  RefreshCw,
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  ArrowRight,
  CheckCircle2,
  BarChart3,
  X,
  Volume2,
  VolumeX,
  Download,
  SlidersHorizontal
} from 'lucide-react';
import { isRealtimeConnected, getRealtimeDiag } from '../../../utils/realtimeSync';
import type { Order, TableItem, DishItem } from '../../../types';
import './opsDeckTheme.css';
import {
  useOpsTicker,
  useOpsMetrics,
  useOpsAnomalies,
  useOpsEvents,
  useRevenueSeries,
  usePrevRevenueSeries,
  useChannelSplit,
  usePaymentSplit,
  orderMs,
  OPS_THRESHOLDS,
  type OpsAnomaly
} from './useOpsDeckData';
import { RollingNumber, Sparkline } from './OpsDeckPrimitives';
import {
  useOpsLocalData,
  ackAnomaly,
  ackAllCurrent,
  setAssignment,
  closeAnomaly,
  isClosureActive,
  todaysClosures,
  type LowStockItem,
  type ClosureReason
} from './useOpsLocalData';
import { RevenueChart } from './RevenueChart';

/* ============================================================================
 * 运营总控 · 动态数据大屏（v2）
 * ----------------------------------------------------------------------------
 * 复刻 deliverables/ops-deck-redesign/DESIGN.md：
 *   ① 指挥条 → ② 巨指标带 → ③ 主图表区 + ④ 异常带 → ⑤ 事件流
 *
 * 与旧版（MerchantOperationsDeck，2036 行卡片平铺）的差别：
 *   · 信息分层：一眼健康度（巨指标）→ 二眼异常（右侧异常带）→ 三眼细节（图表/事件）
 *   · 视觉：切换到 --gd-* 沽清色板，作用域隔离，不影响其它页
 *   · 动效：数字逐位滚动、异常脉冲、分层刷新（1s/5s/30s）
 *   · 闭环：每个指标与异常都能一键跳到处理页
 * ========================================================================== */

interface OpsDeckV2Props {
  orders: Order[];
  tables: TableItem[];
  dishes: DishItem[];
  selectedTruckId: string;
  onSelectTruckId: (tid: string) => void;
  showToast: (msg: string) => void;
  /** 跳转到其它页签（营收分析 / 订单中心 / 台位矩阵 / 退款审核 / 菜品管理） */
  onNavigate?: (tab: string) => void;
}

type Cadence = 'live' | 'slow' | 'paused';

const ZONE_LABEL: Record<string, string> = { hall: '散座', booth: '卡座', patio: '外摆' };

const fmtMoney = (n: number) =>
  n.toLocaleString('zh-CN', { minimumFractionDigits: 0, maximumFractionDigits: 0 });

const fmtMinutes = (m: number | null) => {
  if (m === null || !Number.isFinite(m)) return '—';
  const mm = Math.floor(m);
  const ss = Math.round((m - mm) * 60);
  return `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
};

const periodOf = (d: Date) => {
  const h = d.getHours();
  if (h < 10) return '早市备货';
  if (h < 14) return '午市高峰';
  if (h < 17) return '下午茶';
  if (h < 21) return '晚市高峰';
  return '打烊收尾';
};

/* ---------------------------- 卡片外壳 ---------------------------- */

const Card: React.FC<{
  title: string;
  meta?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  onClick?: () => void;
}> = ({ title, meta, children, className = '', onClick }) => (
  <section
    className={`ops-card flex flex-col ${onClick ? 'cursor-pointer hover:border-[var(--gd-ink-muted)] transition-colors' : ''} ${className}`}
    onClick={onClick}
  >
    <header className="ops-card-head flex items-center justify-between gap-2 px-3 h-8 shrink-0">
      <span className="ops-card-title">{title}</span>
      {meta && <span className="text-[10.5px] text-[var(--gd-ink-muted)] ops-num">{meta}</span>}
    </header>
    <div className="flex-1 min-h-0">{children}</div>
  </section>
);

/* ---------------------------- 巨指标 ---------------------------- */

const Kpi: React.FC<{
  label: string;
  value: React.ReactNode;
  unit?: React.ReactNode;
  badge?: { text: string; tone: 'up' | 'down' | 'flat' };
  hint?: React.ReactNode;
  trend?: number[];
  trendColor?: string;
  /** 底部进度条（0-100）；undefined 时不显示 */
  meter?: number;
  /** 右上角达成率环（0-100）；undefined 不显示 */
  ringPct?: number;
  onClick?: () => void;
  muted?: boolean;
  warn?: boolean;
  /** 首帧数据未就绪：显示骨架，避免冷启动显示 0 */
  loading?: boolean;
}> = ({ label, value, unit, badge, hint, trend, trendColor, meter, onClick, muted, warn, loading, ringPct }) => (
  <button
    type="button"
    onClick={onClick}
    disabled={!onClick}
    className={`ops-card ops-kpi ${warn ? 'ops-kpi-warn' : ''} relative text-left pl-4 pr-3 pt-2.5 pb-2 flex flex-col justify-between h-[132px] w-full ${
      onClick ? 'cursor-pointer hover:border-[var(--gd-ink-muted)]' : 'cursor-default'
    } transition-colors`}
  >
    {loading ? (
      <div className="flex flex-col gap-2 pt-0.5">
        <div className="ops-skeleton h-2.5 w-16" />
        <div className="ops-skeleton h-7 w-24" />
        <div className="ops-skeleton h-2 w-full" />
      </div>
    ) : (
    <>
    <div className="flex items-center justify-between gap-2">
      <span className="ops-card-title">{label}</span>
      {badge && (
        <span
          className="ops-num text-[9.5px] font-medium px-1.5 py-0.5 rounded-[2px] max-w-[88px] truncate"
          style={
            badge.tone === 'up'
              ? { background: 'var(--gd-brand-soft)', color: 'var(--gd-brand)', border: '1px solid var(--gd-brand-line)' }
              : badge.tone === 'down'
              ? { background: 'rgba(212,67,51,0.07)', color: 'var(--gd-danger)', border: '1px solid rgba(212,67,51,0.25)' }
              : { background: 'var(--gd-surface)', color: 'var(--gd-ink-muted)', border: '1px solid var(--gd-line-main)' }
          }
        >
          {badge.text}
        </span>
      )}
    </div>

    <div className="flex items-center justify-between gap-2">
      <div className={`ops-kpi-value flex items-baseline gap-1 ${muted ? 'text-[var(--gd-ink-muted)]' : ''}`}>
        {value}
        {unit && <span className="text-[13px] font-normal text-[var(--gd-ink-muted)]">{unit}</span>}
      </div>
      {ringPct !== undefined && (
        <div
          className="w-9 h-9 rounded-full shrink-0 grid place-items-center tabular-nums text-[9.5px] font-semibold"
          style={{
            background: `conic-gradient(var(--gd-brand) ${Math.max(0, Math.min(100, ringPct))}%, #f0f0ee 0)`,
            color: 'var(--gd-ink-strong)'
          }}
          title={`达成率 ${Math.round(ringPct)}%`}
        >
          <span className="w-7 h-7 rounded-full bg-white grid place-items-center">{Math.round(ringPct)}%</span>
        </div>
      )}
    </div>

    <div>
      <div className="flex items-end justify-between gap-2 h-[30px]">
        <span className="text-[10.5px] leading-[1.4] text-[var(--gd-ink-muted)] truncate min-w-0 flex-1">{hint}</span>
        {trend && trend.length > 0 && <Sparkline data={trend} width={92} height={28} color={trendColor} />}
      </div>
      <div className="h-[3px] mt-1.5 rounded-[2px]" style={{ background: '#f0f0ee' }}>
        <div
          className="h-full rounded-[1px] transition-[width] duration-500"
          style={{
            width: `${Math.max(0, Math.min(100, meter ?? 0))}%`,
            background: warn ? 'var(--gd-danger)' : 'var(--gd-brand)',
            opacity: meter === undefined ? 0 : 1
          }}
        />
      </div>
    </div>
    </>
    )}
  </button>
);

/* ---------------------------- 空态 ---------------------------- */

const Empty: React.FC<{ icon?: React.ReactNode; title: string; desc?: string; action?: React.ReactNode }> = ({
  icon,
  title,
  desc,
  action
}) => (
  <div className="ops-empty">
    <span className="ops-empty-icon">{icon}</span>
    <span className="ops-empty-title">{title}</span>
    {desc && <span className="ops-empty-desc">{desc}</span>}
    {action}
  </div>
);

/* ---------------------------- 异常带 ---------------------------- */

const SEVERITY_STYLE: Record<OpsAnomaly['severity'], { dot: string; text: string; label: string }> = {
  danger: { dot: 'bg-[var(--gd-danger)]', text: 'text-[var(--gd-danger)]', label: '严重' },
  warn: { dot: 'bg-[var(--gd-amber)]', text: 'text-[var(--gd-amber)]', label: '警告' },
  info: { dot: 'bg-[var(--gd-ink-muted)]', text: 'text-[var(--gd-ink-muted)]', label: '提示' }
};

const AnomalyBand: React.FC<{
  items: OpsAnomaly[];
  collapsed: boolean;
  onToggle: () => void;
  onJump?: (tab: string) => void;
  /** 首帧：显示骨架而不是「全部正常」，避免冷启动误读为无异常 */
  booting?: boolean;
  /** 确认回调：写 sessionStorage 并触发父组件刷新 acks */
  onAck?: (id: string) => void;
  /** 展开明细的条目 id 集合 */
  expandedIds?: Set<string>;
  /** 切换展开/收起 */
  onToggleExpand?: (id: string) => void;
  /** 导出异常清单 */
  onExport?: () => void;
  /** 可指派的在岗员工姓名 */
  staffNames?: string[];
  /** 当前指派映射 */
  assignments?: Record<string, string>;
  /** 指派回调 */
  onAssign?: (id: string, name: string) => void;
  /** G3 关闭回调：记录已处理/误报，异常从活动列表移除 */
  onCloseAnomaly?: (id: string, reason: ClosureReason, title: string, count: number) => void;
  /** 今日已解除条数 */
  closedCount?: number;
}> = ({ items, collapsed, onToggle, onJump, booting, onAck, expandedIds, onToggleExpand, onExport, staffNames, assignments, onAssign, onCloseAnomaly, closedCount = 0 }) => {
  if (collapsed) {
    return (
      <aside className="w-14 shrink-0 border-l border-[var(--gd-line-section)] flex flex-col items-center py-2 gap-2">
        <button
          type="button"
          onClick={onToggle}
          className="w-9 h-9 grid place-items-center rounded-[2px] border border-[var(--gd-line-main)] cursor-pointer hover:bg-[var(--gd-surface)]"
          title="展开异常带"
        >
          <AlertTriangle className="w-3.5 h-3.5 text-[var(--gd-ink-muted)]" />
        </button>
        <span className="ops-num text-[11px] text-[var(--gd-danger)] font-semibold">{items.length}</span>
      </aside>
    );
  }

  return (
    <aside className="w-[280px] min-[1600px]:w-[320px] shrink-0 border-l border-[var(--gd-line-section)] flex flex-col">
      <header className="h-8 px-3 flex items-center justify-between border-b border-[var(--gd-line-section)]">
        <span className="ops-card-title">异常带</span>
        <div className="flex items-center gap-2">
          <span className="ops-num text-[10.5px] text-[var(--gd-danger)] font-semibold">{items.length}</span>
          {closedCount > 0 && (
            <span
              className="text-[9px] text-[var(--gd-ink-muted)]"
              title={`今日已关闭 ${closedCount} 条（已处理 / 误报）`}
            >
              已解除 {closedCount}
            </span>
          )}
          <button
            type="button"
            onClick={onToggle}
            className="cursor-pointer text-[var(--gd-ink-muted)] hover:text-[var(--gd-ink-strong)]"
            title="折叠"
          >
            <ChevronDown className="w-3.5 h-3.5" />
          </button>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto p-2 space-y-2">
        {booting ? (
          <>
            <div className="ops-skeleton h-12 w-full rounded-[2px]" />
            <div className="ops-skeleton h-12 w-5/6 rounded-[2px]" />
            <div className="ops-skeleton h-12 w-4/6 rounded-[2px]" />
          </>
        ) : items.length === 0 ? (
          <Empty
            icon={<CheckCircle2 className="w-4 h-4" style={{ color: 'var(--gd-brand)' }} />}
            title="全部正常"
            desc="出餐、退款、台位均在阈值内，无需干预"
          />
        ) : (
          items.map((it) => {
            const s = SEVERITY_STYLE[it.severity];
            return (
              <div
                key={it.id}
                role="button"
                tabIndex={0}
                aria-label={`${it.title} ${it.count} 项${it.tab ? '，点击处理' : ''}`}
                onClick={() => it.tab && onJump?.(it.tab)}
                onKeyDown={(e) => { if ((e.key === 'Enter' || e.key === ' ') && it.tab) { e.preventDefault(); onJump?.(it.tab); } }}
                className={`relative w-full text-left pl-3.5 pr-2 py-2 rounded-[var(--gd-radius-card)] border border-[var(--gd-line-main)] bg-white ${
                  it.severity === 'danger' && !it.acked ? 'ops-anomaly-danger' : ''
                } ${it.acked ? 'opacity-70' : ''} ${it.tab ? 'cursor-pointer hover:border-[var(--gd-ink-muted)]' : 'cursor-default'} transition-colors`}
              >
                <div className="flex items-center gap-1.5">
                  <span
                    className={`ops-sev ops-sev--${it.severity} ${it.severity === 'danger' ? 'ops-dot-danger' : ''}`}
                    aria-label={s.label}
                  />
                  <span className="text-[11px] font-semibold text-[var(--gd-ink-strong)] truncate min-w-0">{it.title}</span>
                  <span className={`ops-num text-[11px] font-semibold shrink-0 ${s.text}`}>{it.count}</span>
                  <span className="flex-1 min-w-0" />
                  {assignments?.[it.id] ? (
                    <span className="text-[9px] px-1 rounded-[2px] bg-[var(--gd-info-soft)] border border-[rgba(28,85,152,0.24)] text-[var(--gd-info)] shrink-0 whitespace-nowrap">
                      {assignments[it.id]}
                    </span>
                  ) : staffNames && staffNames.length > 0 ? (
                    <select
                      value=""
                      onClick={(e) => e.stopPropagation()}
                      onChange={(e) => { e.stopPropagation(); onAssign?.(it.id, e.target.value); }}
                      className="text-[9px] h-4 w-[56px] px-0.5 rounded-[2px] border border-[var(--gd-line-main)] bg-white text-[var(--gd-ink-muted)] cursor-pointer shrink-0"
                      title="指派处理人"
                      aria-label={`指派 ${it.title} 的处理人`}
                    >
                      <option value="">指派</option>
                      {staffNames.map((n) => (
                        <option key={n} value={n}>{n}</option>
                      ))}
                    </select>
                  ) : null}
                  {it.tab && <ArrowRight className="w-3 h-3 text-[var(--gd-ink-muted)] shrink-0" />}
                </div>
                {/* 第二行：详情 + 明细 + 知道了 / 关闭
                    【2026-11-25 修】原来「知道了」「关闭」挤在第一行，280px 列宽下被压成 27×51px
                    竖排按钮（实测）。改为独立操作行，按钮加 whitespace-nowrap + shrink-0。 */}
                <div className="flex items-center gap-1 mt-1">
                  <div className={`text-[10.5px] leading-[1.4] text-[var(--gd-ink-muted)] truncate flex-1 min-w-0 ${expandedIds?.has(it.id) ? '' : ''}`}>{it.detail}</div>
                  {it.items && it.items.length > 0 && (
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); onToggleExpand?.(it.id); }}
                      className="text-[9px] px-1 rounded-[2px] border border-[var(--gd-line-soft)] text-[var(--gd-ink-muted)] hover:text-[var(--gd-ink-strong)] cursor-pointer shrink-0 whitespace-nowrap"
                      aria-label={expandedIds?.has(it.id) ? '收起明细' : '展开明细'}
                    >
                      {expandedIds?.has(it.id) ? '收起' : '明细'}
                    </button>
                  )}
                  {it.acked ? (
                    <span className="text-[9px] text-[var(--gd-ink-muted)] border border-[var(--gd-line-soft)] px-1 rounded-[2px] shrink-0 whitespace-nowrap">已消音</span>
                  ) : (
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); onAck?.(it.id); }}
                      className="text-[9px] px-1 py-0.5 rounded-[2px] border border-[var(--gd-line-main)] text-[var(--gd-ink-muted)] hover:text-[var(--gd-ink-strong)] cursor-pointer shrink-0 whitespace-nowrap"
                      title="确认收到：30 分钟内不再脉冲提醒"
                    >
                      知道了
                    </button>
                  )}
                  {onCloseAnomaly && (
                    <select
                      value=""
                      onClick={(e) => e.stopPropagation()}
                      onChange={(e) => {
                        e.stopPropagation();
                        const v = e.target.value as ClosureReason | '';
                        if (v) onCloseAnomaly(it.id, v, it.title, it.count);
                      }}
                      className="text-[9px] h-4 w-[54px] px-0.5 rounded-[2px] border border-[var(--gd-line-main)] bg-white text-[var(--gd-ink-muted)] cursor-pointer shrink-0"
                      title="关闭这条异常并留下原因"
                      aria-label={`关闭 ${it.title} 并记录原因`}
                    >
                      <option value="">关闭</option>
                      <option value="handled">已处理</option>
                      <option value="false_alarm">误报</option>
                    </select>
                  )}
                </div>
                {expandedIds?.has(it.id) && it.items && it.items.length > 0 && (
                  <ul className="mt-1 space-y-0.5 pl-1 border-l-2 border-[var(--gd-line-soft)]">
                    {it.items.map((line, li) => (
                      <li key={li} className="text-[10px] text-[var(--gd-ink-body)] leading-[1.5] list-none">
                        {line}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            );
          })
        )}
      </div>

      <footer className="px-3 py-2 border-t border-[var(--gd-line-section)] text-[9.5px] leading-[1.6] text-[var(--gd-ink-muted)]">
        <div className="flex items-center gap-3 mb-1">
          <span className="inline-flex items-center gap-1"><i className="ops-sev ops-sev--danger" />严重</span>
          <span className="inline-flex items-center gap-1"><i className="ops-sev ops-sev--warn" />警告</span>
          <span className="inline-flex items-center gap-1"><i className="ops-sev ops-sev--info" />提示</span>
        </div>
        阈值：出餐 &gt;{OPS_THRESHOLDS.serveTimeoutMin}min · 待接单 &gt;{OPS_THRESHOLDS.pendingTimeoutMin}min · 久坐 &gt;
        {OPS_THRESHOLDS.longStayMin}min
        <button
          type="button"
          onClick={() => onExport?.()}
          className="ml-2 inline-flex items-center gap-0.5 cursor-pointer hover:text-[var(--gd-ink-strong)] underline underline-offset-2"
          title="导出异常清单 CSV"
        >
          <Download className="w-2.5 h-2.5" />
          导出
        </button>
      </footer>
    </aside>
  );
};

/* ---------------------------- 主组件 ---------------------------- */

export const OpsDeckV2: React.FC<OpsDeckV2Props> = ({
  orders,
  tables,
  dishes,
  selectedTruckId,
  onSelectTruckId,
  showToast,
  onNavigate
}) => {
  const [cadence, setCadence] = useState<Cadence>('live');
  // 设计稿 §8：<1366 时异常带默认折叠为图标条，避免挤压主图区
  const [bandCollapsed, setBandCollapsed] = useState(
    () => typeof window !== 'undefined' && window.innerWidth < 1366
  );
  const [eventsExpanded, setEventsExpanded] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  /** 首帧骨架：数据未到且刚刚挂载时用骨架代替 0，避免冷启动像"没生意" */
  const [booting, setBooting] = useState(true);
  /** 热区格子的详情浮层（桌号/人数/时长/金额） */
  const [inspectedTable, setInspectedTable] = useState<TableItem | null>(null);
  /** G5 声音告警：新严重异常出现时短促提示音（默认关，M6 免打扰=直接关掉） */
  const [soundOn, setSoundOn] = useState(() => localStorage.getItem('obsidian_ops_sound') === '1');
  /** A1 营收目标设置弹层 */
  const [targetOpen, setTargetOpen] = useState(false);
  const [targetInput, setTargetInput] = useState('');
  /** 异常条目展开明细（id 集合） */
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  useEffect(() => {
    const t = window.setTimeout(() => setBooting(false), 600);
    return () => window.clearTimeout(t);
  }, []);

  // 实时通道健康：WS 连接 + 最近一次广播有回执（丢回执=跨设备广播没出去）
  const [rtHealthy, setRtHealthy] = useState(() => isRealtimeConnected());
  useEffect(() => {
    const iv = setInterval(() => {
      const d = getRealtimeDiag();
      const okNow = isRealtimeConnected() && !(d.lastPublishAt > d.lastEchoAt);
      setRtHealthy(okNow);
    }, 3000);
    return () => clearInterval(iv);
  }, []);

  // 断点变化时自动折叠/展开异常带（原实现只在挂载时判定一次）
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 1365px)');
    const onChange = (e: MediaQueryListEvent) => setBandCollapsed(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  // 按 Esc 退出全屏时，按钮图标要跟着回来
  useEffect(() => {
    const onFsChange = () => setFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', onFsChange);
    return () => document.removeEventListener('fullscreenchange', onFsChange);
  }, []);

  const ticker = useOpsTicker();
  // 暂停：冻结 now，所有派生不再随时间推进（数据变更仍会触发重算）
  const frozenNow = useMemo(() => Date.now(), [cadence === 'paused' ? 1 : 0]);
  const now = cadence === 'paused' ? frozenNow : ticker.now;

  const metrics = useOpsMetrics(orders, tables, now, ticker.aggTick);
  const [ackBump, setAckBump] = useState(0);
  const local = useOpsLocalData(ticker.aggTick, ackBump);
  const anomalies = useOpsAnomalies(
    orders, tables, dishes, now, ticker.aggTick,
    { lowStock: local.lowStock, printerOffline: local.printerOffline, printerTotal: local.printerTotal,
      lastShiftCashDiff: local.lastShift?.cashDiff, lastShiftReason: local.lastShift?.diffReasonText,
      riderPickup: local.rider.pickup, riderDelivering: local.rider.delivering, riderSamples: local.rider.samples },
    local.acks
  );
  // G3：已被关闭（已处理 / 误报）的异常不进入活动列表；数量反弹或超 30min 会自动重新出现
  const activeAnomalies = useMemo(
    () => anomalies.filter((a) => !isClosureActive(local.closures[a.id], a.count, now)),
    [anomalies, local.closures, now]
  );
  const closedToday = useMemo(() => todaysClosures(now).length, [local.closures, now]);
  const events = useOpsEvents(orders, now, ticker.aggTick);
  const revenueSeries = useRevenueSeries(orders, now, ticker.slowTick);
  // A2：昨日同时段对比层（2026-11-25）
  const prevRevenueSeries = usePrevRevenueSeries(orders, now, ticker.slowTick);
  const [showPrevSeries, setShowPrevSeries] = useState<boolean>(() => {
    try {
      return localStorage.getItem('ops_deck_show_prev_series') !== '0';
    } catch {
      return true;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem('ops_deck_show_prev_series', showPrevSeries ? '1' : '0');
    } catch {
      /* ignore */
    }
  }, [showPrevSeries]);
  const channels = useChannelSplit(orders, now, ticker.slowTick);
  const payments = usePaymentSplit(orders, now, ticker.slowTick);

  const clock = useMemo(() => {
    const d = new Date(now);
    const pad = (n: number) => String(n).padStart(2, '0');
    return { hhmm: `${pad(d.getHours())}:${pad(d.getMinutes())}`, ss: pad(d.getSeconds()), period: periodOf(d) };
  }, [now]);

  // 营业时段 10:00–22:00 的进行比例（指挥条中间那段进度）
  const dayPct = useMemo(() => {
    const d = new Date(now);
    const mins = d.getHours() * 60 + d.getMinutes();
    return Math.max(0, Math.min(100, ((mins - 600) / (1320 - 600)) * 100));
  }, [now]);

  const dangerCount = activeAnomalies.filter((a) => a.severity === 'danger').length;

  /** E4 盘点进度：actualQty>0 视为已盘（0 视为未盘；差异项计数） */
  const stocktake = useMemo(() => {
    try {
      const raw = JSON.parse(localStorage.getItem('obsidian_inventory_stock') || '[]') as {
        actualQty?: number; systemQty?: number; variance?: number; name?: string;
      }[];
      const total = raw.length;
      if (!total) return null;
      const done = raw.filter((i) => typeof i.actualQty === 'number' && i.actualQty > 0).length;
      const diff = raw.filter((i) => typeof i.variance === 'number' && i.variance !== 0).length;
      return { total, done, diff };
    } catch { return null; }
  }, [ticker.slowTick]);



  // G5 声音告警：danger 集合变化（新增）且开关打开且页面可见 → beep 一声
  // 用 activeAnomalies：已关闭的异常不该再响（G3 联动）
  const lastDangerKeyRef = useRef('');
  useEffect(() => {
    const key = activeAnomalies.filter((a) => a.severity === 'danger').map((a) => a.id + ':' + a.count).join('|');
    const prev = lastDangerKeyRef.current;
    lastDangerKeyRef.current = key;
    if (!soundOn || document.visibilityState !== 'visible') return;
    if (prev && key && key !== prev && dangerCount > 0) {
      try {
        const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        const ctx = new Ctx();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.frequency.value = 880;
        gain.gain.value = 0.07;
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start();
        osc.stop(ctx.currentTime + 0.15);
        setTimeout(() => { try { ctx.close(); } catch { /* ignore */ } }, 300);
      } catch { /* ignore */ }
    }
  }, [activeAnomalies, soundOn, dangerCount]);

  const toggleSound = () => {
    setSoundOn((v) => {
      try { localStorage.setItem('obsidian_ops_sound', v ? '0' : '1'); } catch { /* ignore */ }
      return !v;
    });
  };

  // M7 键盘快捷键：F 全屏 · P 节奏 · A 全部消音 · R 立即对账（输入框内不触发）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && /INPUT|SELECT|TEXTAREA/.test(el.tagName)) return;
      if (e.key === 'f' || e.key === 'F') toggleFullscreen();
      else if (e.key === 'p' || e.key === 'P') cycCadenceRef.current();
      else if (e.key === 'a' || e.key === 'A') {
        ackAllCurrent(anomalies.map((a) => a.id));
        setAckBump((v) => v + 1);
      } else if (e.key === 'r' || e.key === 'R') {
        window.dispatchEvent(new CustomEvent('obsidian_rt_reconcile'));
        showToast('已触发云端对账…');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [anomalies]);

  // 保存营收目标
  const saveTarget = () => {
    const v = Number(targetInput);
    if (Number.isFinite(v) && v > 0) {
      try { localStorage.setItem('obsidian_revenue_target_daily', String(v)); } catch { /* ignore */ }
    } else {
      try { localStorage.removeItem('obsidian_revenue_target_daily'); } catch { /* ignore */ }
    }
    setTargetOpen(false);
    setAckBump((v) => v + 1); // 复用 bump 通道刷新 local 数据
  };

  // H4 导出异常清单 CSV
  const exportAnomaliesCsv = () => {
    // G3：导出当前活动异常 + 今日已解除记录，交接班复盘用
    const closed = todaysClosures(now);
    const rows = [
      ['状态', '严重度', '类型', '数量', '明细'],
      ...activeAnomalies.map((a) => [
        '活动',
        a.severity === 'danger' ? '严重' : a.severity === 'warn' ? '警告' : '提示',
        a.title,
        String(a.count),
        a.detail
      ]),
      ...closed.map((c) => [
        `已解除(${c.reason === 'handled' ? '已处理' : '误报'})`,
        '',
        c.title,
        String(c.count),
        `关闭于 ${new Date(c.at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}${c.by ? ' · ' + c.by : ''}`
      ])
    ];
    const csv = '\uFEFF' + rows.map((r) => r.map((c) => `"${c.replace(/"/g, '""')}"`).join(',')).join('\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `异常清单-${new Date().toISOString().slice(0, 16).replace('T', '_')}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // 三端对比（今日 vs 昨日同时段）+ 履约漏斗 + 翻台（A3/B1/D2 落地）
  const channelCompare = useMemo(() => {
    const nowDate = new Date(now);
    const todayZero = new Date(nowDate.getFullYear(), nowDate.getMonth(), nowDate.getDate()).getTime();
    const secsToday = Math.max(60000, now - todayZero);
    const inWin = (o: Order, start: number, end: number) => {
      const t = orderMs(o);
      return Number.isFinite(t) && t >= start && t < end;
    };
    const mk = (ch: 'dine_in' | 'delivery' | 'pickup') => {
      const today = orders.filter((o) => o.channelType === ch && inWin(o, todayZero, now));
      const yStart = todayZero - 86400000;
      const prev = orders.filter((o) => o.channelType === ch && inWin(o, yStart, yStart + secsToday));
      const rev = today.reduce((a, o) => a + (Number(o.totalAmount) || 0), 0);
      const prevRev = prev.reduce((a, o) => a + (Number(o.totalAmount) || 0), 0);
      const deltaPct = prevRev > 0 ? ((rev - prevRev) / prevRev) * 100 : null;
      return {
        key: ch,
        orders: today.length,
        prevOrders: prev.length,
        revenue: rev,
        prevRevenue: prevRev,
        atv: today.length ? rev / today.length : 0,
        prevAtv: prev.length ? prevRev / prev.length : 0,
        deltaPct
      };
    };
    return [mk('delivery'), mk('dine_in'), mk('pickup')];
  }, [orders, now]);

  // 履约漏斗（环节时间戳优先，历史单按状态推断——与营收页同口径）
  const fulfillment = useMemo(() => {
    const inStatus = (o: Order, list: Order['status'][]) => list.includes(o.status);
    const cnt = (f: (o: Order) => boolean) => orders.filter(f).length;
    return [
      { label: '下单', count: orders.length },
      { label: '接单', count: cnt((o) => Boolean(o.acceptedAt) || inStatus(o, ['cooking', 'ready', 'rider_heading', 'waiting_pickup', 'picked_up', 'delivering', 'completed'])) },
      { label: '出餐', count: cnt((o) => Boolean(o.readyAt) || inStatus(o, ['ready', 'waiting_pickup', 'picked_up', 'delivering', 'completed'])) },
      { label: '取餐', count: cnt((o) => (Boolean(o.pickedAt) || inStatus(o, ['picked_up', 'delivering', 'completed'])) && o.channelType !== 'dine_in') },
      { label: '送达', count: cnt((o) => Boolean(o.deliveredAt) || (o.status === 'completed' && o.channelType === 'delivery')) }
    ];
  }, [orders]);

  // 翻台与平均用餐时长（堂食口径）
  const tableOps = useMemo(() => {
    const nowDate = new Date(now);
    const todayZero = new Date(nowDate.getFullYear(), nowDate.getMonth(), nowDate.getDate()).getTime();
    const diners = orders.filter((o) => o.channelType === 'dine_in' && o.status === 'completed' && orderMs(o) >= todayZero);
    const turnover = tables.length ? diners.length / tables.length : 0;
    const diningTables = tables.filter((t) => t.status === 'dining' && typeof t.elapsedMinutes === 'number');
    const avgStay = diningTables.length ? diningTables.reduce((a, t) => a + (t.elapsedMinutes || 0), 0) / diningTables.length : null;
    return { turnover, avgStay, diners: diners.length };
  }, [orders, tables, now]);

  // H5 布局显隐配置（localStorage 持久化）
  const KPI_LABELS: Record<string, string> = {
    revenue: '今日营收',
    orders: '在制订单',
    serve: '平均出餐',
    occupancy: '上座率'
  };
  const CHART_LABELS: Record<string, string> = {
    revenue: '营收曲线',
    tables: '台位热区',
    channel: '三端对比',
    payment: '支付方式',
    refund: '退款原因'
  };
  const [layoutPrefs, setLayoutPrefs] = useState<{ kpi: string[]; charts: string[] }>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem('obsidian_ops_layout_v1') || '');
      if (saved && Array.isArray(saved.kpi)) return saved;
    } catch { /* ignore */ }
    return {
      kpi: ['revenue', 'orders', 'serve', 'occupancy'],
      charts: ['revenue', 'tables', 'channel', 'payment', 'refund']
    };
  });
  const [layoutOpen, setLayoutOpen] = useState(false);
  const toggleLayout = (group: 'kpi' | 'charts', key: string) => {
    setLayoutPrefs((prev) => {
      const cur = prev[group].includes(key);
      const next = cur ? prev[group].filter((k) => k !== key) : [...prev[group], key];
      if (next.length === 0) return prev; // 至少保留一项
      const newState = { ...prev, [group]: next };
      try { localStorage.setItem('obsidian_ops_layout_v1', JSON.stringify(newState)); } catch { /* ignore */ }
      return newState;
    });
  };

  // TOP3 销量（今日，含分端）
  const top3Dishes = useMemo(() => {
    const m = new Map<string, { name: string; qty: number; delivery: number; dine_in: number; pickup: number }>();
    const nowDate = new Date(now);
    const startOfToday = new Date(nowDate.getFullYear(), nowDate.getMonth(), nowDate.getDate()).getTime();
    for (const o of orders) {
      const t = orderMs(o);
      if (!Number.isFinite(t) || t < startOfToday) continue;
      const ch = o.channelType;
      for (const it of o.items) {
        const e = m.get(it.name) || { name: it.name, qty: 0, delivery: 0, dine_in: 0, pickup: 0 };
        e.qty += it.quantity;
        if (ch === 'delivery' || ch === 'dine_in' || ch === 'pickup') e[ch] += it.quantity;
        m.set(it.name, e);
      }
    }
    return [...m.values()].sort((a, b) => b.qty - a.qty).slice(0, 3);
  }, [orders, now]);
  // B5 退款/取消原因分布（今日，按原因聚合，Top1 高亮）
  const refundInsight = useMemo(() => {
    const nowDate = new Date(now);
    const startOfToday = new Date(nowDate.getFullYear(), nowDate.getMonth(), nowDate.getDate()).getTime();
    const rows = orders.filter((o) => {
      if (orderMs(o) < startOfToday) return false;
      return o.status === 'refunded' || o.status === 'refund_pending' || o.status === 'cancelled';
    });
    const m = new Map<string, { reason: string; count: number; amount: number }>();
    for (const o of rows) {
      const raw = (o.refundReason || '').trim();
      const reason = raw || (o.status === 'cancelled' ? '顾客取消' : '未填写原因');
      const e = m.get(reason) || { reason, count: 0, amount: 0 };
      e.count += 1;
      e.amount += Number(o.totalAmount) || 0;
      m.set(reason, e);
    }
    const list = [...m.values()].sort((a, b) => b.count - a.count || b.amount - a.amount);
    const total = list.reduce((s, x) => s + x.count, 0);
    return {
      list: list.slice(0, 5),
      total,
      amount: list.reduce((s, x) => s + x.amount, 0),
      topShare: total && list[0] ? list[0].count / total : 0,
      hasReason: rows.some((o) => (o.refundReason || '').trim().length > 0)
    };
  }, [orders, now]);

  const totalAnomaly = activeAnomalies.length;
  const toggleFullscreen = useCallback(() => {
    if (!document.fullscreenElement) {
      void document.documentElement.requestFullscreen?.();
      setFullscreen(true);
    } else {
      void document.exitFullscreen?.();
      setFullscreen(false);
    }
  }, []);

  const cycCadenceRef = useRef(() => {});
  const cycCadence = () => {
    setCadence((c) => (c === 'live' ? 'slow' : c === 'slow' ? 'paused' : 'live'));
  };

  cycCadenceRef.current = cycCadence;
  const jump = (tab: string) => {
    if (onNavigate) onNavigate(tab);
    else showToast('该指标暂未配置跳转目标');
  };

  const totalChannelAmount = channels.reduce((s, c) => s + c.amount, 0) || 1;
  const totalPaymentAmount = payments.reduce((s, p) => s + p.amount, 0) || 1;

  // 台位按区聚合（散座/卡座/外摆）
  const tableGroups = useMemo(() => {
    const map = new Map<string, TableItem[]>();
    for (const t of tables) {
      const k = t.zone || 'hall';
      if (!map.has(k)) map.set(k, []);
      map.get(k)!.push(t);
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [tables]);

  return (
    <div className="ops-deck-scope min-h-screen w-full flex flex-col" style={{ background: '#ffffff' }}>
      {/* 数据通道异常顶条（H2）：WS 断/丢回执时提示，恢复正常自动消失 */}
      {!rtHealthy && (
        <button
          type="button"
          onClick={() => { window.dispatchEvent(new CustomEvent('obsidian_rt_reconcile')); showToast('已触发云端对账…'); }}
          className="w-full h-6 text-[10.5px] flex items-center justify-center gap-1 cursor-pointer"
          style={{ background: 'var(--gd-danger-soft, #fdf0ef)', color: 'var(--gd-danger)' }}
        >
          数据通道异常 · 已启用云端对账兜底（点击立即对账）
        </button>
      )}

      {/* ① 指挥条 */}
      <header className="ops-bar px-3 flex items-center gap-3 shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <span className="w-1.5 h-1.5 rounded-full" style={{ background: 'var(--gd-brand)' }} />
          <select
            value={selectedTruckId}
            onChange={(e) => onSelectTruckId(e.target.value)}
            className="bg-transparent text-[11px] text-[var(--gd-ink-strong)] outline-none cursor-pointer max-w-[180px]"
            aria-label="门店切换"
          >
            <option value={selectedTruckId}>{selectedTruckId.replace('truck-', '')} 号车 · 本店</option>
          </select>
          <span className="text-[10.5px] px-1.5 py-0.5 rounded-[2px]" style={{ background: 'var(--gd-brand-soft)', color: 'var(--gd-brand)', border: '1px solid var(--gd-brand-line)' }}>
            营业中
          </span>
          <span className="text-[10.5px] text-[var(--gd-ink-muted)]">{clock.period}</span>
          {local.lastShift && (
            <span
              className="text-[10.5px] text-[var(--gd-ink-muted)] truncate max-w-[180px]"
              title={`上次交班 ${local.lastShift.closedBy} → ${local.lastShift.successor}${local.lastShift.cashDiff !== 0 ? ` · 现金差异 ¥${Math.abs(local.lastShift.cashDiff).toFixed(2)}` : ''}`}
            >
              上次交班 {new Date(local.lastShift.endTime).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })}
              {local.lastShift.cashDiff !== 0 && <span className="text-[var(--gd-danger)]"> · 差 ¥{Math.abs(local.lastShift.cashDiff).toFixed(0)}</span>}
            </span>
          )}
          <div className="hidden lg:flex items-center gap-2 w-[200px] ml-1" title="营业时段 10:00–22:00 进度">
            <span className="ops-num text-[9.5px] text-[var(--gd-ink-muted)] shrink-0">10:00</span>
            <div className="ops-period-track flex-1">
              <div className="ops-period-fill" style={{ width: `${dayPct}%` }} />
            </div>
            <span className="ops-num text-[9.5px] text-[var(--gd-ink-muted)] shrink-0">
              {dayPct <= 0 ? '未开始' : dayPct >= 100 ? '已结束' : '22:00'}
            </span>
          </div>
        </div>

        <span className="flex-1" />

        <div className="flex items-center gap-1 text-[var(--gd-ink-body)]">
          <span className="ops-num text-[13px] font-semibold">{clock.hhmm}</span>
          <span className="ops-num text-[10.5px] text-[var(--gd-ink-muted)]">:{clock.ss}</span>
        </div>

        {local.staff.total > 0 && (
          <button
            type="button"
            onClick={() => jump('staff_center')}
            className="text-[10.5px] px-1.5 py-0.5 rounded-[2px] border border-[var(--gd-line-section)] bg-[var(--gd-surface)] text-[var(--gd-ink-muted)] hover:text-[var(--gd-ink-strong)] cursor-pointer tabular-nums"
            title={`在岗 ${local.staff.onDuty} 人 / 共 ${local.staff.total} 人（点开员工中心）`}
          >
            在岗 {local.staff.onDuty}/{local.staff.total}
          </button>
        )}

        {stocktake && (
          <span
            className="text-[10.5px] px-1.5 py-0.5 rounded-[2px] tabular-nums"
            style={{
              border: '1px solid var(--gd-line-section)',
              background: stocktake.diff > 0 ? 'var(--gd-amber-soft, #fdf6e3)' : 'var(--gd-surface)',
              color: stocktake.diff > 0 ? 'var(--gd-amber)' : 'var(--gd-ink-muted)'
            }}
            title={`打烊盘点：已盘 ${stocktake.done}/${stocktake.total}，差异 ${stocktake.diff} 项`}
          >
            盘点 {stocktake.done}/{stocktake.total}{stocktake.diff > 0 ? ` · 差异 ${stocktake.diff}` : ''}
          </span>
        )}

        <button
          type="button"
          onClick={toggleSound}
          className="w-7 h-7 grid place-items-center rounded-[2px] border border-[var(--gd-line-main)] cursor-pointer"
          style={{ color: soundOn ? 'var(--gd-brand)' : 'var(--gd-ink-muted)' }}
          title={soundOn ? '声音告警：开（新严重异常时提示音）' : '声音告警：关（免打扰）'}
          aria-label={soundOn ? '关闭声音告警' : '开启声音告警'}
        >
          {soundOn ? <Volume2 className="w-3.5 h-3.5" /> : <VolumeX className="w-3.5 h-3.5" />}
        </button>

        <button
          type="button"
          onClick={() => { setTargetInput(local.revenueTarget > 0 ? String(local.revenueTarget) : ''); setTargetOpen((v) => !v); }}
          className="h-7 px-2 rounded-[2px] border border-[var(--gd-line-main)] cursor-pointer text-[10.5px] text-[var(--gd-ink-muted)] hover:text-[var(--gd-ink-strong)]"
          title="设置今日营收目标"
        >
          目标
        </button>

        <span
          className="w-1.5 h-1.5 rounded-full shrink-0"
          style={{ background: rtHealthy ? 'var(--gd-brand)' : 'var(--gd-danger)' }}
          title={rtHealthy ? '实时通道已连接' : '实时通道异常：已启用云端对账兜底'}
          aria-label={rtHealthy ? '实时通道已连接' : '实时通道异常'}
        />

        <button
          type="button"
          onClick={() => jump('contingency')}
          className="flex items-center gap-1.5 px-2 h-7 rounded-[2px] border cursor-pointer transition-colors"
          style={{
            borderColor: totalAnomaly ? 'rgba(212,67,51,0.35)' : 'var(--gd-line-main)',
            background: totalAnomaly ? 'rgba(212,67,51,0.06)' : 'transparent',
            color: totalAnomaly ? 'var(--gd-danger)' : 'var(--gd-ink-muted)'
          }}
          title="查看异常"
        >
          <AlertTriangle className="w-3.5 h-3.5" />
          <span className="ops-num text-[10.5px] font-semibold">{totalAnomaly}</span>
          {dangerCount > 0 && <span className="text-[9.5px]">严重 {dangerCount}</span>}
        </button>

        <button
          type="button"
          onClick={cycCadence}
          className="flex items-center gap-1.5 h-7 px-2 rounded-[2px] border border-[var(--gd-line-main)] cursor-pointer text-[10.5px] text-[var(--gd-ink-muted)] hover:text-[var(--gd-ink-strong)]"
          title="刷新节奏：实时 / 降频 / 暂停"
        >
          <RefreshCw className="w-3.5 h-3.5" />
          {cadence === 'live' ? '实时 5s' : cadence === 'slow' ? '降频 30s' : '已暂停'}
        </button>

        <button
          type="button"
          onClick={() => setLayoutOpen((v) => !v)}
          className="w-7 h-7 grid place-items-center rounded-[2px] border cursor-pointer transition-colors"
          style={{
            borderColor: layoutOpen ? 'var(--gd-brand)' : 'var(--gd-line-main)',
            background: layoutOpen ? 'var(--gd-brand-soft, #eef3ef)' : 'transparent',
            color: layoutOpen ? 'var(--gd-brand)' : 'var(--gd-ink-muted)'
          }}
          title="自选显示的指标（H5）"
          aria-pressed={layoutOpen}
          aria-label="自选显示的指标"
        >
          <SlidersHorizontal className="w-3.5 h-3.5" />
        </button>

        <button
          type="button"
          onClick={toggleFullscreen}
          className="w-7 h-7 grid place-items-center rounded-[2px] border border-[var(--gd-line-main)] cursor-pointer text-[var(--gd-ink-muted)] hover:text-[var(--gd-ink-strong)]"
          title="全屏"
        >
          {fullscreen ? <Minimize2 className="w-3.5 h-3.5" /> : <Maximize2 className="w-3.5 h-3.5" />}
        </button>
      </header>

      {/* 主体：左内容 + 右异常带 */}
      <div className="flex-1 flex min-h-0">
        <div className="ops-scroll flex-1 min-w-0 overflow-y-auto">
          {/* ② 巨指标带 */}
          <div className="grid grid-cols-2 min-[1560px]:grid-cols-4 gap-3 p-4 pb-3">
              {layoutPrefs.kpi.includes('revenue') && (
            <Kpi
              label="今日营收"
              ringPct={local.revenueTarget > 0 ? (metrics.revenue / local.revenueTarget) * 100 : undefined}
              loading={booting && orders.length === 0}
              value={<RollingNumber value={`¥${fmtMoney(metrics.revenue)}`} />}
              badge={
                metrics.deltaPct === null
                  ? { text: '昨日无对比', tone: 'flat' as const }
                  : {
                      text: `${metrics.deltaPct >= 0 ? '▲' : '▼'} ${Math.abs(metrics.deltaPct).toFixed(1)}%`,
                      tone: metrics.deltaPct >= 0 ? ('up' as const) : ('down' as const)
                    }
              }
              hint={
                local.revenueTarget > 0 ? (
                  <span className="ops-num">
                    目标 ¥{fmtMoney(local.revenueTarget)} · 还差 ¥{fmtMoney(Math.max(0, local.revenueTarget - metrics.revenue))}
                  </span>
                ) : (
                  <span className="ops-num">昨日同时段 ¥{fmtMoney(metrics.prevRevenue)}</span>
                )
              }
              trend={metrics.revenueTrend}
              meter={local.revenueTarget > 0 ? (metrics.revenue / local.revenueTarget) * 100 : metrics.prevRevenue > 0 ? (metrics.revenue / (metrics.prevRevenue * 1.2)) * 100 : 0}
              onClick={() => jump('analytics')}
            />
              )}
              {layoutPrefs.kpi.includes('orders') && (
            <Kpi
              label="在制订单"
              loading={booting && orders.length === 0}
              value={<RollingNumber value={String(metrics.inProgress)} />}
              unit="单"
              badge={
                metrics.inProgress === 0
                  ? { text: '空闲', tone: 'flat' as const }
                  : { text: `${metrics.inProgress} 单在手`, tone: 'up' as const }
              }
              hint={<span>待接单 · 制作中 · 待取餐</span>}
              trend={metrics.orderTrend}
              trendColor="var(--gd-info)"
              meter={metrics.totalTables ? Math.min(100, (metrics.inProgress / Math.max(1, metrics.totalTables)) * 100) : 0}
              onClick={() => jump('orders')}
            />
              )}
              {layoutPrefs.kpi.includes('serve') && (
            <Kpi
              label="平均出餐"
              loading={booting && orders.length === 0}
              value={<RollingNumber value={fmtMinutes(metrics.avgServeMin)} />}
              badge={
                metrics.avgServeMin === null
                  ? { text: '无完成单', tone: 'flat' as const }
                  : metrics.avgServeMin >= OPS_THRESHOLDS.serveTimeoutMin
                  ? { text: '超阈值', tone: 'down' as const }
                  : { text: '正常', tone: 'up' as const }
              }
              hint={
                <span className="ops-num">
                  P50 {fmtMinutes(metrics.p50)} · P90 {fmtMinutes(metrics.p90)}
                </span>
              }
              meter={metrics.avgServeMin === null ? 0 : (metrics.avgServeMin / OPS_THRESHOLDS.serveCriticalMin) * 100}
              warn={metrics.avgServeMin !== null && metrics.avgServeMin >= OPS_THRESHOLDS.serveTimeoutMin}
              onClick={() => jump('kds')}
            />
              )}
              {layoutPrefs.kpi.includes('occupancy') && (
            <Kpi
              label="上座率"
              loading={booting && orders.length === 0}
              value={<RollingNumber value={String(metrics.occupancyPct)} />}
              unit="%"
              badge={
                metrics.occupancyPct >= 80
                  ? { text: '接近满座', tone: 'down' as const }
                  : metrics.occupancyPct >= 40
                  ? { text: '正常', tone: 'up' as const }
                  : { text: '空座偏多', tone: 'flat' as const }
              }
              hint={
                <span className="ops-num">
                  {metrics.occupied} 桌在席 / 共 {metrics.totalTables} 桌
                </span>
              }
              meter={metrics.occupancyPct}
              onClick={() => jump('tables')}
            />
              )}
          </div>

          {/* ③ 主图表区 */}
          <div className="px-4 grid grid-cols-1 2xl:grid-cols-2 gap-3">
            {layoutPrefs.charts.includes('revenue') && (
            <Card
              title="营收曲线 · 5 分钟"
              meta={
                <span className="inline-flex items-center gap-2">
                  <span>近 8 小时 · 累计 ¥{fmtMoney(revenueSeries[revenueSeries.length - 1]?.cum || 0)}</span>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      setShowPrevSeries((v) => !v);
                    }}
                    className="inline-flex items-center gap-1 rounded-[2px] border px-1.5 py-0.5 font-label-micro transition-colors"
                    style={{
                      borderColor: 'var(--gd-line-main)',
                      background: showPrevSeries ? 'var(--gd-brand-soft, #eef3ef)' : 'transparent',
                      color: 'var(--gd-ink-muted)'
                    }}
                    aria-pressed={showPrevSeries}
                    aria-label={showPrevSeries ? '隐藏昨日同时段对比线' : '显示昨日同时段对比线'}
                    title="叠加昨日同时段累计（虚线）"
                  >
                    <span
                      aria-hidden
                      className="inline-block w-3"
                      style={{ borderTop: '1.5px dashed rgba(120,119,116,.75)' }}
                    />
                    昨日
                  </button>
                </span>
              }
              className="h-[320px]"
            >
              {metrics.revenue === 0 ? (
                <div className="ops-chart-grid h-full">
                  <Empty
                    icon={<BarChart3 className="w-4 h-4" />}
                    title="今日暂无订单"
                    desc="有订单后这里会按 5 分钟粒度绘制营收柱与累计曲线"
                    action={<button type="button" onClick={() => jump('orders')} className="ds-btn mt-1">去订单中心</button>}
                  />
                </div>
              ) : (
                <RevenueChart points={revenueSeries} prevPoints={prevRevenueSeries} showPrev={showPrevSeries} height={286} />
              )}
            </Card>
            )}

            {layoutPrefs.charts.includes('tables') && (
            <Card
              title="台位热区"
              meta={`翻台 ${tableOps.turnover.toFixed(1)} · 接待 ${tableOps.diners} 桌 · 均长 ${tableOps.avgStay ? Math.round(tableOps.avgStay) + 'min' : '—'}`}
              className="h-[320px]"
              onClick={() => jump('tables')}
            >
              <div className="p-3 space-y-3 h-full overflow-y-auto">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span className="ops-legend"><i style={{ background: 'var(--gd-brand-soft)', borderColor: 'var(--gd-brand-line)' }} />在席</span>
                  <span className="ops-legend"><i style={{ background: 'rgba(212,67,51,0.10)', borderColor: 'rgba(212,67,51,0.45)' }} />久坐</span>
                  <span className="ops-legend"><i style={{ background: 'var(--gd-amber-soft)' }} />清台</span>
                  <span className="ops-legend"><i style={{ background: 'rgba(28,85,152,0.06)' }} />预留</span>
                  <span className="ops-legend"><i style={{ background: '#fff' }} />空闲</span>
                </div>
                {tableGroups.length === 0 && (
                  <div className="text-[10.5px] text-[var(--gd-ink-muted)]">暂无台位数据</div>
                )}
                {tableGroups.map(([zone, list]) => (
                  <div key={zone}>
                    <div className="flex items-center gap-2 mb-1.5">
                      <span className="text-[10.5px] text-[var(--gd-ink-body)]">{ZONE_LABEL[zone] || zone}</span>
                      <span className="ops-num text-[10.5px] text-[var(--gd-ink-muted)]">
                        {list.filter((t) => t.status === 'dining').length}/{list.length}
                      </span>
                    </div>
                    <div className="grid gap-1" role="grid" aria-label={`${ZONE_LABEL[zone] || zone}台位状态`} style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(38px, 1fr))' }}>
                      {list.map((t) => {
                        const dining = t.status === 'dining';
                        const long = dining && (t.elapsedMinutes || 0) >= OPS_THRESHOLDS.longStayMin;
                        return (
                          <div
                            key={t.id}
                            role="gridcell"
                            tabIndex={0}
                            aria-label={`${t.code} ${
                              t.status === 'dining' ? '在席' : t.status === 'cleaning' ? '清台' : t.status === 'reserved' ? '预留' : '空闲'
                            }${t.elapsedMinutes ? ` ${t.elapsedMinutes} 分钟` : ''}`}
                            onClick={(e) => {
                              e.stopPropagation();
                              setInspectedTable(t);
                            }}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter' || e.key === ' ') {
                                e.preventDefault();
                                e.stopPropagation();
                                setInspectedTable(t);
                              }
                            }}
                            className="ops-heat-cell h-[34px] grid place-items-center cursor-pointer"
                            title={`${t.code} · ${t.status === 'dining' ? '在席' : t.status === 'cleaning' ? '清台' : t.status === 'reserved' ? '预留' : '空闲'}${t.elapsedMinutes ? ` · ${t.elapsedMinutes}min` : ''}`}
                            style={{
                              background: dining
                                ? long
                                  ? 'rgba(212,67,51,0.10)'
                                  : 'var(--gd-brand-soft)'
                                : t.status === 'cleaning'
                                ? 'var(--gd-amber-soft)'
                                : t.status === 'reserved'
                                ? 'rgba(28,85,152,0.06)'
                                : '#fff',
                              borderColor: dining
                                ? long
                                  ? 'rgba(212,67,51,0.45)'
                                  : 'var(--gd-brand-line)'
                                : 'var(--gd-line-soft)'
                            }}
                          >
                            <span className="ops-num text-[10px] text-[var(--gd-ink-body)]">{t.code}</span>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            </Card>
            )}

            {layoutPrefs.charts.includes('channel') && (
            <Card title="三端对比 · 今日 vs 昨日同时段" meta={`${channelCompare.reduce((a, c) => a + c.orders, 0)} 单 · 骑手待取 ${local.rider.pickup} / 在途 ${local.rider.delivering}`} className="min-h-[240px]">
              <div className="p-3 flex flex-col min-h-full">
                {/* 三端对比网格：单量 / 金额 / 客单 / 环比 */}
                <div className="grid grid-cols-3 gap-2">
                  {channelCompare.map((c) => {
                    const label = c.key === 'delivery' ? '外卖' : c.key === 'dine_in' ? '堂食' : '自提';
                    const up = c.deltaPct !== null && c.deltaPct >= 0;
                    return (
                      <button
                        key={c.key}
                        type="button"
                        onClick={() => jump('orders')}
                        className="border border-[var(--gd-line-soft)] rounded-[4px] p-2 text-left cursor-pointer hover:border-[var(--gd-line-main)] transition-colors"
                        title={`${label}：今日 ${c.orders} 单 ¥${fmtMoney(c.revenue)} · 昨日同时段 ${c.prevOrders} 单 ¥${fmtMoney(c.prevRevenue)}`}
                      >
                        <div className="flex items-center justify-between">
                          <span className="text-[10px] text-[var(--gd-ink-muted)]">{label}</span>
                          {c.deltaPct !== null && (
                            <span
                              className="text-[9px] px-1 rounded-[2px] tabular-nums"
                              style={up
                                ? { background: 'var(--gd-brand-soft)', color: 'var(--gd-brand)' }
                                : { background: 'rgba(186,26,26,0.07)', color: 'var(--gd-danger)' }}
                            >
                              {up ? '▲' : '▼'}{Math.abs(c.deltaPct).toFixed(0)}%
                            </span>
                          )}
                        </div>
                        <div className="ops-num text-[16px] font-semibold text-[var(--gd-ink-strong)] leading-tight mt-0.5">
                          ¥{fmtMoney(c.revenue)}
                        </div>
                        <div className="ops-num text-[9.5px] text-[var(--gd-ink-muted)] mt-0.5">
                          {c.orders} 单 · 客单 ¥{c.atv.toFixed(0)}
                        </div>
                      </button>
                    );
                  })}
                </div>

                {/* 履约漏斗 mini：五段横条 */}
                <div className="mt-2.5">
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-[9.5px] uppercase tracking-[0.06em] text-[var(--gd-ink-muted)]">履约漏斗</span>
                    <span className="text-[9.5px] text-[var(--gd-ink-muted)]">历史单按状态推断</span>
                  </div>
                  <div className="grid grid-cols-5 gap-1">
                    {fulfillment.map((st, i) => {
                      const base = fulfillment[0].count || 1;
                      return (
                        <div key={st.label} className="text-center">
                          <div className="h-1.5 bg-[var(--gd-line-soft)] rounded-[1px] overflow-hidden">
                            <div className="h-full bg-[var(--gd-brand)]" style={{ width: `${(st.count / base) * 100}%` }} />
                          </div>
                          <div className="ops-num text-[10px] text-[var(--gd-ink-strong)] mt-0.5">{st.count}</div>
                          <div className="text-[9px] text-[var(--gd-ink-muted)]">{st.label}</div>
                          {i > 0 && fulfillment[i - 1].count - st.count > 0 && (
                            <div className="text-[8.5px] text-[var(--gd-danger)] tabular-nums">-{fulfillment[i - 1].count - st.count}</div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>

                {/* TOP3 销量 chips */}
                {top3Dishes.length > 0 && (
                  <div className="mt-auto pt-2 border-t border-[var(--gd-line-soft)] flex items-center gap-1.5 flex-wrap">
                    <span className="text-[9.5px] text-[var(--gd-ink-muted)] shrink-0">TOP3</span>
                    {top3Dishes.map((d, i) => (
                      <span key={d.name} className="text-[9.5px] px-1 py-0.5 rounded-[2px] bg-[var(--gd-brand-soft)] text-[var(--gd-brand)] border border-[var(--gd-brand-line)] tabular-nums truncate max-w-[110px]" title={`${d.name}：${d.qty} 份（外${d.delivery}/堂${d.dine_in}/提${d.pickup}）`}>
                        {i + 1}. {d.name} ×{d.qty}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </Card>
            )}

            {layoutPrefs.charts.includes('payment') && (
            <Card title="支付方式 · 今日" meta={`${payments.reduce((s, p) => s + p.count, 0)} 笔`} className="h-[220px]">
              {payments.length === 0 ? (
                <Empty icon={<BarChart3 className="w-4 h-4" />} title="今日暂无支付记录" desc="完成第一笔收款后会展示渠道占比" />
              ) : (
              <div className="p-3 flex items-center gap-4">
                {(() => {
                  const palette = ['#2b593f', '#1c5598', '#c26d00', '#8a8a82', '#c4dcbc'];
                  let acc = 0;
                  const stops = payments.map((p, i) => {
                    const from = (acc / totalPaymentAmount) * 360;
                    acc += p.amount;
                    const to = (acc / totalPaymentAmount) * 360;
                    return `${palette[i % palette.length]} ${from}deg ${to}deg`;
                  });
                  return (
                    <div
                      className="w-[92px] h-[92px] rounded-full shrink-0"
                      style={{
                        background: payments.length ? `conic-gradient(${stops.join(',')})` : 'var(--gd-line-soft)',
                        mask: 'radial-gradient(circle at center, transparent 52%, #000 53%)',
                        WebkitMask: 'radial-gradient(circle at center, transparent 52%, #000 53%)'
                      }}
                      aria-hidden="true"
                    />
                  );
                })()}
                <div className="flex-1 space-y-2">
                  {payments.length === 0 && <div className="text-[10.5px] text-[var(--gd-ink-muted)]">今日暂无支付记录</div>}
                  {payments.map((p) => (
                    <div key={p.key} className="flex items-center gap-2">
                      <span className="text-[10.5px] text-[var(--gd-ink-body)] flex-1">{p.label}</span>
                      <span className="ops-num text-[10.5px] text-[var(--gd-ink-muted)]">{p.count} 笔</span>
                      <span className="ops-num text-[11px] text-[var(--gd-ink-strong)] w-16 text-right">¥{fmtMoney(p.amount)}</span>
                    </div>
                  ))}
                </div>
              </div>
              )}
            </Card>
            )}

            {layoutPrefs.charts.includes('refund') && (
            <Card
              title="退款与取消 · 今日"
              meta={
                refundInsight.total
                  ? `${refundInsight.total} 笔 · ¥${fmtMoney(refundInsight.amount)}`
                  : '无'
              }
              className="h-[220px]"
              onClick={() => jump('contingency')}
            >
              {refundInsight.total === 0 ? (
                <Empty
                  icon={<CheckCircle2 className="w-4 h-4" />}
                  title="今日无退款与取消"
                  desc="有退款或取消时会按原因聚合，占比最高的一条高亮"
                />
              ) : (
                <div className="p-3 h-full flex flex-col gap-2 overflow-y-auto">
                  {refundInsight.list.map((r, i) => {
                    const pct = (r.count / refundInsight.total) * 100;
                    return (
                      <div key={r.reason} className="space-y-1">
                        <div className="flex items-center justify-between gap-2 text-[10.5px]">
                          <span
                            className="truncate"
                            style={{
                              color: i === 0 ? 'var(--gd-danger)' : 'var(--gd-ink-body)',
                              fontWeight: i === 0 ? 600 : 400
                            }}
                            title={r.reason}
                          >
                            {r.reason}
                          </span>
                          <span className="ops-num shrink-0 text-[var(--gd-ink-muted)]">
                            {r.count} 笔 · ¥{fmtMoney(r.amount)}
                          </span>
                        </div>
                        <div
                          className="h-1.5 overflow-hidden rounded-[1px]"
                          style={{ background: 'var(--gd-line-soft)' }}
                          role="img"
                          aria-label={`${r.reason} 占 ${Math.round(pct)}%`}
                        >
                          <div
                            className="h-full"
                            style={{
                              width: `${Math.max(2, pct)}%`,
                              background: i === 0 ? 'var(--gd-danger)' : 'rgba(120,119,116,.45)'
                            }}
                          />
                        </div>
                      </div>
                    );
                  })}
                  <p className="mt-auto text-[9px] leading-[1.5] text-[var(--gd-ink-muted)]">
                    最高占比 {Math.round(refundInsight.topShare * 100)}%
                    {!refundInsight.hasReason && ' · 均未填原因，去退款审核补录后可分类'}
                    {' · 点卡片进退款审核'}
                  </p>
                </div>
              )}
            </Card>
            )}
          </div>

          {/* ⑤ 事件流 */}
          <div className="p-4 pt-3">
            <Card
              title="事件流"
              meta={
                <button type="button" onClick={() => setEventsExpanded((v) => !v)} className="inline-flex items-center gap-1 cursor-pointer">
                  {eventsExpanded ? '收起' : '展开'}
                  {eventsExpanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                </button>
              }
            >
              <ul
                className="ops-scroll overflow-y-auto divide-y divide-[var(--gd-line-soft)]"
                /* 【2026-11-25 修】实测单行 33px。原来 collapse=clamp(96,12vh,132)=115px、展开 240px，
                   都会在底部切出半行。改为按行对齐：收起 4 行 132px，展开最多 7 行 231px。 */
                style={{ height: eventsExpanded ? 'min(32vh, 231px)' : '132px' }}
              >
                {booting && orders.length === 0 ? (
                  <>
                    <li className="px-3 py-1.5"><div className="ops-skeleton h-3 w-2/3" /></li>
                    <li className="px-3 py-1.5"><div className="ops-skeleton h-3 w-1/2" /></li>
                    <li className="px-3 py-1.5"><div className="ops-skeleton h-3 w-3/4" /></li>
                  </>
                ) : (
                <>
                {events.length === 0 && (
                  <li className="px-3 py-3 text-[10.5px] text-[var(--gd-ink-muted)]">暂无事件</li>
                )}
                {events.map((e) => {
                  const d = new Date(e.at);
                  const hhmmss = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(
                    d.getSeconds()
                  ).padStart(2, '0')}`;
                  const hhmm = hhmmss.slice(0, 5);
                  /* 【2026-11-25 修】事件流按 updatedAt 倒序取前 50 条，会跨天。
                     原来只渲染 HH:MM:SS，昨天的 17:10 排在今天 10:20 之后，读起来像时间倒流。
                     非今日事件补「昨 / MM-DD」前缀，鼠标悬停给完整时间。 */
                  const nowD = new Date(now);
                  const startToday = new Date(nowD.getFullYear(), nowD.getMonth(), nowD.getDate()).getTime();
                  const evDay = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
                  const dayDiff = Math.round((startToday - evDay) / 86400000);
                  const timeLabel =
                    dayDiff <= 0
                      ? hhmmss
                      : dayDiff === 1
                      ? `昨 ${hhmm}`
                      : `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${hhmm}`;
                  const fullTime = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
                    d.getDate()
                  ).padStart(2, '0')} ${hhmmss}`;
                  const tone =
                    e.tone === 'danger'
                      ? 'var(--gd-danger)'
                      : e.tone === 'warn'
                      ? 'var(--gd-amber)'
                      : e.tone === 'ok'
                      ? 'var(--gd-brand)'
                      : 'var(--gd-ink-body)';
                  return (
                    <li key={`${e.id}-${e.at}`} className="px-3 py-1.5 flex items-center gap-2">
                      <span
                        className="ops-num text-[10px] text-[var(--gd-ink-muted)] shrink-0 text-right"
                        style={{ width: dayDiff <= 0 ? 52 : 64 }}
                        title={fullTime}
                      >
                        {timeLabel}
                      </span>
                      <span className="w-1 h-1 rounded-full shrink-0" style={{ background: tone }} />
                      <span className="text-[10.5px] truncate" style={{ color: tone }} title={e.text}>
                        {e.text}
                      </span>
                    </li>
                  );
                })}
                </>
                )}
              </ul>
            </Card>
          </div>
        </div>

        {/* ④ 异常带 */}
        <AnomalyBand items={activeAnomalies} collapsed={bandCollapsed} onToggle={() => setBandCollapsed((v) => !v)} onJump={jump} booting={booting && orders.length === 0}
          onAck={(id) => { ackAnomaly(id); setAckBump((v) => v + 1); }}
          expandedIds={expandedIds}
          onToggleExpand={(id) => setExpandedIds((prev) => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; })}
          onExport={exportAnomaliesCsv}
          staffNames={local.staff.names}
          assignments={local.assignments}
          onAssign={(id, name) => { setAssignment(id, name); setAckBump((v) => v + 1); }}
          closedCount={closedToday}
          onCloseAnomaly={(id, reason, title, count) => {
            closeAnomaly(id, reason, title, count);
            setAckBump((v) => v + 1);
            showToast(`已关闭「${title}」（${reason === 'handled' ? '已处理' : '误报'}）`);
          }}
        />

      {/* 营收目标设置弹层（A1 的配置入口） */}
      {targetOpen && (
        <div className="fixed right-4 top-14 z-50 w-[220px] ops-card p-3" role="dialog" aria-label="设置营收目标">
          <div className="flex items-center justify-between mb-2">
            <span className="text-[11px] font-semibold text-[var(--gd-ink-strong)]">今日营收目标</span>
            <button
              type="button"
              onClick={() => setTargetOpen(false)}
              className="w-5 h-5 grid place-items-center rounded-[2px] cursor-pointer text-[var(--gd-ink-muted)] hover:text-[var(--gd-ink-strong)]"
              aria-label="关闭目标设置"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
          <input
            type="number"
            min={0}
            value={targetInput}
            onChange={(e) => setTargetInput(e.target.value)}
            placeholder="例如 8000"
            className="w-full h-7 px-2 border border-[var(--gd-line-main)] rounded-[2px] text-[11px] text-[var(--gd-ink-strong)] focus:outline-hidden focus:border-[var(--gd-brand)]"
            aria-label="目标金额"
          />
          <div className="flex gap-1.5 mt-2">
            <button type="button" onClick={saveTarget} className="ds-btn ds-btn--primary flex-1">保存</button>
            <button
              type="button"
              onClick={() => { try { localStorage.removeItem('obsidian_revenue_target_daily'); } catch { /* ignore */ } setTargetInput(''); setAckBump((v) => v + 1); setTargetOpen(false); }}
              className="ds-btn"
            >
              清除
            </button>
          </div>
          <p className="text-[9.5px] text-[var(--gd-ink-muted)] mt-2 leading-[1.5]">
            未配置时进度条按「对比昨日」口径显示
          </p>
        </div>
      )}

      {/* H5 自选显示：勾选要看的巨指标与图表（localStorage 持久化） */}
      {layoutOpen && (
        <div className="ops-card fixed right-4 top-14 z-50 w-[248px] p-3" role="dialog" aria-label="自选显示的指标">
          <div className="flex items-center justify-between mb-2">
            <span className="text-[11.5px] font-semibold text-[var(--gd-ink-strong)]">自选显示</span>
            <button
              type="button"
              onClick={() => setLayoutOpen(false)}
              className="w-5 h-5 grid place-items-center rounded-[2px] cursor-pointer text-[var(--gd-ink-muted)] hover:text-[var(--gd-ink-strong)]"
              aria-label="关闭自选显示"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>

          {(
            [
              ['kpi', '巨指标', KPI_LABELS],
              ['charts', '图表', CHART_LABELS]
            ] as const
          ).map(([group, groupLabel, labels]) => (
            <div key={group} className="mb-2 last:mb-0">
              <p className="text-[9.5px] uppercase tracking-wider text-[var(--gd-ink-muted)] mb-1">{groupLabel}</p>
              <div className="grid grid-cols-2 gap-1">
                {Object.entries(labels).map(([key, label]) => {
                  const on = layoutPrefs[group].includes(key);
                  const disabled = on && layoutPrefs[group].length === 1;
                  return (
                    <button
                      key={key}
                      type="button"
                      disabled={disabled}
                      onClick={() => toggleLayout(group, key)}
                      aria-pressed={on}
                      title={disabled ? '至少保留一项' : on ? `隐藏${label}` : `显示${label}`}
                      className="flex items-center gap-1.5 h-6 px-1.5 rounded-[2px] border text-[10px] transition-colors"
                      style={{
                        borderColor: on ? 'var(--gd-brand)' : 'var(--gd-line-main)',
                        background: on ? 'var(--gd-brand-soft, #eef3ef)' : 'transparent',
                        color: on ? 'var(--gd-brand)' : 'var(--gd-ink-muted)',
                        opacity: disabled ? 0.5 : 1,
                        cursor: disabled ? 'not-allowed' : 'pointer'
                      }}
                    >
                      <span
                        aria-hidden
                        className="w-2.5 h-2.5 grid place-items-center rounded-[1px] border"
                        style={{
                          borderColor: on ? 'var(--gd-brand)' : 'var(--gd-line-main)',
                          background: on ? 'var(--gd-brand)' : 'transparent',
                          color: '#fff',
                          fontSize: 8,
                          lineHeight: 1
                        }}
                      >
                        {on ? '✓' : ''}
                      </span>
                      <span className="truncate">{label}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}

          <p className="text-[9px] text-[var(--gd-ink-muted)] leading-[1.5] mt-2">至少保留一项，配置存本机，刷新不丢</p>
        </div>
      )}

      {/* 台位详情浮层：热区格子可点，避免"只能跳页"；fixed 定位不占布局 */}
      {inspectedTable && (
        <div
          className="ops-card fixed right-4 bottom-24 z-50 w-[248px] p-3"
          role="dialog"
          aria-label={`台位 ${inspectedTable.code} 详情`}
        >
          <div className="flex items-center justify-between mb-2">
            <span className="text-[12px] font-semibold text-[var(--gd-ink-strong)]">
              {inspectedTable.code} · {inspectedTable.zoneLabel || ZONE_LABEL[inspectedTable.zone] || inspectedTable.zone}
            </span>
            <button
              type="button"
              onClick={() => setInspectedTable(null)}
              className="w-6 h-6 grid place-items-center rounded-[2px] cursor-pointer text-[var(--gd-ink-muted)] hover:text-[var(--gd-ink-strong)]"
              aria-label="关闭台位详情"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>

          <dl className="space-y-1.5 m-0">
            {[
              ['状态', inspectedTable.status === 'dining' ? '在席' : inspectedTable.status === 'cleaning' ? '清台' : inspectedTable.status === 'reserved' ? '预留' : '空闲'],
              ['人数', `${inspectedTable.currentGuests || 0} / ${inspectedTable.capacity} 人`],
              ['时长', inspectedTable.elapsedMinutes ? `${inspectedTable.elapsedMinutes} 分钟` : '—'],
              ['金额', typeof inspectedTable.totalAmount === 'number' ? `¥${inspectedTable.totalAmount.toFixed(2)}` : '—'],
              ['订单', inspectedTable.orderNo || '—'],
              ['服务员', inspectedTable.serverName || '—']
            ].map(([k, v]) => (
              <div key={k} className="flex items-baseline justify-between gap-2">
                <dt className="text-[10px] text-[var(--gd-ink-muted)]">{k}</dt>
                <dd className="m-0 text-[10.5px] text-[var(--gd-ink-strong)] ops-num text-right truncate">{v}</dd>
              </div>
            ))}
          </dl>

          <button type="button" onClick={() => jump('tables')} className="ds-btn w-full mt-2.5">
            打开台位矩阵
          </button>
        </div>
      )}

      </div>
    </div>
  );
};

export default OpsDeckV2;
