import { describe, expect, it } from 'vitest';
import expected from '../../fixtures/panel-001.json';
import { defaultData } from '../engine/data';
import { assignLabels, matchHeader, matchLabel, rankLabels } from './match';
import { levenshtein, normalizeText, similarity, weightedSimilarity } from './normalize';
import { parseText, parseValue, segmentsOf } from './parse';

const labels = defaultData.labels;

describe('normalizeText', () => {
  it('NFKC（全角英数→半角）と空白除去、マイナス記号の統一', () => {
    expect(normalizeText('Ｍ攻刃　２９６％')).toBe('M攻刃296%');
    expect(normalizeText('EX攻刃（特殊）')).toBe('EX攻刃(特殊)');
    expect(normalizeText('−35%')).toBe('-35%');
  });
});

describe('levenshtein / similarity', () => {
  it('編集距離', () => {
    expect(levenshtein('攻刃', 'M攻刃')).toBe(1);
    expect(levenshtein('kitten', 'sitting')).toBe(3);
  });
  it('正規化類似度 = 1 − 距離 / 長い方の長さ', () => {
    expect(similarity('攻刃', 'M攻刃')).toBeCloseTo(2 / 3, 12);
    expect(similarity('abc', 'abc')).toBe(1);
  });
});

describe('weightedSimilarity（OCR の信頼度で重み付け）', () => {
  const w = (s: string, conf = 100) => [...s].map((ch) => ({ ch, conf }));
  it('信頼度100だけなら通常の類似度と同じ', () => {
    expect(weightedSimilarity(w('攻刃'), 'M攻刃')).toBeCloseTo(similarity('攻刃', 'M攻刃'), 12);
  });
  it('信頼度の低い文字の読み違いは安く置換できる', () => {
    const text = [{ ch: '攻', conf: 92 }, { ch: '丸', conf: 0 }];
    expect(weightedSimilarity(text, '攻刃')).toBeCloseTo(1 - 0.15 / 2, 12);
    expect(similarity('攻丸', '攻刃')).toBe(0.5);
  });
});

describe('assignLabels（パネル全体で一括割り当て）', () => {
  const lowConf = (s: string) => [...s].map((ch, i) => ({ ch, conf: i === 0 ? 95 : 0 }));
  it('値の単位・範囲が合う項目を優先する', () => {
    // 「M??」296%: M与ダメ（0〜100%）は範囲外なので M攻刃
    const r = assignLabels([rankLabels(lowConf('MEH'), { value: 296, unit: '%' }, labels)], labels.matchThreshold);
    expect(r[0]!.id).not.toBe('magna_amp');
  });
  it('割り当て済みの項目は他のセルで下げる（同じ項目は普通1回）', () => {
    const cands = [
      rankLabels([...'M渾身'].map((ch) => ({ ch, conf: 100 })), { value: 72.31, unit: '%' }, labels),
      rankLabels(lowConf('M渾刃'), { value: 296, unit: '%' }, labels),
    ];
    const r = assignLabels(cands, labels.matchThreshold);
    expect(r[0]!.id).toBe('magna_stamina');
    expect(r[1]!.id).toBe('magna_might');
  });
});

describe('parseValue', () => {
  const cases: Array<[string, number, '%' | 'flat']> = [
    ['+50000', 50_000, 'flat'],
    ['72.31%', 72.31, '%'],
    ['-35%', -35, '%'],
    ['−35%', -35, '%'],
    ['５４％', 54, '%'],
    ['1,243,337', 1_243_337, 'flat'],
    ['847，974', 847_974, 'flat'],
    [' 296 % ', 296, '%'],
    ['2O%', 20, '%'],
    ['l0%', 10, '%'],
  ];
  for (const [raw, value, unit] of cases) {
    it(`${JSON.stringify(raw)} → ${value}${unit === '%' ? '%' : ''}`, () => {
      expect(parseValue(raw)).toEqual({ value, unit });
    });
  }
  it('数値でなければ null', () => {
    expect(parseValue('攻刃')).toBeNull();
    expect(parseValue('')).toBeNull();
    expect(parseValue('12.3.4%')).toBeNull();
  });
});

describe('segmentsOf（ラベルと数値の切り分け）', () => {
  const texts = (s: string) => segmentsOf({ text: s }).map((x) => `${x.numeric ? '#' : ''}${x.text}`);
  it('ラベルと値がくっついていても分ける', () => {
    expect(texts('攻刃54%')).toEqual(['攻刃', '#54%']);
    expect(texts('DA確率15%TA確率10%')).toEqual(['DA確率', '#15%', 'TA確率', '#10%']);
    expect(texts('与ダメージ+50000')).toEqual(['与ダメージ', '#+50000']);
    expect(texts('奥義ゲージ上昇量-35%')).toEqual(['奥義ゲージ上昇量', '#-35%']);
  });
  it('矩形は文字数の比で分ける', () => {
    const segs = segmentsOf({ text: '攻刃54%', bbox: { x: 0, y: 0, w: 50, h: 10 }, conf: 90 });
    expect(segs[0]!.bbox).toEqual({ x: 0, y: 0, w: 20, h: 10 });
    expect(segs[1]!.bbox).toEqual({ x: 20, y: 0, w: 30, h: 10 });
  });
});

