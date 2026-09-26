import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { calculate, inputWarnings } from '../engine/attack';
import { defaultInput } from '../engine/defaults';
import { CalibrationPanel } from './components/CalibrationPanel';
import { ExtraPanel } from './components/ExtraPanel';
import { ImagePanel } from './components/ImagePanel';
import { PanelForm } from './components/PanelForm';
import { PresetsPanel } from './components/PresetsPanel';
import { ResultsPanel } from './components/ResultsPanel';
import { decodeShareHash, encodeShareHash } from './share';
import { initialState, reducer } from './state';
import { loadLast, loadTheme, saveLast, saveTheme, type ThemeChoice } from './storage';

const THEME_LABEL: Record<ThemeChoice, string> = { auto: '自動', dark: 'ダーク', light: 'ライト' };
const NEXT_THEME: Record<ThemeChoice, ThemeChoice> = { auto: 'dark', dark: 'light', light: 'auto' };

function initial() {
  const shared = decodeShareHash(window.location.hash);
  return initialState(shared ?? loadLast() ?? defaultInput());
}

export function App() {
  const [state, dispatch] = useReducer(reducer, undefined, initial);
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  const [theme, setTheme] = useState<ThemeChoice>(loadTheme);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<number | undefined>(undefined);

  const notify = useCallback((msg: string) => {
    setToast(msg);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 2600);
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'auto') delete root.dataset.theme;
    else root.dataset.theme = theme;
    saveTheme(theme);
  }, [theme]);

  // 共有リンクから開いたら、読み込んだあとはアドレスバーのハッシュを消す（再読み込みで手元の編集が上書きされないように）。
  // 開いているタブに共有リンクを貼った場合はページが再読み込みされないので hashchange でも読む
  useEffect(() => {
    const loadFromHash = () => {
      const shared = decodeShareHash(window.location.hash);
      if (!shared) return;
      dispatch({ type: 'loadInput', input: shared });
      window.history.replaceState(null, '', window.location.pathname + window.location.search);
      notify('共有リンクの入力を読み込みました');
    };
    loadFromHash(); // 初回描画のあとにハッシュが変わっていた場合も拾う
    window.addEventListener('hashchange', loadFromHash);
    return () => window.removeEventListener('hashchange', loadFromHash);
  }, [notify]);

  useEffect(() => {
    const t = window.setTimeout(() => saveLast(state.input), 300);
    return () => window.clearTimeout(t);
  }, [state.input]);

  // 画像が外れたら（プリセット・共有リンクの読み込み、クリア）読み込んだ画像も解放する
  useEffect(() => {
    if (state.ocr.imageUrl === null && image) {
      URL.revokeObjectURL(image.src);
      setImage(null);
    }
  }, [state.ocr.imageUrl, image]);

  const results = useMemo(() => calculate(state.input), [state.input]);
  const warnings = useMemo(() => inputWarnings(state.input), [state.input]);

  const share = async () => {
    const url = `${window.location.origin}${window.location.pathname}${encodeShareHash(state.input)}`;
    try {
      await navigator.clipboard.writeText(url);
      notify('共有リンクをコピーしました（スクショ画像は含みません）');
    } catch {
      window.prompt('共有リンク（スクショ画像は含みません）', url);
    }
  };

  const reset = () => {
    if (!window.confirm('入力をすべて初期状態に戻します。よろしいですか？')) return;
    dispatch({ type: 'loadInput', input: defaultInput() });
  };

  return (
    <div className="app">
      <header className="topbar">
        <a className="back" href="../index.html">
          ← GBF Tool
        </a>
        <h1>
          ダメージ計算機 <span className="beta">β</span>
        </h1>
        <div className="top-actions">
          <button type="button" className="btn ghost" onClick={() => void share()}>
            共有リンクをコピー
          </button>
          <button type="button" className="btn ghost" onClick={reset}>
            リセット
          </button>
          <button type="button" className="btn ghost" onClick={() => setTheme(NEXT_THEME[theme])} aria-label={`テーマ: ${THEME_LABEL[theme]}（押すと切り替え）`}>
            テーマ: {THEME_LABEL[theme]}
          </button>
        </div>
      </header>

      <main className="layout">
        <div className="col col-input">
          <ImagePanel
            ocr={state.ocr}
            skills={state.input.panel.skills}
            dispatch={dispatch}
            image={image}
            setImage={setImage}
            hover={hover}
            setHover={setHover}
          />
          <ExtraPanel input={state.input} dispatch={dispatch} />
        </div>
        <div className="col col-form">
          <PanelForm
            panel={state.input.panel}
            meta={state.ocr.meta}
            header={state.ocr.header}
            dispatch={dispatch}
            image={image}
            hover={hover}
            setHover={setHover}
          />
        </div>
        <div className="col col-result">
          <ResultsPanel results={results} input={state.input} warnings={warnings} />
          <CalibrationPanel input={state.input} calib={state.calib} dispatch={dispatch} />
          <PresetsPanel input={state.input} dispatch={dispatch} notify={notify} />
        </div>
      </main>

      <footer className="footer">
        <p>
          非公式のファンツールです（ベータ版）。ゲーム本体には一切アクセスせず、自分で撮ったスクショだけを扱います。スクショは外部に送信しません。
        </p>
        <p>
          計算式の出典:{' '}
          <a href="https://gbf.wiki/Damage_Formula" target="_blank" rel="noopener noreferrer">
            gbf.wiki Damage Formula
          </a>
          ・
          <a href="https://gbf.wiki/Damage_Formula/Detailed_Damage_Formula" target="_blank" rel="noopener noreferrer">
            Detailed Damage Formula
          </a>
          ・
          <a href="https://gbf.wiki/Damage_Cap" target="_blank" rel="noopener noreferrer">
            Damage Cap
          </a>
          （CC BY-NC-SA 4.0）。GRANBLUE FANTASY は Cygames, Inc. の著作物です。
        </p>
      </footer>

      {toast ? (
        <div className="toast" role="status">
          {toast}
        </div>
      ) : null}
    </div>
  );
}
