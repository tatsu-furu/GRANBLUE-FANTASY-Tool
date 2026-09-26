import softcapsJson from '../../data/softcaps.json';
import framesJson from '../../data/frames.json';
import labelsJson from '../../data/labels.json';
import formulaJson from '../../data/formula.json';
import type { EngineData, FormulaData, FrameData, LabelData, SoftcapData } from './types';

// JSON 内の "_doc" など "_" で始まるキーは説明用なので取り除く
function stripDocs<T>(value: unknown): T {
  if (Array.isArray(value)) return value.map((v) => stripDocs(v)) as T;
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (!k.startsWith('_')) out[k] = stripDocs(v);
    }
    return out as T;
  }
  return value as T;
}

export const defaultData: EngineData = {
  softcaps: stripDocs<SoftcapData>(softcapsJson),
  frames: stripDocs<FrameData>(framesJson),
  labels: stripDocs<LabelData>(labelsJson),
  formula: stripDocs<FormulaData>(formulaJson),
};

// 乱数の候補（0.95, 0.96, ..., 1.05）。浮動小数の誤差を避けるため整数で数えてから割る
export function randomValues(data: EngineData): number[] {
  const { min, max, step } = data.formula.random;
  const n = Math.round((max - min) / step);
  const values: number[] = [];
  for (let i = 0; i <= n; i++) values.push(Math.round((min + i * step) * 1e6) / 1e6);
  return values;
}
