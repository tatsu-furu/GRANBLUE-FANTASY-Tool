import { useCallback, useEffect, useRef, useState, type Dispatch, type PointerEvent as ReactPointerEvent } from 'react';
import expected from '../../../fixtures/panel-001.json';
import { defaultData } from '../../engine/data';
import { panelFromExpected } from '../../engine/sample';
import type { PanelSkill } from '../../engine/types';
import { getRecognizer, imageToRGBA, loadImage, loadMessage, offsetResult } from '../../ocr/browser';
import { parseText } from '../../ocr/parse';
import { runOcr } from '../../ocr/pipeline';
import { cropImage } from '../../ocr/preprocess';
import type { Rect, RGBAImage } from '../../ocr/types';
import type { Action, OcrView } from '../state';
import { confLevel, Panel } from './common';

interface Props {
  ocr: OcrView;
  skills: PanelSkill[];
  dispatch: Dispatch<Action>;
  image: HTMLImageElement | null;
  setImage: (img: HTMLImageElement | null) => void;
  hover: number | null;
  setHover: (i: number | null) => void;
}

const TEXT_EXAMPLE = '予測ダメージ 847,974\n対土属性予測ダメージ 1,243,337\n攻刃 54%　M攻刃 296%\n…';

export function ImagePanel({ ocr, skills, dispatch, image, setImage, hover, setHover }: Props) {
  const fileRef = useRef<HTMLInputElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const rgbaRef = useRef<RGBAImage | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(image);
  const [dragging, setDragging] = useState(false);
  const [text, setText] = useState('');
  const [selecting, setSelecting] = useState(false);
  const [draft, setDraft] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const running = ocr.status === 'running';
  imageRef.current = image;

  const recognize = useCallback(
    async (crop: Rect | null) => {
      const full = rgbaRef.current;
      if (!full) return;
      dispatch({ type: 'ocrStart' });
      try {
        const rec = getRecognizer((status, p) =>
          dispatch({ type: 'ocrProgress', progress: 0.05, message: `${loadMessage(status)}${p > 0 && p < 1 ? `（${Math.round(p * 100)}%）` : ''}` }),
        );
        const src = crop ? cropImage(full, crop) : full;
        let r = await runOcr(src, rec, defaultData.labels, (s) => dispatch({ type: 'ocrProgress', progress: s.progress, message: s.message }));
        if (crop) r = offsetResult(r, Math.max(0, Math.floor(crop.x)), Math.max(0, Math.floor(crop.y)));
        const notes = [
          `${r.variant === 'binary' ? '二値化あり' : '二値化なし'}の結果を採用`,
          `${(r.durationMs / 1000).toFixed(1)}秒`,
          r.headingFound ? null : '見出し「発動中の武器スキル」が見つからないため左右の分割はしていません',
        ].filter(Boolean);
        dispatch({
          type: 'ocrDone',
          parsed: { panel: r.panel, meta: r.meta, header: r.header, unmatched: r.unmatched, info: notes.join('・') },
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        dispatch({ type: 'ocrError', error: `文字認識に失敗しました（${msg}）。通信環境を確認するか、テキスト貼り付けを使ってください` });
      }
    },
    [dispatch],
  );

  const load = useCallback(
    async (blob: Blob) => {
      try {
        const img = await loadImage(blob);
        if (imageRef.current) URL.revokeObjectURL(imageRef.current.src);
        rgbaRef.current = imageToRGBA(img);
        dispatch({ type: 'ocrImage', imageUrl: img.src, size: { w: img.naturalWidth, h: img.naturalHeight } });
        setImage(img);
        await recognize(null);
      } catch {
        dispatch({ type: 'ocrError', error: '画像を読み込めませんでした' });
      }
    },
    [dispatch, recognize, setImage],
  );

  // ページ全体で画像の貼り付け（Ctrl+V）を受ける
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const item = [...(e.clipboardData?.items ?? [])].find((it) => it.type.startsWith('image/'));
      const file = item?.getAsFile();
      if (file) {
        e.preventDefault();
        void load(file);
      }
    };
    document.addEventListener('paste', onPaste);
    return () => document.removeEventListener('paste', onPaste);
  }, [load]);

  // 画面全体をドロップ領域にする
  useEffect(() => {
    const hasFiles = (e: DragEvent) => e.dataTransfer?.types.includes('Files') ?? false;
    const over = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      setDragging(true);
    };
    const leave = (e: DragEvent) => {
      if (e.relatedTarget === null) setDragging(false);
    };
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      setDragging(false);
      const file = [...(e.dataTransfer?.files ?? [])].find((f) => f.type.startsWith('image/'));
      if (file) void load(file);
    };
    window.addEventListener('dragover', over);
    window.addEventListener('dragleave', leave);
    window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('dragover', over);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('drop', drop);
    };
  }, [load]);

  const toImagePoint = (e: ReactPointerEvent<SVGSVGElement>) => {
    const svg = svgRef.current;
    const size = ocr.imageSize;
    if (!svg || !size) return { x: 0, y: 0 };
    const r = svg.getBoundingClientRect();
    return {
      x: Math.min(size.w, Math.max(0, ((e.clientX - r.left) / r.width) * size.w)),
      y: Math.min(size.h, Math.max(0, ((e.clientY - r.top) / r.height) * size.h)),
    };
  };

  const onPointerDown = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (!selecting) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const p = toImagePoint(e);
    setDraft({ x0: p.x, y0: p.y, x1: p.x, y1: p.y });
  };
  const onPointerMove = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (!selecting || !draft) return;
    const p = toImagePoint(e);
    setDraft({ ...draft, x1: p.x, y1: p.y });
  };
  const onPointerUp = () => {
    if (!selecting || !draft) return;
    const rect: Rect = {
      x: Math.min(draft.x0, draft.x1),
      y: Math.min(draft.y0, draft.y1),
      w: Math.abs(draft.x1 - draft.x0),
      h: Math.abs(draft.y1 - draft.y0),
    };
    setDraft(null);
    setSelecting(false);
    if (rect.w > 20 && rect.h > 20) dispatch({ type: 'setCrop', crop: rect });
  };

  const loadSample = () => {
    const panel = panelFromExpected(expected, defaultData.labels);
    dispatch({
      type: 'ocrDone',
      parsed: { panel, meta: panel.skills.map(() => null), header: {}, unmatched: [], info: 'サンプル値（fixtures/panel-001.json）を読み込みました' },
    });
  };

  const loadText = () => {
    const r = parseText(text, defaultData.labels);
    dispatch({ type: 'ocrDone', parsed: { panel: r.panel, meta: r.meta, header: r.header, unmatched: r.unmatched, info: 'テキストから読み込みました' } });
  };

  const clear = () => {
    rgbaRef.current = null;
    dispatch({ type: 'clearPanel' });
  };

  const size = ocr.imageSize;
  const crop = ocr.crop;
  const box = (b: [number, number, number, number] | Rect) =>
    Array.isArray(b) ? { x: b[0], y: b[1], width: b[2], height: b[3] } : { x: b.x, y: b.y, width: b.w, height: b.h };

  return (
    <Panel
      id="panel-a"
      step="A"
      title="スクショ入力"
      actions={
        <>
          <button type="button" className="btn ghost" onClick={loadSample}>
            サンプル値
          </button>
          <button type="button" className="btn ghost" onClick={clear} disabled={running}>
            クリア
          </button>
        </>
      }
    >
      <div
        className="dropzone"
        role="button"
        tabIndex={0}
        onClick={() => fileRef.current?.click()}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            fileRef.current?.click();
          }
        }}
      >
        <strong>編成画面「発動中の武器スキル」パネルのスクショ</strong>
        <span>貼り付け（Ctrl+V）・ドラッグ&ドロップ・クリックして選択</span>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void load(f);
            e.target.value = '';
          }}
        />
      </div>
      <p className="note">スクショは外部に送信しません。文字認識はブラウザ内で行います（初回だけ認識用データを読み込みます）。</p>

      {running ? (
        <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(ocr.progress * 100)}>
          <div className="bar" style={{ width: `${Math.round(ocr.progress * 100)}%` }} />
          <span>{ocr.message}</span>
        </div>
      ) : null}
      {ocr.error ? <p className="error">{ocr.error}</p> : null}
      {ocr.info && !running ? <p className="note">{ocr.info}</p> : null}

      {ocr.imageUrl && size ? (
        <>
          <div className="shot">
            <img src={ocr.imageUrl} alt="読み込んだスクショ" draggable={false} />
            <svg
              ref={svgRef}
              className={`overlay${selecting ? ' selecting' : ''}`}
              viewBox={`0 0 ${size.w} ${size.h}`}
              preserveAspectRatio="none"
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
            >
              {Object.entries(ocr.header).map(([k, f]) => (f?.bbox ? <rect key={k} className="box header" {...box(f.bbox)} /> : null))}
              {ocr.unmatched.map((u, i) => (u.bbox ? <rect key={`u${i}`} className="box unmatched" {...box(u.bbox)} /> : null))}
              {skills.map((s, i) =>
                s.bbox ? (
                  <rect
                    key={`s${i}`}
                    className={`box conf-${confLevel(s.confidence)}${s.ignored ? ' ignored' : ''}${hover === i ? ' hover' : ''}`}
                    {...box(s.bbox)}
                    onPointerEnter={() => setHover(i)}
                    onPointerLeave={() => setHover(null)}
                  >
                    <title>{`${s.labelRaw} ${s.value}${s.unit === '%' ? '%' : ''}`}</title>
                  </rect>
                ) : null,
              )}
              {crop ? <rect className="box crop-rect" {...box(crop)} /> : null}
              {draft ? (
                <rect
                  className="box crop-rect"
                  x={Math.min(draft.x0, draft.x1)}
                  y={Math.min(draft.y0, draft.y1)}
                  width={Math.abs(draft.x1 - draft.x0)}
                  height={Math.abs(draft.y1 - draft.y0)}
                />
              ) : null}
            </svg>
          </div>
          <div className="legend-row" aria-label="枠の色の意味">
            <span className="key conf-high">信頼度 高</span>
            <span className="key conf-mid">中</span>
            <span className="key conf-low">低</span>
            <span className="key unmatched">組にならなかった文字</span>
          </div>
          <div className="row-actions">
            <button type="button" className="btn" onClick={() => setSelecting((v) => !v)} disabled={running} aria-pressed={selecting}>
              {selecting ? '範囲をドラッグで選択中…' : '範囲を選んで読み直す'}
            </button>
            {crop ? (
              <>
                <button type="button" className="btn primary" onClick={() => void recognize(crop)} disabled={running}>
                  この範囲で読み直す
                </button>
                <button type="button" className="btn ghost" onClick={() => dispatch({ type: 'setCrop', crop: null })} disabled={running}>
                  範囲を解除
                </button>
              </>
            ) : (
              <button type="button" className="btn ghost" onClick={() => void recognize(null)} disabled={running || !image}>
                全体を読み直す
              </button>
            )}
          </div>
          {ocr.unmatched.length > 0 ? (
            <details className="unmatched-list">
              <summary>組にならなかった文字（{ocr.unmatched.length}件）</summary>
              <ul>
                {ocr.unmatched.map((u, i) => (
                  <li key={i}>{u.text}</li>
                ))}
              </ul>
            </details>
          ) : null}
        </>
      ) : null}

      <details className="textpaste">
        <summary>テキストで貼り付ける（スマホの文字認識など）</summary>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={6}
          placeholder={TEXT_EXAMPLE}
          aria-label="パネルのテキスト"
        />
        <button type="button" className="btn primary" onClick={loadText} disabled={!text.trim()}>
          テキストを読み込む
        </button>
      </details>

      {dragging ? (
        <div className="drop-overlay" aria-hidden="true">
          <span>ドロップしてスクショを読み込む</span>
        </div>
      ) : null}
    </Panel>
  );
}
