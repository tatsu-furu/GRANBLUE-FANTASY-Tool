import { describe, expect, it } from 'vitest';
import { defaultData } from './data';
import { applySkillExtraCap, capCurve, softCap } from './softcap';
import type { CapTable, SoftcapData } from './types';

const tables = defaultData.softcaps.tables;
const normal = tables.normal!;
const ca = tables.ca!;

describe('softCap: 通常攻撃（gbf.wiki Damage Cap の数値例）', () => {
  it('減衰前 600,000 → 445,000', () => {
    expect(softCap(600_000, normal, 0, 0)).toBeCloseTo(445_000, 6);
  });
  it('減衰前 1,000,000 → 約 449,000', () => {
    expect(softCap(1_000_000, normal, 0, 0)).toBeCloseTo(449_000, 6);
  });
  it('上限UP 20%: 減衰前 720,000 → 534,000', () => {
    expect(softCap(720_000, normal, 0.2, 0)).toBeCloseTo(534_000, 6);
  });
  it('上限UP 20%: 減衰前 1,000,000 → 約 536,800', () => {
    expect(softCap(1_000_000, normal, 0.2, 0)).toBeCloseTo(536_800, 6);
  });
  it('上限UP 20% + 上限突破 5%: 減衰前 720,000 → 542,700', () => {
    expect(softCap(720_000, normal, 0.2, 0.05)).toBeCloseTo(542_700, 6);
  });
});

describe('softCap: 奥義', () => {
  it('標準: 減衰前 2,500,000 → 1,685,000', () => {
    expect(softCap(2_500_000, ca, 0, 0)).toBeCloseTo(1_685_000, 6);
  });
  it('標準の実質上限は約168.5万', () => {
    expect(softCap(10_000_000, ca, 0, 0)).toBeCloseTo(1_685_000 + 7_500_000 * 0.01, 6);
  });
  it('5凸十天衆など: 減衰前 3,000,000 → 2,020,000', () => {
    expect(softCap(3_000_000, tables.ca_high!, 0, 0)).toBeCloseTo(2_020_000, 6);
  });
  it('アサシン系バフ中の通常攻撃: 減衰前 1,500,000 → 1,160,000', () => {
    expect(softCap(1_500_000, tables.normal_assassin!, 0, 0)).toBeCloseTo(1_160_000, 6);
  });
});

describe('softCap: アビ（gbf.wiki の例をプリセットにしたもの）', () => {
  for (const [key, preset] of Object.entries(defaultData.softcaps.skillPresets)) {
    const { thresholds, reductions, testCase } = preset;
    const ready = thresholds !== null && reductions !== null && testCase !== undefined;
    // 減衰表が data/softcaps.json に転記されるまではスキップ（開発環境から gbf.wiki を参照できなかったため）
    it.skipIf(!ready)(`${preset.name}（${key}）: ${testCase?.input} → ${testCase?.expected}`, () => {
      const table: CapTable = { thresholds: thresholds!, reductions: reductions! };
      expect(softCap(testCase!.input, table, 0, 0)).toBeCloseTo(testCase!.expected, 0);
    });
  }
});

describe('softCap: 性質', () => {
  it('最初の閾値までは減衰しない', () => {
    expect(softCap(299_999, normal, 0, 0)).toBe(299_999);
    expect(softCap(0, normal, 0, 0)).toBe(0);
  });
  it('単調非減少', () => {
    let prev = -1;
    for (let x = 0; x <= 3_000_000; x += 12_345) {
      const y = softCap(x, normal, 0.1, 0.02);
      expect(y).toBeGreaterThanOrEqual(prev);
      prev = y;
    }
  });
  it('上限突破で減衰率は0%未満にならない（最初の区間は倍率1のまま）', () => {
    expect(softCap(300_000, normal, 0, 0.5)).toBeCloseTo(300_000, 6);
  });
  it('上限UPは閾値すべてに掛かる', () => {
    expect(softCap(360_000, normal, 0.2, 0)).toBeCloseTo(360_000, 6);
    expect(softCap(480_000, normal, 0.2, 0)).toBeCloseTo(360_000 + 120_000 * 0.8, 6);
  });
});

describe('アビの追加減衰（倍率600%以下）', () => {
  const cfg: SoftcapData['skillExtraCap'] = {
    maxMultiplier: 600,
    cutBetween: 80,
    cutAbove: 99.9,
    scaleWithCapUp: true,
    verified: false,
    bands: [
      { maxMultiplier: 300, t1: 300_000, t2: 400_000 },
      { maxMultiplier: 600, t1: 500_000, t2: 600_000 },
    ],
  };
  it('閾値1以下はそのまま', () => {
    expect(applySkillExtraCap(450_000, 500, 0, cfg).value).toBe(450_000);
  });
  it('閾値1〜2 を 80% カット', () => {
    expect(applySkillExtraCap(550_000, 500, 0, cfg).value).toBeCloseTo(510_000, 6);
  });
  it('閾値2 以上を 99.9% カット', () => {
    expect(applySkillExtraCap(700_000, 500, 0, cfg).value).toBeCloseTo(500_000 + 100_000 * 0.2 + 100_000 * 0.001, 6);
  });
  it('倍率帯は倍率の小さい順に最初に当てはまるもの', () => {
    expect(applySkillExtraCap(350_000, 250, 0, cfg).value).toBeCloseTo(310_000, 6);
  });
  it('600% を超える技には掛からない', () => {
    const r = applySkillExtraCap(700_000, 601, 0, cfg);
    expect(r.value).toBe(700_000);
    expect(r.applied).toBe(false);
  });
  it('上限UPで閾値が上がる（scaleWithCapUp）', () => {
    expect(applySkillExtraCap(600_000, 500, 0.2, cfg).value).toBe(600_000);
  });
  it('倍率帯の表が空なら計算せず、未入力を知らせる', () => {
    const r = applySkillExtraCap(700_000, 500, 0, { ...cfg, bands: [] });
    expect(r.value).toBe(700_000);
    expect(r.missingData).toBe(true);
  });
});

describe('capCurve（減衰グラフ用）', () => {
  it('両端を含み、softCap と一致する点を返す', () => {
    const pts = capCurve(normal, 0, 0, 1_000_000, 10);
    expect(pts).toHaveLength(11);
    expect(pts[0]).toEqual({ x: 0, y: 0 });
    expect(pts[10]!.y).toBeCloseTo(449_000, 6);
  });
});
