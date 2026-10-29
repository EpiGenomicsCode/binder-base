/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Absolute origin for canonical URLs, e.g. https://binderbase.org. Optional:
   *  without it, canonicals use the origin the page was served from. */
  readonly VITE_SITE_ORIGIN?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
