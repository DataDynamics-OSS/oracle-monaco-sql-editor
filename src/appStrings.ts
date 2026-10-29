/** Demo page (App.tsx) strings. The editor's own strings live in `oracle/i18n`. */
import type { OracleLocale } from "./oracle/i18n";

export interface AppStrings {
  language: string;
  font: string;
  dark: string;
  version: string;
  blankLine: string;
  validate: string;
  validateOff: string;
  serverCheck: string;
  serverCheckTitle: string;
  commit: string;
  rollback: string;
  disconnect: string;
  database: string;
  user: string;
  password: string;
  connect: string;
  offline: string;
  help: string;
  notConnected: string;
  commitDone: string;
  rollbackDone: string;
  running: string;
  cancel: string;
  fetchMore: string;
  at: (line: number, column: number) => string;
  lineN: (line: number) => string;
  bindPrompt: (name: string) => string;
  substitutionPrompt: (name: string) => string;
  sampleTable: string;
}

const en: AppStrings = {
  language: "Language",
  font: "Font",
  dark: "Dark",
  version: "Version",
  blankLine: "Blank line separates",
  validate: "Validate",
  validateOff: "off",
  serverCheck: "Server check",
  serverCheckTitle: "Check queries / DML with EXPLAIN PLAN while typing (never executes; DDL is never sent)",
  commit: "Commit",
  rollback: "Rollback",
  disconnect: "Disconnect",
  database: "Database",
  user: "user",
  password: "password",
  connect: "Connect",
  offline: "offline · sample metadata (no gateway at /api)",
  help:
    "Ctrl/Cmd+Enter = Run Statement · F5 = Run Script · F10 = Explain Plan · Shift+F4 = Describe · Shift+Alt+F = Prettify · Ctrl/Cmd+' = Toggle Case · Shift+F1 / Ctrl+Click = Help · hover a name for its definition · type ( or , for parameter hints",
  notConnected: "Not connected — sign in to a gateway to run statements (see servers/server-node/README.md).",
  commitDone: "Commit complete.",
  rollbackDone: "Rollback complete.",
  running: "Running…",
  cancel: "Cancel",
  fetchMore: "Fetch more",
  at: (l, c) => ` (line ${l}, column ${c})`,
  lineN: (l) => `line ${l}`,
  bindPrompt: (n) => `Value for :${n}`,
  substitutionPrompt: (n) => `Enter value for ${n.toLowerCase()}:`,
  sampleTable: "Sample table (offline demo)",
};

const ko: AppStrings = {
  language: "언어",
  font: "글꼴",
  dark: "다크",
  version: "버전",
  blankLine: "빈 줄로 문장 구분",
  validate: "검증",
  validateOff: "끔",
  serverCheck: "서버 검사",
  serverCheckTitle: "입력하는 동안 쿼리/DML 을 EXPLAIN PLAN 으로 검사 (실행하지 않으며 DDL 은 보내지 않음)",
  commit: "커밋",
  rollback: "롤백",
  disconnect: "연결 해제",
  database: "데이터베이스",
  user: "사용자",
  password: "비밀번호",
  connect: "연결",
  offline: "오프라인 · 샘플 메타데이터 (/api 게이트웨이 없음)",
  help:
    "Ctrl/Cmd+Enter = 문장 실행 · F5 = 스크립트 실행 · F10 = 실행 계획 · Shift+F4 = 객체 정보 · Shift+Alt+F = 정렬 · Ctrl/Cmd+' = 대소문자 전환 · Shift+F1 / Ctrl+클릭 = 도움말 · 이름에 마우스를 올리면 정의 표시 · ( 또는 , 입력 시 파라미터 힌트",
  notConnected: "연결되지 않음 — 문장을 실행하려면 게이트웨이에 로그인하세요 (servers/server-node/README.md 참고).",
  commitDone: "커밋되었습니다.",
  rollbackDone: "롤백되었습니다.",
  running: "실행 중…",
  cancel: "취소",
  fetchMore: "더 가져오기",
  at: (l, c) => ` (${l}행 ${c}열)`,
  lineN: (l) => `${l}행`,
  bindPrompt: (n) => `:${n} 의 값`,
  substitutionPrompt: (n) => `${n.toLowerCase()} 의 값을 입력하세요:`,
  sampleTable: "샘플 테이블 (오프라인 데모)",
};

