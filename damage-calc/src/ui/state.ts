import type { CalibrationResult, CalibrationSample, MultiHypothesisResult, UnknownKey } from '../engine/calibrate';
import { defaultInput, emptyPanel } from '../engine/defaults';
import type {
  Assumptions,
  AttackSpec,
  CalcInput,
  CharacterInput,
  EnemyInput,
  Modifier,
  PanelSkill,
  PanelValues,
} from '../engine/types';
import type { CellMeta, ParseResult } from '../ocr/parse';
import type { Rect } from '../ocr/types';

export interface OcrView {
  status: 'idle' | 'running' | 'done' | 'error';
  progress: number;
  message: string;
  imageUrl: string | null;
  imageSize: { w: number; h: number } | null;
  meta: (CellMeta | null)[]; // input.panel.skills と同じ順番
  header: ParseResult['header'];
  unmatched: ParseResult['unmatched'];
  info: string | null;
  error: string | null;
  crop: Rect | null;
}

export interface CalibView {
  unknownKey: UnknownKey;
  search: CalibrationResult[] | null;
  samples: CalibrationSample[];
  multi: MultiHypothesisResult[] | null;
}

export interface AppState {
  input: CalcInput;
  ocr: OcrView;
  calib: CalibView;
}

export interface ParsedPanel {
  panel: PanelValues;
  meta: (CellMeta | null)[];
  header: ParseResult['header'];
  unmatched: ParseResult['unmatched'];
  info: string | null;
}

export type Action =
  | { type: 'loadInput'; input: CalcInput }
  | { type: 'patchCharacter'; patch: Partial<CharacterInput> }
  | { type: 'patchEnemy'; patch: Partial<EnemyInput> }
  | { type: 'patchAssumptions'; patch: Partial<Assumptions> }
  | { type: 'patchPanel'; patch: Partial<Omit<PanelValues, 'skills'>> }
  | { type: 'updateSkill'; index: number; patch: Partial<PanelSkill> }
  | { type: 'addSkill'; skill: PanelSkill }
  | { type: 'removeSkill'; index: number }
  | { type: 'clearPanel' }
  | { type: 'addBuff'; buff: Modifier }
  | { type: 'updateBuff'; id: string; patch: Partial<Modifier> }
  | { type: 'removeBuff'; id: string }
  | { type: 'updateAttack'; id: string; patch: Partial<AttackSpec> }
  | { type: 'addAttack'; attack: AttackSpec }
  | { type: 'removeAttack'; id: string }
  | { type: 'ocrImage'; imageUrl: string; size: { w: number; h: number } }
  | { type: 'ocrStart' }
  | { type: 'ocrProgress'; progress: number; message: string }
  | { type: 'ocrDone'; parsed: ParsedPanel }
  | { type: 'ocrError'; error: string }
  | { type: 'setCrop'; crop: Rect | null }
  | { type: 'calibUnknown'; key: UnknownKey }
  | { type: 'calibSearch'; results: CalibrationResult[] | null }
  | { type: 'calibAddSample'; sample: CalibrationSample }
  | { type: 'calibRemoveSample'; id: string }
  | { type: 'calibMulti'; results: MultiHypothesisResult[] | null };

export const idleOcr = (): OcrView => ({
  status: 'idle',
  progress: 0,
  message: '',
  imageUrl: null,
  imageSize: null,
  meta: [],
  header: {},
  unmatched: [],
  info: null,
  error: null,
  crop: null,
});

export function initialState(input: CalcInput = defaultInput()): AppState {
  return {
    input,
    ocr: idleOcr(),
    calib: { unknownKey: 'baseAtk', search: null, samples: [], multi: null },
  };
}

const setInput = (s: AppState, input: CalcInput): AppState => ({ ...s, input, calib: { ...s.calib, search: null } });

