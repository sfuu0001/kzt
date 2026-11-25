import React, { useEffect, useRef, useState } from 'react';

/* ============================================================================
 * 大屏基础件：滚动数字 / 迷你趋势线
 * ========================================================================== */

/* ---------------------------- 滚动数字 ---------------------------- */

interface RollingNumberProps {
  /** 已经格式化好的字符串，例如「12,480」「08:42」「63」 */
  value: string;
  className?: string;
  /** 是否禁用滚动（prefers-reduced-motion 时会由样式表统一降级） */
  animated?: boolean;
}

/**
 * 逐位滚动数字。
 *
 * 为什么不直接给整个数字做 transition：
 * 位数变化时（9,999 → 10,002）整体位移会让右侧出现空白，视觉上像抖动。
 * 这里每个字符占一个固定 1ch 的列，列内「旧值在上、新值在下」，
 * 变化时列内上移一屏，容器总宽度只由字符数决定，不会横向抖动。
 */
export const RollingNumber: React.FC<RollingNumberProps> = ({ value, className = '', animated = true }) => {
  const [prev, setPrev] = useState(value);
  const [anim, setAnim] = useState(false);
  const timer = useRef<number | null>(null);

  useEffect(() => {
    if (value === prev) return;

    // 位数变化时不做逐位滚动（新高位没有旧值可比），直接切换
    if (value.length !== prev.length || !animated) {
      setPrev(value);
      setAnim(false);
      return;
    }

    setAnim(true);
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      setPrev(value);
      setAnim(false);
    }, 340);

    return () => {
      if (timer.current) window.clearTimeout(timer.current);
    };
  }, [value, prev, animated]);

  const chars = value.split('');
  const prevChars = prev.split('');
  const isDigit = (c: string) => c >= '0' && c <= '9';

  return (
    <span className={`ops-num inline-flex items-baseline ${className}`} aria-label={value}>
      {chars.map((ch, i) => {
        if (!isDigit(ch)) {
          return (
            <span key={`s-${i}`} className="rn-static">
              {ch}
            </span>
          );
        }
        const old = prevChars[i] ?? ch;
        const changed = anim && old !== ch;
        return (
          <span key={`c-${i}`} className="rn-col" aria-hidden="true">
            <span className={`rn-stack ${changed ? 'rn-anim' : ''}`}>
              <span className="rn-cell">{old}</span>
              <span className="rn-cell">{ch}</span>
            </span>
          </span>
        );
      })}
    </span>
  );
};

/* ---------------------------- 迷你趋势线 ---------------------------- */

interface SparklineProps {
  data: number[];
  width?: number;
  height?: number;
  color?: string;
  /** 是否在末点画一个实心圆 */
  showDot?: boolean;
}

/** 40px 高的迷你趋势线，纯 SVG，无交互、无动画（更新即重绘，成本可忽略） */
export const Sparkline: React.FC<SparklineProps> = ({
  data,
  width = 160,
  height = 40,
  color = 'var(--gd-brand)',
  showDot = true
}) => {
  if (!data.length) {
    return <div style={{ width, height }} aria-hidden="true" />;
  }

  const max = Math.max(...data, 1);
  const min = Math.min(...data, 0);
  const span = max - min || 1;
  const stepX = data.length > 1 ? width / (data.length - 1) : width;

  const points = data.map((v, i) => {
    const x = i * stepX;
    // 顶部留 3px、底部留 3px，避免描边被裁掉
    const y = height - 3 - ((v - min) / span) * (height - 6);
    return [x, y] as const;
  });

  const d = points.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const last = points[points.length - 1];

  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true" className="overflow-visible">
      <path d={d} fill="none" stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      {showDot && <circle cx={last[0]} cy={last[1]} r="2" fill={color} />}
    </svg>
  );
};
