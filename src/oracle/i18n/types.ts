/** Editor UI languages. */
export type OracleLocale = "en" | "ko" | "ja" | "zh";

/** Translated help text, keyed by `OracleDocEntry.id`. Missing ids fall back to English. */
export interface DocTranslation {
  /** Topic titles that contain prose (`CONNECT BY (hierarchical query)`). */
  titles: Record<string, string>;
  summaries: Record<string, string>;
}
