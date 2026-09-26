// OCR の型。ブラウザと Node（テスト）で共通に使うため、画像は RGBA の配列で扱う。

export interface RGBAImage {
  width: number;
  height: number;
  data: Uint8ClampedArray; // RGBA
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface OcrWord {
  text: string;
  confidence: number; // 0..100
  bbox: Rect;
}

/** 認識器。プロトタイプは tesseract.js のみだが、ほかの OCR や画像認識 API に差し替えられるようにする */
export interface Recognizer {
  /** 画像全体を疎なテキストとして認識し、単語ごとの矩形と信頼度を返す */
  recognizeWords(img: RGBAImage, onProgress?: (progress: number) => void): Promise<OcrWord[]>;
  /** 数値だけの小さな画像を 0-9 . , % + - に限定して1行として認識する */
  recognizeValue(img: RGBAImage): Promise<{ text: string; confidence: number }>;
  terminate(): Promise<void>;
}
