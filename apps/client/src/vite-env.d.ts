/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** 內容 API 位址 */
  readonly VITE_CONTENT_API?: string;
}

/** 建置時的 git commit（本機開發是 dev） */
declare const __BUILD__: string;
