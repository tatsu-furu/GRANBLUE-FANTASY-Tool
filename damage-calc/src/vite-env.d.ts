/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_TESS_BASE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
