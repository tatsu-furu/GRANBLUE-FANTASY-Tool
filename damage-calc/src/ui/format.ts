const intFmt = new Intl.NumberFormat('ja-JP', { maximumFractionDigits: 0 });

/** 3桁区切り。表示のときだけ切り捨てる（浮動小数の誤差で1少なくならないよう少し足す） */
export function fmtInt(x: number): string {
  return Number.isFinite(x) ? intFmt.format(Math.floor(x + 1e-6)) : '—';
}

/** 小数（0.2）を % 表記（20%）に */
export function fmtPct(x: number, digits = 1): string {
  return Number.isFinite(x) ? `${(x * 100).toFixed(digits)}%` : '—';
}

export function fmtSignedPct(x: number, digits = 2): string {
  if (!Number.isFinite(x)) return '—';
  const v = (x * 100).toFixed(digits);
  return x > 0 ? `+${v}%` : `${v}%`;
}

export function fmtMult(x: number): string {
  return Number.isFinite(x) ? `×${x.toFixed(3)}` : '—';
}

/** グラフの目盛り用（50万、1.2億 など） */
export function fmtCompact(x: number): string {
  if (x >= 1e8) return `${+(x / 1e8).toFixed(2)}億`;
  if (x >= 1e4) return `${+(x / 1e4).toFixed(1)}万`;
  return intFmt.format(x);
}

/** 入力欄に表示する数値（最大4桁の小数） */
export function fmtInput(x: number): string {
  return Number.isFinite(x) ? String(Math.round(x * 1e4) / 1e4) : '';
}
