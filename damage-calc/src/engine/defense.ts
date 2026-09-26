import type { EngineData } from './types';

export interface DefenseModifiers {
  defUp: number; // %
  defDown: number; // %
  defDownUnique: number; // %（Forfeit など下限 -60% まで下げられるもの）
}

/** 実効防御 = 基礎防御 × (1 + 防御UP − 防御DOWN − 特殊防御DOWN)。差し引きの下限は data/formula.json */
export function effectiveDefense(baseDef: number, m: DefenseModifiers, data: EngineData): { value: number; net: number } {
  const { floor, floorWithUnique } = data.formula.defense;
  const normalNet = Math.max((m.defUp - m.defDown) / 100, floor / 100);
  const net = Math.max(normalNet - m.defDownUnique / 100, floorWithUnique / 100);
  return { value: baseDef * (1 + net), net };
}
