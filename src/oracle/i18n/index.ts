/**
 * Editor UI languages: action labels, hover / help text, built-in help
 * summaries and grammar-check messages in English, Korean, Japanese and
 * Chinese (Simplified).
 *
 * SQL, syntax outlines and examples stay as written; manual links always
 * point to the English Oracle documentation (the translated manuals use a
 * different, unversioned URL scheme). Messages from the database (ORA-…)
 * and SQL*Plus-style feedback are not translated.
 */
import type { DocKind, OracleDocEntry } from "../docs";
import type { OracleObjectKind } from "../completion";
import type { DocTranslation, OracleLocale } from "./types";
import ko from "./docs.ko";
import ja from "./docs.ja";
import zh from "./docs.zh";

export type { DocTranslation, OracleLocale } from "./types";

/** Supported locales with their native names (for a language picker). */
export const ORACLE_LOCALES: { id: OracleLocale; label: string }[] = [
  { id: "en", label: "English" },
  { id: "ko", label: "한국어" },
  { id: "ja", label: "日本語" },
  { id: "zh", label: "中文" },
];

const DOCS: Partial<Record<OracleLocale, DocTranslation>> = { ko, ja, zh };

export interface OracleUiStrings {
  actions: {
    runStatement: string;
    runScript: string;
    explainPlan: string;
    describe: string;
    prettify: string;
    toggleCase: string;
    showHelp: string;
  };
  docKind: Record<DocKind, string>;
  objectKind: Partial<Record<OracleObjectKind, string>>;
  example: string;
  documentation: (version: string) => string;
  /** `col — column of t` */
  columnOf: (parent: string) => string;
  viaSynonym: (synonym: string) => string;
  moreColumns: (n: number) => string;
  columnHeader: string;
  typeHeader: string;
  members: string;
  columns: string;
  cte: string;
  inlineView: string;
  record: string;
  plsqlSymbol: Record<"variable" | "constant" | "parameter" | "cursor" | "record" | "exception" | "type", string>;
  sequenceProperty: Record<string, string>;
  /** Grammar / version-check messages from the worker. */
  incomplete: string;
  incompleteMissing: (what: string) => string;
  syntaxError: (at: string) => string;
  syntaxErrorExpected: (at: string, expected: string) => string;
  invalidChar: (c: string) => string;
  requires23ai: (what: string, target: string) => string;
  selectWithoutFrom: (target: string) => string;
}

const en: OracleUiStrings = {
  actions: {
    runStatement: "Run Statement",
    runScript: "Run Script",
    explainPlan: "Explain Plan",
    describe: "Describe",
    prettify: "Prettify",
    toggleCase: "Toggle Case",
    showHelp: "Show Help",
  },
  docKind: {
    function: "function",
    statement: "SQL statement",
    clause: "clause",
    condition: "condition",
    operator: "operator",
    "pseudo-column": "pseudo-column",
    type: "data type",
    package: "Oracle-supplied package",
    plsql: "PL/SQL",
  },
  objectKind: {
    schema: "schema",
    table: "table",
    view: "view",
    materialized_view: "materialized view",
    synonym: "synonym",
    sequence: "sequence",
    package: "package",
    procedure: "procedure",
    function: "function",
    type: "type",
    column: "column",
    dblink: "database link",
  },
  example: "Example:",
  documentation: (v) => `Oracle ${v} documentation ↗`,
  columnOf: (p) => `column of ${p}`,
  viaSynonym: (s) => `via synonym ${s}`,
  moreColumns: (n) => `… ${n} more columns`,
  columnHeader: "Column",
  typeHeader: "Type",
  members: "Members",
  columns: "Columns",
  cte: "common table expression",
  inlineView: "inline view",
  record: "record",
  plsqlSymbol: {
    variable: "PL/SQL variable",
    constant: "PL/SQL constant",
    parameter: "PL/SQL parameter",
    cursor: "PL/SQL cursor",
    record: "PL/SQL record",
    exception: "PL/SQL exception",
    type: "PL/SQL type",
  },
  sequenceProperty: {
    min: "min",
    max: "max",
    "increment by": "increment by",
    cycle: "cycle",
    cache: "cache",
    "last number": "last number",
  },
  incomplete: "Incomplete statement",
  incompleteMissing: (w) => `Incomplete statement: missing ${w}`,
  syntaxError: (at) => `Syntax error at ${at}`,
  syntaxErrorExpected: (at, ex) => `Syntax error at ${at}: expected ${ex}`,
  invalidChar: (c) => `Invalid character '${c}'`,
  requires23ai: (w, t) => `${w} requires Oracle 23ai (target: ${t})`,
  selectWithoutFrom: (t) => `SELECT without FROM requires Oracle 23ai (target: ${t}); use FROM dual`,
};

