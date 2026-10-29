export { OracleEditor, default } from "./OracleEditor";
export type { OracleEditorProps, OracleEditorInstance, ExecutionMarker } from "./OracleEditor";

export { setupOracle } from "./oracle/setup";
export type { SetupOptions, OracleRouters } from "./oracle/setup";

export {
  ORACLE_LANGUAGE_ID,
  oracleLanguage,
  oracleLanguageConf,
} from "./oracle/language";

export {
  ORACLE_LIGHT_THEME,
  ORACLE_DARK_THEME,
  oracleLightTheme,
  oracleDarkTheme,
} from "./oracle/themes";

export { DEFAULT_EDITOR_OPTIONS } from "./oracle/options";

export {
  DEFAULT_LANGUAGE_ELEMENTS,
  ORACLE_KEYWORDS,
  ORACLE_PLSQL_KEYWORDS,
  ORACLE_FUNCTIONS,
  ORACLE_OPERATORS,
  ORACLE_TYPES,
  ORACLE_PSEUDO_COLUMNS,
  ORACLE_BUILTIN_PACKAGES,
  ORACLE_VERSIONED_KEYWORDS,
  resolveLanguageElements,
} from "./oracle/keywords";
export type { OracleLanguageElements, OracleVersion } from "./oracle/keywords";

export {
  createOracleCompletionProvider,
  ORACLE_TRIGGER_CHARACTERS,
} from "./oracle/completion";
export type {
  MetadataProvider,
  MetadataProviderContext,
  OracleMetadataItem,
  OracleObjectKind,
  CompletionOptions,
} from "./oracle/completion";

export { formatOracleSql, createOracleFormatter } from "./oracle/format";
export type { Formatter, FormatOptions } from "./oracle/format";

// Statement splitting (SQL*Plus rules) and variables
export {
  splitStatements,
  statementAt,
  pickStatement,
  toExecutable,
  classifyWords,
} from "./oracle/splitter";
export type {
  SqlStatement,
  StatementKind,
  StatementTerminator,
  SqlPlusCommand,
  SplitOptions,
} from "./oracle/splitter";
export {
  findSubstitutionVariables,
  resolveSubstitutions,
  parseDefine,
  findBindVariables,
} from "./oracle/variables";
export type {
  SubstitutionVariables,
  SubstitutionPrompt,
  SubstitutionRef,
} from "./oracle/variables";
export { qualifiedNameAt, toggleCase } from "./oracle/editorStatements";

// Identifier rules (dictionary case, quoting)
export {
  normalizeIdent,
  needsQuoting,
  renderIdent,
  sameIdent,
  splitQualified,
} from "./oracle/identifiers";
export { ORACLE_RESERVED_WORDS } from "./oracle/keywords";

// Context-aware completion (ANTLR + antlr4-c3 Web Worker)
export { createCompletionWorker } from "./worker/client";
export type { CompletionWorkerHandle } from "./worker/client";
export { createContextAwareCompletionProvider } from "./worker/contextProvider";
export type { ContextCompletionOptions } from "./worker/contextProvider";
export type {
  CompletionWorkerApi,
  OracleCaretContext,
  GrammarError,
  AliasInfo,
  CteInfo,
  PlsqlSymbol,
  ValidateMode,
  TargetVersion,
} from "./worker/protocol";

export { scan } from "./oracle/scanner";
export type { Segment, SegmentType } from "./oracle/scanner";

// Signature help, named arguments, hover
export {
  callAt,
  activeSignature,
  signatureLabel,
  builtinSignatures,
  namedParameterCandidates,
  BUILTIN_SIGNATURES,
} from "./oracle/signatures";
export type {
  CallSite,
  OracleSignature,
  OracleParameter,
  SignatureSource,
} from "./oracle/signatures";
export {
  createOracleSignatureHelpProvider,
  namedArgumentItems,
  signaturesForCall,
  ORACLE_SIGNATURE_TRIGGER_CHARACTERS,
} from "./oracle/signatureHelp";
export { createOracleHoverProvider, hoverInfo, nameAtColumn, renderObjectInfo } from "./oracle/hover";
export type {
  DescribeSource,
  DescribeTarget,
  OracleObjectInfo,
  OracleColumnInfo,
  HoverOptions,
  NameAt,
} from "./oracle/hover";

// Built-in help (Shift+F1 / Ctrl+Click): usage + Oracle manual links
export { allDocPages, docFor, docUrl, functionDoc, renderDoc } from "./oracle/docs";
export { allDocEntries } from "./oracle/docs";
export type { DocContext, DocKind, OracleDocEntry } from "./oracle/docs";

// UI languages (en / ko / ja / zh)
export { ORACLE_LOCALES, docSummary, localizeDoc, localizeMessage, uiStrings } from "./oracle/i18n";
export type { DocTranslation, OracleLocale, OracleUiStrings } from "./oracle/i18n";

// Server validation (EXPLAIN PLAN, no execution)
export { createServerValidator, isServerValidatable } from "./oracle/serverValidate";
export type {
  ServerValidator,
  ServerValidatorOptions,
  ServerValidationIssue,
} from "./oracle/serverValidate";

// Dialect-agnostic building blocks
export {
  createCompletionRouter,
  createSignatureHelpRouter,
  createHoverRouter,
  createModelRouter,
} from "./core/completionRouter";
export type {
  CompletionRouter,
  SignatureHelpRouter,
  HoverRouter,
  ModelRouter,
} from "./core/completionRouter";
export type { CaseMode } from "./core/completionItems";

// Connectivity: transports (gateway / ORDS / mock)
export { OracleTransportError } from "./oracle/transport/types";
export type {
  OracleTransport,
  ExecuteRequest,
  ExecuteResponse,
  FetchResponse,
  OracleColumn,
  OracleErrorInfo,
  OracleSessionInfo,
  BindValue,
  StatementCategory,
} from "./oracle/transport/types";
export { createGatewayTransport } from "./oracle/transport/gateway";
export type {
  GatewayTransport,
  GatewayTransportOptions,
  ConnectAlias,
  LoginRequest,
  LoginResponse,
} from "./oracle/transport/gateway";
export { createOrdsTransport } from "./oracle/transport/ords";
export type { OrdsTransportOptions } from "./oracle/transport/ords";
export { createMockTransport } from "./oracle/transport/mock";
export type { MockTransport, MockTransportOptions, MockRule, MockReply } from "./oracle/transport/mock";
export { basicAuthHeader } from "./oracle/transport/auth";

// Dictionary metadata, runner, explain
export { createOracleMetadataProvider } from "./oracle/metadata";
export type { OracleMetadataOptions, OracleMetadataProvider } from "./oracle/metadata";
export { createOracleQueryRunner, OracleQueryError } from "./oracle/runner";
export type {
  OracleQueryRunner,
  OracleQueryRunnerOptions,
  RunOptions,
  RunScriptOptions,
  StatementResult,
  CompileError,
} from "./oracle/runner";
export { explainPlan } from "./oracle/explain";
export type { ExplainOptions, ExplainResult } from "./oracle/explain";
export { substitute } from "./oracle/variables";
export type { SubstitutionResult } from "./oracle/variables";
export { createQueryCache } from "./core/cache";
export type { QueryCache } from "./core/cache";

// Editor fonts (recommended monospace fonts; the host loads the files)
export { ORACLE_EDITOR_FONTS, DEFAULT_ORACLE_EDITOR_FONT } from "./oracle/fonts";
export type { OracleEditorFont } from "./oracle/fonts";
