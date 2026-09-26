// localStorage はプライベートウィンドウなどで使えないことがあるので、読み書きはすべて失敗しても動くようにする
import type { CalcInput } from '../engine/types';
import { sanitizeInput } from './sanitize';

const KEY_PRESETS = 'gbf-dmg:presets:v1';
const KEY_LAST = 'gbf-dmg:last:v1';
const KEY_THEME = 'gbf-dmg:theme';

export interface Preset {
  name: string;
  savedAt: string;
  input: CalcInput;
}

function read(key: string): unknown {
  try {
    const s = localStorage.getItem(key);
    return s ? (JSON.parse(s) as unknown) : null;
  } catch {
    return null;
  }
}

function write(key: string, value: unknown): boolean {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export function loadPresets(): Preset[] {
  const raw = read(KEY_PRESETS);
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((p: unknown) => {
    if (p === null || typeof p !== 'object') return [];
    const o = p as Record<string, unknown>;
    const input = sanitizeInput(o.input);
    if (!input || typeof o.name !== 'string') return [];
    return [{ name: o.name.slice(0, 60), savedAt: typeof o.savedAt === 'string' ? o.savedAt : '', input }];
  });
}

export function savePresets(presets: Preset[]): boolean {
  return write(KEY_PRESETS, presets);
}

export function loadLast(): CalcInput | null {
  return sanitizeInput(read(KEY_LAST));
}

export function saveLast(input: CalcInput): void {
  write(KEY_LAST, input);
}

export type ThemeChoice = 'auto' | 'dark' | 'light';

export function loadTheme(): ThemeChoice {
  const t = read(KEY_THEME);
  return t === 'dark' || t === 'light' ? t : 'auto';
}

export function saveTheme(t: ThemeChoice): void {
  write(KEY_THEME, t);
}