export function reducer(s: AppState, a: Action): AppState {
  const input = s.input;
  switch (a.type) {
    case 'loadInput':
      // 読み込んだ入力は別のスクショ由来なので、表示中の画像と OCR の情報は外す
      return { ...s, input: a.input, ocr: idleOcr(), calib: { ...s.calib, search: null } };
    case 'patchCharacter':
      return setInput(s, { ...input, character: { ...input.character, ...a.patch } });
    case 'patchEnemy':
      return setInput(s, { ...input, enemy: { ...input.enemy, ...a.patch } });
    case 'patchAssumptions':
      return { ...s, input: { ...input, assumptions: { ...input.assumptions, ...a.patch } } };
    case 'patchPanel':
      return setInput(s, { ...input, panel: { ...input.panel, ...a.patch } });
    case 'updateSkill':
      return setInput(s, {
        ...input,
        panel: { ...input.panel, skills: input.panel.skills.map((sk, i) => (i === a.index ? { ...sk, ...a.patch } : sk)) },
      });
    case 'addSkill':
      return {
        ...setInput(s, { ...input, panel: { ...input.panel, skills: [...input.panel.skills, a.skill] } }),
        ocr: { ...s.ocr, meta: [...padMeta(s), null] },
      };
    case 'removeSkill':
      return {
        ...setInput(s, { ...input, panel: { ...input.panel, skills: input.panel.skills.filter((_, i) => i !== a.index) } }),
        ocr: { ...s.ocr, meta: padMeta(s).filter((_, i) => i !== a.index) },
      };
    case 'clearPanel':
      return { ...setInput(s, { ...input, panel: emptyPanel() }), ocr: idleOcr() };
    case 'addBuff':
      return setInput(s, { ...input, buffs: [...input.buffs, a.buff] });
    case 'updateBuff':
      return setInput(s, { ...input, buffs: input.buffs.map((b) => (b.id === a.id ? { ...b, ...a.patch } : b)) });
    case 'removeBuff':
      return setInput(s, { ...input, buffs: input.buffs.filter((b) => b.id !== a.id) });
    case 'updateAttack':
      return setInput(s, { ...input, attacks: input.attacks.map((x) => (x.id === a.id ? { ...x, ...a.patch } : x)) });
    case 'addAttack':
      return setInput(s, { ...input, attacks: [...input.attacks, a.attack] });
    case 'removeAttack':
      return setInput(s, { ...input, attacks: input.attacks.filter((x) => x.id !== a.id) });
    case 'ocrImage':
      return { ...s, ocr: { ...idleOcr(), imageUrl: a.imageUrl, imageSize: a.size } };
    case 'ocrStart':
      return { ...s, ocr: { ...s.ocr, status: 'running', progress: 0, message: '準備しています', error: null } };
    case 'ocrProgress':
      return { ...s, ocr: { ...s.ocr, progress: a.progress, message: a.message } };
    case 'ocrDone':
      return {
        ...setInput(s, { ...input, panel: a.parsed.panel }),
        ocr: {
          ...s.ocr,
          status: 'done',
          progress: 1,
          message: '',
          meta: a.parsed.meta,
          header: a.parsed.header,
          unmatched: a.parsed.unmatched,
          info: a.parsed.info,
          error: null,
        },
      };
    case 'ocrError':
      return { ...s, ocr: { ...s.ocr, status: 'error', error: a.error, message: '' } };
    case 'setCrop':
      return { ...s, ocr: { ...s.ocr, crop: a.crop } };
    case 'calibUnknown':
      return { ...s, calib: { ...s.calib, unknownKey: a.key, search: null, multi: null } };
    case 'calibSearch':
      return { ...s, calib: { ...s.calib, search: a.results } };
    case 'calibAddSample':
      return { ...s, calib: { ...s.calib, samples: [...s.calib.samples, a.sample], multi: null } };
    case 'calibRemoveSample':
      return { ...s, calib: { ...s.calib, samples: s.calib.samples.filter((x) => x.id !== a.id), multi: null } };
    case 'calibMulti':
      return { ...s, calib: { ...s.calib, multi: a.results } };
  }
}

/** meta の長さを skills に合わせる（プリセット読み込み後など meta が無い場合） */
function padMeta(s: AppState): (CellMeta | null)[] {
  return s.input.panel.skills.map((_, i) => s.ocr.meta[i] ?? null);
}
