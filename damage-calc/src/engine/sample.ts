import type { Element, LabelData, PanelSkill, PanelValues } from './types';

/** fixtures/panel-*.json の形式（期待値） */
export interface ExpectedPanel {
  estimate?: { plain: number; vsElement?: { element: string; value: number } };
  maxHp?: number;
  element?: string;
  enhance: { normal: number; magna: number; k: number };
  skills: Record<string, number>;
  baseAtk?: number | null;
}

const ELEMENTS: readonly Element[] = ['fire', 'water', 'earth', 'wind', 'light', 'dark'];
const asElement = (e: string | undefined): Element | undefined =>
  ELEMENTS.find((x) => x === e);

/** 期待値 JSON をパネル値に変換する（表示名・aliases の完全一致で辞書を引く）。サンプル読み込みとテストで使う */
export function panelFromExpected(expected: ExpectedPanel, labels: LabelData): PanelValues {
  const skills: PanelSkill[] = Object.entries(expected.skills).map(([name, value]) => {
    const def = labels.labels.find((l) => l.name === name || l.aliases.includes(name));
    return {
      labelRaw: name,
      labelId: def?.id ?? null,
      value,
      unit: def?.unit ?? '%',
      confidence: 1,
    };
  });
  const vs = expected.estimate?.vsElement;
  const vsElement = asElement(vs?.element);
  const element = asElement(expected.element);
  return {
    ...(expected.estimate
      ? {
          estimate: {
            plain: expected.estimate.plain,
            ...(vs && vsElement ? { vsElement: { element: vsElement, value: vs.value } } : {}),
          },
        }
      : {}),
    ...(expected.maxHp !== undefined ? { maxHp: expected.maxHp } : {}),
    ...(element ? { element } : {}),
    enhance: { ...expected.enhance },
    skills,
  };
}