describe('matchLabel（辞書照合）', () => {
  it('完全一致は類似度1', () => {
    expect(matchLabel('M攻刃', labels)).toMatchObject({ id: 'magna_might', score: 1 });
    expect(matchLabel('攻刃', labels)).toMatchObject({ id: 'normal_might', score: 1 });
    expect(matchLabel('奥義D', labels)).toMatchObject({ id: 'ca_dmg', score: 1 });
    expect(matchLabel('奥義D上限', labels)).toMatchObject({ id: 'cap_up_ca', score: 1 });
  });
  it('全角や括弧の違いは正規化で吸収', () => {
    expect(matchLabel('ＥＸ攻刃（特殊）', labels)).toMatchObject({ id: 'ex_might_special', score: 1 });
  });
  it('1文字の誤認識は拾う', () => {
    expect(matchLabel('対有利与ダ×', labels).id).toBe('adv_amp');
    expect(matchLabel('アビD上隈', labels).id).toBe('cap_up_skill');
  });
  it('類似度 0.6 未満は未分類', () => {
    expect(matchLabel('謎の方陣スキル', labels).id).toBeNull();
  });
});

describe('matchHeader', () => {
  it('ヘッダ項目を見分ける（対○属性を先に判定）', () => {
    expect(matchHeader('対土属性予測ダメージ', labels)).toBe('estimateVs');
    expect(matchHeader('予測ダメージ', labels)).toBe('estimatePlain');
    expect(matchHeader('最大HP', labels)).toBe('maxHp');
    expect(matchHeader('風属性スキルエンハンス', labels)).toBe('enhance');
    expect(matchHeader('発動中の武器スキル', labels)).toBe('gridHeading');
    expect(matchHeader('HP', labels)).toBeNull();
    expect(matchHeader('予測ダメ一ジ', labels)).toBe('estimatePlain');
  });
});

// パネルを2列のテキストにしたもの（iOS のテキスト認識などで貼り付けた想定）
const PANEL_TEXT = `予測ダメージ 847,974
対土属性予測ダメージ 1,243,337
最大HP 60,644
風属性スキルエンハンス 20% 280% 0%
発動中の武器スキル
攻刃 54%　M攻刃 296%
EX攻刃 56%　EX攻刃(特殊) 40%
M渾身 72.31%　DA確率 15%
TA確率 10%　嵐竜方陣 60%
HP 145%　防御 25%
D上限 20%　M与ダメ 7.6%
対有利与ダメ 25%　通常D上限 10%
アビD上限 91.8%　奥義D 10%
奥義D上限 5%　与ダメージ +50000
アビ与ダメ +190000　奥義ゲージ上昇量 -35%`;

describe('parseText（テキスト貼り付け経路。画像 OCR と同じパーサ）', () => {
  const r = parseText(PANEL_TEXT, labels);
  it('ヘッダ（予測ダメージ・対属性・最大HP・属性・エンハンス）', () => {
    expect(r.panel.estimate).toEqual(expected.estimate);
    expect(r.panel.maxHp).toBe(expected.maxHp);
    expect(r.panel.element).toBe('wind');
    expect(r.panel.enhance).toEqual(expected.enhance);
  });
  it('20項目すべてのラベルと値が期待値と一致', () => {
    const got = Object.fromEntries(
      r.panel.skills.map((s) => [labels.labels.find((l) => l.id === s.labelId)?.name ?? `?${s.labelRaw}`, s.value]),
    );
    expect(got).toEqual(expected.skills);
    expect(r.panel.skills).toHaveLength(20);
  });
  it('単位と範囲の検証（与ダメージは固定値、奥義ゲージは符号を保持）', () => {
    const find = (id: string) => r.panel.skills.find((s) => s.labelId === id)!;
    expect(find('supp').unit).toBe('flat');
    expect(find('ca_gauge').value).toBe(-35);
    expect(r.meta.every((m) => m.flags.length === 0)).toBe(true);
  });
  it('ラベルと値が別の行でも組にする（縦に並んだテキスト）', () => {
    const v = parseText('攻刃\n54%\nM攻刃\n296%', labels);
    expect(v.panel.skills.map((s) => [s.labelId, s.value])).toEqual([
      ['normal_might', 54],
      ['magna_might', 296],
    ]);
  });
  it('エンハンスが「通常 20% M 280% K 0%」の形でも読める', () => {
    const v = parseText('光属性スキルエンハンス\n通常 20% M 280% K 0%', labels);
    expect(v.panel.element).toBe('light');
    expect(v.panel.enhance).toEqual({ normal: 20, magna: 280, k: 0 });
    expect(v.panel.skills).toHaveLength(0);
  });
  it('単位の食い違い・範囲外は要確認フラグ', () => {
    const v = parseText('攻刃 54\nDA確率 150%', labels);
    expect(v.meta[0]!.flags).toContain('unit');
    expect(v.meta[1]!.flags).toContain('range');
  });
  it('同じラベルが2回読めたら信頼度の高い方を採用し、低い方は無視にして両方残す', () => {
    const v = parseText('M攻刃 296%\nM攻刃 29%', labels);
    expect(v.panel.skills).toHaveLength(2);
    expect(v.panel.skills.filter((s) => !s.ignored)).toHaveLength(1);
    expect(v.meta.every((m) => m.flags.includes('duplicate'))).toBe(true);
  });
  it('辞書に無い項目は未分類（labelId: null）として残す', () => {
    const v = parseText('謎の方陣スキル 12%', labels);
    expect(v.panel.skills[0]).toMatchObject({ labelId: null, labelRaw: '謎の方陣スキル', value: 12 });
  });
});