const koUi: OracleUiStrings = {
  actions: {
    runStatement: "문장 실행",
    runScript: "스크립트 실행",
    explainPlan: "실행 계획",
    describe: "객체 정보",
    prettify: "정렬(포맷)",
    toggleCase: "대소문자 전환",
    showHelp: "도움말 보기",
  },
  docKind: {
    function: "함수",
    statement: "SQL 문",
    clause: "절",
    condition: "조건",
    operator: "연산자",
    "pseudo-column": "의사 컬럼",
    type: "데이터 타입",
    package: "Oracle 제공 패키지",
    plsql: "PL/SQL",
  },
  objectKind: {
    schema: "스키마",
    table: "테이블",
    view: "뷰",
    materialized_view: "구체화된 뷰",
    synonym: "시노님",
    sequence: "시퀀스",
    package: "패키지",
    procedure: "프로시저",
    function: "함수",
    type: "타입",
    column: "컬럼",
    dblink: "데이터베이스 링크",
  },
  example: "예제:",
  documentation: (v) => `Oracle ${v} 매뉴얼 ↗`,
  columnOf: (p) => `${p} 의 컬럼`,
  viaSynonym: (s) => `시노님 ${s} 경유`,
  moreColumns: (n) => `… 컬럼 ${n}개 더 있음`,
  columnHeader: "컬럼",
  typeHeader: "타입",
  members: "멤버",
  columns: "컬럼",
  cte: "공통 테이블 표현식(CTE)",
  inlineView: "인라인 뷰",
  record: "레코드",
  plsqlSymbol: {
    variable: "PL/SQL 변수",
    constant: "PL/SQL 상수",
    parameter: "PL/SQL 파라미터",
    cursor: "PL/SQL 커서",
    record: "PL/SQL 레코드",
    exception: "PL/SQL 예외",
    type: "PL/SQL 타입",
  },
  sequenceProperty: {
    min: "최솟값",
    max: "최댓값",
    "increment by": "증가값",
    cycle: "순환",
    cache: "캐시",
    "last number": "마지막 번호",
  },
  incomplete: "문장이 완성되지 않았습니다",
  incompleteMissing: (w) => `문장이 완성되지 않았습니다: ${w} 누락`,
  syntaxError: (at) => `${at} 에서 구문 오류`,
  syntaxErrorExpected: (at, ex) => `${at} 에서 구문 오류: ${ex} 필요`,
  invalidChar: (c) => `잘못된 문자 '${c}'`,
  requires23ai: (w, t) => `${w} 는 Oracle 23ai 이상에서만 지원됩니다 (대상: ${t})`,
  selectWithoutFrom: (t) => `FROM 없는 SELECT 는 Oracle 23ai 이상에서만 지원됩니다 (대상: ${t}). FROM dual 을 사용하세요`,
};

const jaUi: OracleUiStrings = {
  actions: {
    runStatement: "文の実行",
    runScript: "スクリプトの実行",
    explainPlan: "実行計画",
    describe: "オブジェクトの表示",
    prettify: "整形",
    toggleCase: "大文字/小文字の切替え",
    showHelp: "ヘルプの表示",
  },
  docKind: {
    function: "関数",
    statement: "SQL文",
    clause: "句",
    condition: "条件",
    operator: "演算子",
    "pseudo-column": "疑似列",
    type: "データ型",
    package: "Oracle提供パッケージ",
    plsql: "PL/SQL",
  },
  objectKind: {
    schema: "スキーマ",
    table: "表",
    view: "ビュー",
    materialized_view: "マテリアライズド・ビュー",
    synonym: "シノニム",
    sequence: "順序",
    package: "パッケージ",
    procedure: "プロシージャ",
    function: "ファンクション",
    type: "型",
    column: "列",
    dblink: "データベース・リンク",
  },
  example: "例:",
  documentation: (v) => `Oracle ${v} マニュアル ↗`,
  columnOf: (p) => `${p} の列`,
  viaSynonym: (s) => `シノニム ${s} 経由`,
  moreColumns: (n) => `… ほか ${n} 列`,
  columnHeader: "列",
  typeHeader: "型",
  members: "メンバー",
  columns: "列",
  cte: "共通表式 (CTE)",
  inlineView: "インライン・ビュー",
  record: "レコード",
  plsqlSymbol: {
    variable: "PL/SQL 変数",
    constant: "PL/SQL 定数",
    parameter: "PL/SQL パラメータ",
    cursor: "PL/SQL カーソル",
    record: "PL/SQL レコード",
    exception: "PL/SQL 例外",
    type: "PL/SQL 型",
  },
  sequenceProperty: {
    min: "最小値",
    max: "最大値",
    "increment by": "増分",
    cycle: "循環",
    cache: "キャッシュ",
    "last number": "最終番号",
  },
  incomplete: "文が不完全です",
  incompleteMissing: (w) => `文が不完全です: ${w} がありません`,
  syntaxError: (at) => `${at} で構文エラー`,
  syntaxErrorExpected: (at, ex) => `${at} で構文エラー: ${ex} が必要です`,
  invalidChar: (c) => `無効な文字 '${c}'`,
  requires23ai: (w, t) => `${w} には Oracle 23ai 以降が必要です (対象: ${t})`,
  selectWithoutFrom: (t) => `FROM のない SELECT には Oracle 23ai 以降が必要です (対象: ${t})。FROM dual を使用してください`,
};

