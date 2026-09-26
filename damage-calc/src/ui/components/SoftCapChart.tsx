import { useId, useMemo, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { softCap } from '../../engine/softcap';
import type { CapTable } from '../../engine/types';
import { fmtCompact, fmtInt, fmtPct } from '../format';

interface Props {
  table: CapTable;
  capUp: number; // 小数
  penetration: number; // 小数
  current: { x: number; y: number } | null; // 乱数1.00・クリティカルなしの減衰前→減衰後
  caption: string;
}

const W = 560;
const H = 308;
const M = { left: 60, right: 76, top: 14, bottom: 44 };
const PW = W - M.left - M.right;
const PH = H - M.top - M.bottom;
const N = 160;

/** 1, 2, 2.5, 5 × 10^k の切りのいい目盛り */
function niceTicks(max: number, count = 5): number[] {
  const raw = max / count;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * pow).find((s) => s >= raw) ?? raw;
  const ticks: number[] = [];
  for (let v = 0; v <= max + step * 1e-9; v += step) ticks.push(v);
  return ticks;
}

export function SoftCapChart({ table, capUp, penetration, current, caption }: Props) {
  const [view, setView] = useState<'chart' | 'table'>('chart');
  const [hover, setHover] = useState<number | null>(null);
  const clipId = useId();
  const scale = 1 + capUp;
  const lastT = (table.thresholds[table.thresholds.length - 1] ?? 1_000_000) * scale;

  const { xMax, yMax, xs, ys, xTicks, yTicks } = useMemo(() => {
    const xRaw = Math.max(lastT * 1.4, (current?.x ?? 0) * 1.1);
    const xTicksRaw = niceTicks(xRaw);
    const xMaxV = xTicksRaw[xTicksRaw.length - 1]!;
    const samples = Array.from({ length: N + 1 }, (_, i) => (xMaxV * i) / N);
    const yv = samples.map((x) => softCap(x, table, capUp, penetration));
    const yTicksRaw = niceTicks(Math.max(yv[N]! * 1.12, (current?.y ?? 0) * 1.12));
    return { xMax: xMaxV, yMax: yTicksRaw[yTicksRaw.length - 1]!, xs: samples, ys: yv, xTicks: xTicksRaw, yTicks: yTicksRaw };
  }, [table, capUp, penetration, lastT, current?.x, current?.y]);

  const sx = (x: number) => M.left + (x / xMax) * PW;
  const sy = (y: number) => M.top + PH - (y / yMax) * PH;

  // 折れ曲がりが丸まらないよう閾値の位置の点も入れる
  const curvePts = useMemo(() => {
    const pts = [...xs.map((x, i) => [x, ys[i]!] as const)];
    for (const t of table.thresholds) {
      const x = t * scale;
      if (x < xMax) pts.push([x, softCap(x, table, capUp, penetration)] as const);
    }
    return pts.sort((a, b) => a[0] - b[0]);
  }, [xs, ys, table, scale, xMax, capUp, penetration]);
  const curvePath = curvePts.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${sx(x).toFixed(1)},${sy(y).toFixed(1)}`).join('');
  const refEnd = Math.min(xMax, yMax);
  const refExitsTop = yMax < xMax;

  const onMove = (e: ReactPointerEvent<SVGRectElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    setHover(Math.round(frac * N));
  };
  const onKey = (e: KeyboardEvent<SVGSVGElement>) => {
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      const start = hover ?? (current ? Math.round((current.x / xMax) * N) : 0);
      setHover(Math.min(N, Math.max(0, start + (e.key === 'ArrowRight' ? 2 : -2))));
    } else if (e.key === 'Escape') {
      setHover(null);
    }
  };

  const hx = hover !== null ? xs[hover]! : null;
  const hy = hover !== null ? ys[hover]! : null;

  const segments = table.reductions.map((r, i) => {
    const lo = i === 0 ? 0 : table.thresholds[i - 1]! * scale;
    const hi = i < table.thresholds.length ? table.thresholds[i]! * scale : null;
    const eff = Math.max(0, 1 - (1 - r / 100) * (1 + penetration));
    return { lo, hi, eff, yAtHi: hi === null ? null : softCap(hi, table, capUp, penetration) };
  });

  return (
    <figure className="chart">
      <div className="chart-head">
        <figcaption>{caption}</figcaption>
        <button type="button" className="btn ghost small" onClick={() => setView(view === 'chart' ? 'table' : 'chart')}>
          {view === 'chart' ? '表で見る' : 'グラフで見る'}
        </button>
      </div>
      {view === 'chart' ? (
        <>
          <ul className="chart-legend">
            <li>
              <span className="line-key key-curve" aria-hidden="true" />
              減衰後（上限UP {fmtPct(capUp, 1)}・上限突破 {fmtPct(penetration, 1)}）
            </li>
            <li>
              <span className="line-key key-ref" aria-hidden="true" />
              減衰なし
            </li>
            {current ? (
              <li>
                <span className="dot-key" aria-hidden="true" />
                いまのダメージ
              </li>
            ) : null}
          </ul>
          <div className="chart-wrap">
            <svg
              viewBox={`0 0 ${W} ${H}`}
              role="img"
              aria-label={`${caption}。横軸が減衰前、縦軸が減衰後のダメージ`}
              tabIndex={0}
              onKeyDown={onKey}
              onBlur={() => setHover(null)}
            >
              <defs>
                <clipPath id={clipId}>
                  <rect x={M.left} y={M.top} width={PW} height={PH} />
                </clipPath>
              </defs>
              {yTicks.map((t) => (
                <g key={`y${t}`}>
                  <line className="grid" x1={M.left} x2={M.left + PW} y1={sy(t)} y2={sy(t)} />
                  <text className="tick" x={M.left - 8} y={sy(t)} dy="0.32em" textAnchor="end">
                    {fmtCompact(t)}
                  </text>
                </g>
              ))}
              {xTicks.map((t) => (
                <text key={`x${t}`} className="tick" x={sx(t)} y={M.top + PH + 18} textAnchor="middle">
                  {fmtCompact(t)}
                </text>
              ))}
              <line className="axis" x1={M.left} x2={M.left + PW} y1={M.top + PH} y2={M.top + PH} />
              <g clipPath={`url(#${clipId})`}>
                <line className="ref-line" x1={sx(0)} y1={sy(0)} x2={sx(refEnd)} y2={sy(refEnd)} />
                <path className="curve" d={curvePath} />
              </g>
              <text className="end-label" x={sx(xMax) + 6} y={sy(ys[N]!)} dy="0.32em">
                減衰後
              </text>
              <text
                className="end-label muted"
                x={refExitsTop ? sx(refEnd) - 4 : sx(xMax) + 6}
                y={refExitsTop ? M.top + 12 : sy(refEnd)}
                textAnchor={refExitsTop ? 'end' : 'start'}
                dy="0.32em"
              >
                減衰なし
              </text>
              {current && current.x <= xMax ? <circle className="point" cx={sx(current.x)} cy={sy(current.y)} r={5} /> : null}
              {hx !== null && hy !== null ? (
                <g className="crosshair" aria-hidden="true">
                  <line x1={sx(hx)} x2={sx(hx)} y1={M.top} y2={M.top + PH} />
                  <circle cx={sx(hx)} cy={sy(hy)} r={4} />
                </g>
              ) : null}
              <rect
                className="hit"
                x={M.left}
                y={M.top}
                width={PW}
                height={PH}
                onPointerMove={onMove}
                onPointerLeave={() => setHover(null)}
              />
              <text className="axis-title" x={M.left + PW / 2} y={H - 4} textAnchor="middle">
                減衰前ダメージ
              </text>
            </svg>
            {hx !== null && hy !== null ? (
              <div
                className="tooltip"
                style={{ left: `${(sx(hx) / W) * 100}%`, top: `${(M.top / H) * 100}%`, transform: sx(hx) > W * 0.6 ? 'translateX(calc(-100% - 10px))' : 'translateX(10px)' }}
                role="status"
              >
                <div className="tt-row">
                  <span className="line-key key-curve" aria-hidden="true" />
                  <strong>{fmtInt(hy)}</strong> 減衰後
                </div>
                <div className="tt-row">
                  <span className="line-key key-ref" aria-hidden="true" />
                  <strong>{fmtInt(hx)}</strong> 減衰前
                </div>
                <div className="tt-row muted">カット {hx > 0 ? fmtPct(1 - hy / hx, 1) : '0%'}</div>
              </div>
            ) : null}
          </div>
          {current ? (
            <p className="chart-note">
              いまのダメージ（乱数1.00・クリティカルなし）: 減衰前 {fmtInt(current.x)} → 減衰後 {fmtInt(current.y)}
              {current.x > xMax ? '（グラフの範囲外）' : ''}
            </p>
          ) : null}
        </>
      ) : (
        <table className="data">
          <thead>
            <tr>
              <th scope="col">区間</th>
              <th scope="col" className="num">減衰前ダメージ（上限UP込み）</th>
              <th scope="col" className="num">減衰率（上限突破込み）</th>
              <th scope="col" className="num">区間の終わりの減衰後</th>
            </tr>
          </thead>
          <tbody>
            {segments.map((s, i) => (
              <tr key={i}>
                <td>{i + 1}</td>
                <td className="tnum">
                  {fmtInt(s.lo)} 〜 {s.hi === null ? '' : fmtInt(s.hi)}
                </td>
                <td className="tnum">{fmtPct(s.eff, 1)}</td>
                <td className="tnum">{s.yAtHi === null ? '—' : fmtInt(s.yAtHi)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </figure>
  );
}
