import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { RevenuePoint } from './useOpsDeckData';

/* ============================================================================
 * 营收曲线（Canvas）
 * ----------------------------------------------------------------------------
 * 设计稿 §5.3 / §6.4：
 *   · 5 分钟桶柱状（金额）+ 累计折线
 *   · 网格只保留 3 条水平线（0 / 50% / 100%），虚线 2/2
 *   · 柱宽 = 桶宽 × 0.6，最小 3px，圆角 1px
 *   · 增量绘制：只在窗口滑动时重绘尾部，整帧重绘仅发生在 resize / 数据窗口变化
 *
 * 为什么用 Canvas 而不是 SVG：96 根柱 + 折线 = 200+ 节点，
 * 在 5s 节奏下频繁更新会产生大量 DOM diff；Canvas 一次 drawImage 级别开销。
 * ========================================================================== */

interface RevenueChartProps {
  points: RevenuePoint[];
  /** A2：昨日同时段累计曲线（与 points 等长、同一时间轴），可选 */
  prevPoints?: RevenuePoint[];
  /** 是否显示昨日对比层（用户可关） */
  showPrev?: boolean;
  height?: number;
}

const PADDING = { top: 12, right: 34, bottom: 20, left: 44 };

export const RevenueChart: React.FC<RevenueChartProps> = ({
  points,
  prevPoints,
  showPrev = true,
  height = 320
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ w: 640, h: height });
  const [hover, setHover] = useState<{ idx: number; x: number; y: number } | null>(null);

  // 尺寸跟随容器（ResizeObserver），避免窗口变化后 canvas 拉伸模糊
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const cr = entries[0]?.contentRect;
      if (cr) setSize({ w: Math.max(240, cr.width), h: height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [height]);

  const { maxAmount, maxCum } = useMemo(() => {
    let ma = 1;
    let mc = 1;
    for (const p of points) {
      if (p.amount > ma) ma = p.amount;
      if (p.cum > mc) mc = p.cum;
    }
    // 昨日层必须参与取最大值，否则虚线会冲出画布顶部
    if (showPrev && prevPoints) {
      for (const p of prevPoints) {
        if (p.cum > mc) mc = p.cum;
        if (p.amount > ma) ma = p.amount;
      }
    }
    return { maxAmount: ma, maxCum: mc };
  }, [points, prevPoints, showPrev]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = size.w;
    const h = size.h;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const plotW = w - PADDING.left - PADDING.right;
    const plotH = h - PADDING.top - PADDING.bottom;

    const styles = getComputedStyle(canvas);
    const lineSoft = styles.getPropertyValue('--gd-line-soft') || '#efefed';
    const inkMuted = styles.getPropertyValue('--gd-ink-muted') || '#787774';
    const brand = styles.getPropertyValue('--gd-brand') || '#2b593f';

    // ---- 网格：只画 3 条 ----
    ctx.save();
    ctx.strokeStyle = lineSoft;
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 2]);
    for (const ratio of [0, 0.5, 1]) {
      const y = PADDING.top + plotH * (1 - ratio);
      ctx.beginPath();
      ctx.moveTo(PADDING.left, y);
      ctx.lineTo(PADDING.left + plotW, y);
      ctx.stroke();
    }
    ctx.restore();

    // ---- Y 轴刻度 ----
    ctx.fillStyle = inkMuted;
    ctx.font = '9.5px -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (const ratio of [0, 0.5, 1]) {
      const y = PADDING.top + plotH * (1 - ratio);
      const v = maxAmount * ratio;
      ctx.fillText(`¥${v >= 1000 ? `${(v / 1000).toFixed(1)}k` : v.toFixed(0)}`, PADDING.left - 6, y);
    }

    // ---- 柱状 ----
    const n = points.length || 1;
    const slot = plotW / n;
    const barW = Math.max(3, slot * 0.6);
    ctx.fillStyle = 'rgba(43, 89, 63, 0.18)';
    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      const bh = (p.amount / maxAmount) * plotH;
      if (bh <= 0.5) continue;
      const x = PADDING.left + i * slot + (slot - barW) / 2;
      const y = PADDING.top + plotH - bh;
      const r = 1;
      ctx.beginPath();
      ctx.moveTo(x, y + r);
      ctx.arcTo(x, y, x + r, y, r);
      ctx.lineTo(x + barW - r, y);
      ctx.arcTo(x + barW, y, x + barW, y + r, r);
      ctx.lineTo(x + barW, y + bh);
      ctx.lineTo(x, y + bh);
      ctx.closePath();
      ctx.fill();
    }

    // ---- 昨日同时段累计（A2）：虚线、先画，避免盖住今日实线 ----
    const hasPrev = showPrev && !!prevPoints && prevPoints.length === points.length && points.length > 1;
    if (hasPrev) {
      ctx.save();
      ctx.strokeStyle = 'rgba(120, 119, 116, 0.5)';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 3]);
      ctx.lineJoin = 'round';
      ctx.beginPath();
      prevPoints.forEach((p, i) => {
        const x = PADDING.left + i * slot + slot / 2;
        const y = PADDING.top + plotH - (p.cum / maxCum) * plotH;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();
      ctx.restore();
    }

    // ---- 累计折线 ----
    ctx.save();
    ctx.strokeStyle = brand;
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.beginPath();
    points.forEach((p, i) => {
      const x = PADDING.left + i * slot + slot / 2;
      const y = PADDING.top + plotH - (p.cum / maxCum) * plotH;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
    ctx.restore();

    // ---- 右轴：累计金额（双系列必须各自标轴，否则读者会读错）----
    ctx.save();
    ctx.fillStyle = inkMuted;
    ctx.font = '9.5px -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    for (const ratio of [0, 0.5, 1]) {
      const y = PADDING.top + plotH * (1 - ratio);
      const v = maxCum * ratio;
      ctx.fillText(v >= 1000 ? `${(v / 1000).toFixed(1)}k` : v.toFixed(0), PADDING.left + plotW + 6, y);
    }
    ctx.fillText('累计', PADDING.left + plotW + 6, PADDING.top - 6);
    ctx.restore();

    // ---- X 轴时间标签（首/中/尾）----
    if (points.length > 1) {
      const labelIdx = [0, Math.floor(points.length / 2), points.length - 1];
      ctx.fillStyle = inkMuted;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      for (const i of labelIdx) {
        const d = new Date(points[i].t);
        const label = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
        const x = PADDING.left + i * slot + slot / 2;
        ctx.fillText(label, Math.min(w - 18, Math.max(18, x)), h - PADDING.bottom + 6);
      }
    }
  }, [points, prevPoints, showPrev, size, maxAmount, maxCum]);

  // ---- 悬停十字线 ----
  const onMove = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const plotW = size.w - PADDING.left - PADDING.right;
    const n = points.length || 1;
    const idx = Math.min(n - 1, Math.max(0, Math.floor((x - PADDING.left) / (plotW / n))));
    setHover({ idx, x, y: e.clientY - rect.top });
  };

  const hoverPoint = hover ? points[hover.idx] : null;
  const prevSeries =
    showPrev && prevPoints && prevPoints.length === points.length && points.length > 1 ? prevPoints : null;
  const hoverPrev = hover && prevSeries ? prevSeries[hover.idx] : null;

  return (
    <div
      ref={wrapRef}
      className="relative w-full"
      style={{ height }}
      onMouseMove={onMove}
      onMouseLeave={() => setHover(null)}
    >
      <canvas
        ref={canvasRef}
        className="block"
        role="img"
        aria-label={`近 8 小时营收趋势：柱状为每 5 分钟金额，实线为今日累计，当前累计约 ${Math.round(
          points[points.length - 1]?.cum || 0
        )} 元${prevSeries ? `，虚线为昨日同时段累计约 ${Math.round(prevSeries[prevSeries.length - 1]?.cum || 0)} 元` : ''}`}
      />
      {hover && hoverPoint && (
        <div
          className="pointer-events-none absolute z-10 rounded-[2px] border px-2 py-1 text-[10.5px] leading-[1.5]"
          style={{
            left: Math.min(size.w - 130, Math.max(8, hover.x + 12)),
            top: Math.max(8, hover.y - 48),
            borderColor: 'var(--gd-line-main)',
            background: '#fff',
            color: 'var(--gd-ink-body)'
          }}
        >
          <div className="ops-num" style={{ color: 'var(--gd-ink-strong)' }}>
            ¥{hoverPoint.amount.toFixed(0)} / 5min
          </div>
          <div className="ops-num" style={{ color: 'var(--gd-ink-muted)' }}>
            今日累计 ¥{hoverPoint.cum.toFixed(0)}
          </div>
          {hoverPrev && (
            <div className="ops-num" style={{ color: 'var(--gd-ink-muted)', opacity: 0.75 }}>
              昨日同时段 ¥{hoverPrev.cum.toFixed(0)}
            </div>
          )}
        </div>
      )}
    </div>
  );
};