const ja: AppStrings = {
  language: "言語",
  font: "フォント",
  dark: "ダーク",
  version: "バージョン",
  blankLine: "空行で文を区切る",
  validate: "検証",
  validateOff: "オフ",
  serverCheck: "サーバー検査",
  serverCheckTitle: "入力中に問合せ/DML を EXPLAIN PLAN で検査 (実行はせず、DDL は送信しない)",
  commit: "コミット",
  rollback: "ロールバック",
  disconnect: "切断",
  database: "データベース",
  user: "ユーザー",
  password: "パスワード",
  connect: "接続",
  offline: "オフライン · サンプル・メタデータ (/api にゲートウェイなし)",
  help:
    "Ctrl/Cmd+Enter = 文の実行 · F5 = スクリプトの実行 · F10 = 実行計画 · Shift+F4 = オブジェクトの表示 · Shift+Alt+F = 整形 · Ctrl/Cmd+' = 大文字/小文字の切替え · Shift+F1 / Ctrl+クリック = ヘルプ · 名前にマウスを合わせると定義を表示 · ( または , でパラメータ・ヒント",
  notConnected: "未接続 — 文を実行するにはゲートウェイにサインインしてください (servers/server-node/README.md を参照)。",
  commitDone: "コミットが完了しました。",
  rollbackDone: "ロールバックが完了しました。",
  running: "実行中…",
  cancel: "取消し",
  fetchMore: "さらに取得",
  at: (l, c) => ` (${l}行 ${c}列)`,
  lineN: (l) => `${l}行`,
  bindPrompt: (n) => `:${n} の値`,
  substitutionPrompt: (n) => `${n.toLowerCase()} の値を入力してください:`,
  sampleTable: "サンプル表 (オフライン・デモ)",
};

const zh: AppStrings = {
  language: "语言",
  font: "字体",
  dark: "深色",
  version: "版本",
  blankLine: "空行分隔语句",
  validate: "校验",
  validateOff: "关闭",
  serverCheck: "服务器检查",
  serverCheckTitle: "输入时用 EXPLAIN PLAN 检查查询/DML（不会执行，也不会发送 DDL）",
  commit: "提交",
  rollback: "回滚",
  disconnect: "断开连接",
  database: "数据库",
  user: "用户",
  password: "密码",
  connect: "连接",
  offline: "离线 · 示例元数据（/api 无网关）",
  help:
    "Ctrl/Cmd+Enter = 执行语句 · F5 = 执行脚本 · F10 = 执行计划 · Shift+F4 = 对象信息 · Shift+Alt+F = 格式化 · Ctrl/Cmd+' = 切换大小写 · Shift+F1 / Ctrl+单击 = 帮助 · 鼠标悬停名称显示定义 · 输入 ( 或 , 显示参数提示",
  notConnected: "未连接 — 请登录网关后再执行语句（参见 servers/server-node/README.md）。",
  commitDone: "提交完成。",
  rollbackDone: "回滚完成。",
  running: "正在执行…",
  cancel: "取消",
  fetchMore: "获取更多",
  at: (l, c) => `（第 ${l} 行，第 ${c} 列）`,
  lineN: (l) => `第 ${l} 行`,
  bindPrompt: (n) => `:${n} 的值`,
  substitutionPrompt: (n) => `请输入 ${n.toLowerCase()} 的值：`,
  sampleTable: "示例表（离线演示）",
};

export const APP_STRINGS: Record<OracleLocale, AppStrings> = { en, ko, ja, zh };

/** Saved choice, else the browser language, else English. */
export function initialLocale(): OracleLocale {
  try {
    const saved = localStorage.getItem("oracle-monaco-locale");
    if (saved && saved in APP_STRINGS) return saved as OracleLocale;
  } catch {
    /* storage unavailable */
  }
  const lang = (typeof navigator !== "undefined" ? navigator.language : "en").slice(0, 2);
  return lang in APP_STRINGS ? (lang as OracleLocale) : "en";
}

/** Saved editor font id, else the default (D2Coding Ligature). */
export function initialFont(fallback: string): string {
  try {
    return localStorage.getItem("oracle-monaco-font") ?? fallback;
  } catch {
    return fallback;
  }
}

export function saveFont(id: string): void {
  try {
    localStorage.setItem("oracle-monaco-font", id);
  } catch {
    /* storage unavailable */
  }
}

export function saveLocale(locale: OracleLocale): void {
  try {
    localStorage.setItem("oracle-monaco-locale", locale);
  } catch {
    /* storage unavailable */
  }
}