const zhUi: OracleUiStrings = {
  actions: {
    runStatement: "执行语句",
    runScript: "执行脚本",
    explainPlan: "执行计划",
    describe: "对象信息",
    prettify: "格式化",
    toggleCase: "切换大小写",
    showHelp: "显示帮助",
  },
  docKind: {
    function: "函数",
    statement: "SQL 语句",
    clause: "子句",
    condition: "条件",
    operator: "运算符",
    "pseudo-column": "伪列",
    type: "数据类型",
    package: "Oracle 提供的程序包",
    plsql: "PL/SQL",
  },
  objectKind: {
    schema: "方案",
    table: "表",
    view: "视图",
    materialized_view: "物化视图",
    synonym: "同义词",
    sequence: "序列",
    package: "程序包",
    procedure: "过程",
    function: "函数",
    type: "类型",
    column: "列",
    dblink: "数据库链接",
  },
  example: "示例：",
  documentation: (v) => `Oracle ${v} 文档 ↗`,
  columnOf: (p) => `${p} 的列`,
  viaSynonym: (s) => `通过同义词 ${s}`,
  moreColumns: (n) => `… 还有 ${n} 列`,
  columnHeader: "列",
  typeHeader: "类型",
  members: "成员",
  columns: "列",
  cte: "公用表表达式 (CTE)",
  inlineView: "内联视图",
  record: "记录",
  plsqlSymbol: {
    variable: "PL/SQL 变量",
    constant: "PL/SQL 常量",
    parameter: "PL/SQL 参数",
    cursor: "PL/SQL 游标",
    record: "PL/SQL 记录",
    exception: "PL/SQL 异常",
    type: "PL/SQL 类型",
  },
  sequenceProperty: {
    min: "最小值",
    max: "最大值",
    "increment by": "增量",
    cycle: "循环",
    cache: "缓存",
    "last number": "最后编号",
  },
  incomplete: "语句不完整",
  incompleteMissing: (w) => `语句不完整：缺少 ${w}`,
  syntaxError: (at) => `${at} 处语法错误`,
  syntaxErrorExpected: (at, ex) => `${at} 处语法错误：应为 ${ex}`,
  invalidChar: (c) => `无效字符 '${c}'`,
  requires23ai: (w, t) => `${w} 需要 Oracle 23ai 或更高版本（目标：${t}）`,
  selectWithoutFrom: (t) => `不带 FROM 的 SELECT 需要 Oracle 23ai 或更高版本（目标：${t}）；请使用 FROM dual`,
};

const UI: Record<OracleLocale, OracleUiStrings> = { en, ko: koUi, ja: jaUi, zh: zhUi };

/** UI strings for `locale` (English when unknown). */
export function uiStrings(locale: OracleLocale | undefined): OracleUiStrings {
  return UI[locale ?? "en"] ?? en;
}

/** Translated summary for a help id (`fn:NVL`, `topic:SELECT` …), if any. */
export function docSummary(id: string, locale: OracleLocale | undefined): string | undefined {
  return locale && locale !== "en" ? DOCS[locale]?.summaries[id] : undefined;
}

/** A help entry with title / summary in `locale` (English fallback per field). */
export function localizeDoc(entry: OracleDocEntry, locale: OracleLocale | undefined): OracleDocEntry {
  const t = locale && locale !== "en" && entry.id ? DOCS[locale] : undefined;
  if (!t || !entry.id) return entry;
  return { ...entry, title: t.titles[entry.id] ?? entry.title, summary: t.summaries[entry.id] ?? entry.summary };
}

/** Grammar / version-check messages produced by the worker (English) in `locale`. */
export function localizeMessage(message: string, locale: OracleLocale | undefined): string {
  if (!locale || locale === "en") return message;
  const s = uiStrings(locale);
  let m: RegExpExecArray | null;
  if (message === "Incomplete statement") return s.incomplete;
  if ((m = /^Incomplete statement: missing (.*)$/s.exec(message))) return s.incompleteMissing(m[1]);
  if ((m = /^Syntax error at (.*?): expected (.*)$/s.exec(message))) return s.syntaxErrorExpected(m[1], m[2]);
  if ((m = /^Syntax error at (.*)$/s.exec(message))) return s.syntaxError(m[1]);
  if ((m = /^Invalid character '(.*)'$/s.exec(message))) return s.invalidChar(m[1]);
  if ((m = /^SELECT without FROM requires Oracle 23ai \(target: (\w+)\); use FROM dual$/.exec(message))) return s.selectWithoutFrom(m[1]);
  if ((m = /^(.*) requires Oracle 23ai \(target: (\w+)\)$/s.exec(message))) return s.requires23ai(m[1], m[2]);
  return message;
}
