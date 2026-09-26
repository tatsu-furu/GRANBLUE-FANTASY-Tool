import { createWorker, OEM, PSM, type ImageLike, type Worker } from 'tesseract.js';
import type { OcrWord, Recognizer, RGBAImage } from './types';

export interface TesseractConfig {
  pageLangs?: string; // 全体の認識（既定 jpn）
  valueLangs?: string; // 値の読み直し（既定 eng。jpn と数字ホワイトリストの組み合わせは空を返しやすい）
  // 省略時は tesseract.js の既定（CDN）。自前で置く場合はパスを渡す
  workerPath?: string;
  corePath?: string;
  langPath?: string;
  cachePath?: string;
  cacheMethod?: string;
  // RGBA を tesseract.js が受け取れる形にする（ブラウザは canvas、Node は PNG の Buffer）
  toImage: (img: RGBAImage) => ImageLike | Promise<ImageLike>;
  onLoadProgress?: (status: string, progress: number) => void;
}

const VALUE_WHITELIST = '0123456789.,%+-';

/** tesseract.js の Worker を言語ごとに1つずつ作って使い回す認識器 */
export class TesseractRecognizer implements Recognizer {
  private workers = new Map<string, Promise<Worker>>();
  private recognizeProgress: ((p: number) => void) | undefined;

  constructor(private readonly config: TesseractConfig) {}

  private getWorker(langs: string): Promise<Worker> {
    let w = this.workers.get(langs);
    if (!w) {
      const { workerPath, corePath, langPath, cachePath, cacheMethod, onLoadProgress } = this.config;
      const paths = Object.fromEntries(
        Object.entries({ workerPath, corePath, langPath, cachePath, cacheMethod }).filter(([, v]) => v !== undefined),
      );
      w = createWorker(langs, OEM.LSTM_ONLY, {
        ...paths,
        logger: (m) => {
          if (m.status === 'recognizing text') this.recognizeProgress?.(m.progress);
          else onLoadProgress?.(m.status, m.progress);
        },
      }).catch((e: unknown) => {
        this.workers.delete(langs); // 読み込みに失敗したら次回やり直せるようにする
        throw e;
      });
      this.workers.set(langs, w);
    }
    return w;
  }

  async recognizeWords(img: RGBAImage, onProgress?: (p: number) => void): Promise<OcrWord[]> {
    const worker = await this.getWorker(this.config.pageLangs ?? 'jpn');
    await worker.setParameters({ tessedit_pageseg_mode: PSM.SPARSE_TEXT, preserve_interword_spaces: '1' });
    this.recognizeProgress = onProgress;
    try {
      const { data } = await worker.recognize(await this.config.toImage(img), {}, { text: true, blocks: true, hocr: false, tsv: false });
      return data.words.map((w) => ({
        text: w.text,
        confidence: w.confidence,
        bbox: { x: w.bbox.x0, y: w.bbox.y0, w: w.bbox.x1 - w.bbox.x0, h: w.bbox.y1 - w.bbox.y0 },
      }));
    } finally {
      this.recognizeProgress = undefined;
    }
  }

  async recognizeValue(img: RGBAImage): Promise<{ text: string; confidence: number }> {
    const worker = await this.getWorker(this.config.valueLangs ?? 'eng');
    await worker.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_LINE, tessedit_char_whitelist: VALUE_WHITELIST });
    const { data } = await worker.recognize(await this.config.toImage(img), {}, { text: true, blocks: false, hocr: false, tsv: false });
    return { text: data.text.trim(), confidence: data.confidence };
  }

  async terminate(): Promise<void> {
    const ws = [...this.workers.values()];
    this.workers.clear();
    await Promise.all(ws.map((w) => w.then((x) => x.terminate()).catch(() => undefined)));
  }
}
