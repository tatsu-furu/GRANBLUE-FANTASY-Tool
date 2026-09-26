import { useEffect, useState, type ReactNode } from 'react';
import { defaultData } from '../../engine/data';
import { fmtInput } from '../format';

/** 全角数字・カンマ入りも受け付ける */
export function parseNumber(text: string): number | null {
  const s = text.normalize('NFKC').replace(/[,\s]/g, '').replace(/[−–—]/g, '-');
  if (s === '' || s === '-' || s === '.' || s === '-.') return null;
  const v = Number(s);
  return Number.isFinite(v) ? v : null;
}

interface NumInputProps {
  value: number | null | undefined;
  onChange: (v: number | null) => void;
  label: string; // aria-label（画面上のラベルと同じ文言）
  placeholder?: string;
  className?: string;
  size?: 'xs' | 's' | 'm' | 'l';
}

/** 入力途中（空欄や「-」）を許す数値入力。確定値だけを onChange に渡す */
export function NumInput({ value, onChange, label, placeholder, className, size = 'm' }: NumInputProps) {
  const [text, setText] = useState(value === null || value === undefined ? '' : fmtInput(value));
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (!focused) setText(value === null || value === undefined ? '' : fmtInput(value));
  }, [value, focused]);
  return (
    <input
      type="text"
      inputMode="decimal"
      aria-label={label}
      className={`num num-${size} ${className ?? ''}`}
      value={text}
      placeholder={placeholder}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      onChange={(e) => {
        setText(e.target.value);
        onChange(parseNumber(e.target.value));
      }}
    />
  );
}

export function Panel({ id, step, title, children, actions }: { id: string; step: string; title: string; children: ReactNode; actions?: ReactNode }) {
  return (
    <section className="panel" id={id} aria-labelledby={`${id}-title`}>
      <header className="panel-head">
        <h2 id={`${id}-title`}>
          <span className="step" aria-hidden="true">
            {step}
          </span>
          {title}
        </h2>
        {actions ? <div className="panel-actions">{actions}</div> : null}
      </header>
      {children}
    </section>
  );
}

export type ConfLevel = 'high' | 'mid' | 'low';

export function confLevel(c: number): ConfLevel {
  const { high, mid } = defaultData.labels.confidenceLevels;
  return c >= high ? 'high' : c >= mid ? 'mid' : 'low';
}

const CONF_LABEL: Record<ConfLevel, string> = { high: '高', mid: '中', low: '低' };

/** 信頼度は色だけでなく文字でも示す */
export function ConfBadge({ value }: { value: number }) {
  const lv = confLevel(value);
  return (
    <span className={`conf conf-${lv}`} title={`OCR の信頼度 ${(value * 100).toFixed(0)}%`}>
      {lv === 'high' ? '' : '⚠ '}
      {CONF_LABEL[lv]}
    </span>
  );
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <div className="segmented" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          className={value === o.value ? 'on' : ''}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Warnings({ items }: { items: string[] }) {
  if (items.length === 0) return null;
  return (
    <ul className="warnings">
      {items.map((w) => (
        <li key={w}>
          <span aria-hidden="true">⚠</span> {w}
        </li>
      ))}
    </ul>
  );
}
