import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Editor, { type Monaco, type OnMount } from "@monaco-editor/react";
import type { editor, IDisposable, IRange } from "monaco-editor";
import { setupOracle } from "./oracle/setup";
import { DEFAULT_EDITOR_OPTIONS } from "./oracle/options";
import { ORACLE_DARK_THEME, ORACLE_LIGHT_THEME } from "./oracle/themes";
import { ORACLE_LANGUAGE_ID } from "./oracle/language";
import {
  resolveLanguageElements,
  type OracleLanguageElements,
  type OracleVersion,
} from "./oracle/keywords";
import { createOracleCompletionProvider, type MetadataProvider } from "./oracle/completion";
import { formatOracleSql } from "./oracle/format";
import { toExecutable, type SplitOptions, type SqlStatement } from "./oracle/splitter";
import {
  createStatementCache,
  qualifiedNameAt,
  runnable,
  statementAtPosition,
  statementsInRange,
  toggleCase,
} from "./oracle/editorStatements";
import { prettifyEditor, type Formatter } from "./core/editorActions";
import type { CaseMode } from "./core/completionItems";
import type { OracleRouters } from "./oracle/setup";
import { createOracleSignatureHelpProvider } from "./oracle/signatureHelp";
import { createOracleHoverProvider, type DescribeSource } from "./oracle/hover";
import type { SignatureSource } from "./oracle/signatures";
import {
  isServerValidatable,
  type ServerValidationIssue,
  type ServerValidator,
} from "./oracle/serverValidate";
import { injectStyles } from "./core/styles";
import { createCompletionWorker, type CompletionWorkerHandle } from "./worker/client";
import { createContextAwareCompletionProvider } from "./worker/contextProvider";
import type { ValidateMode } from "./worker/protocol";
import { localizeMessage, uiStrings, type OracleLocale, type OracleUiStrings } from "./oracle/i18n";

type ActionDescriptor = Omit<editor.IActionDescriptor, "label"> & { labelKey: keyof OracleUiStrings["actions"] };

export type OracleEditorInstance = editor.IStandaloneCodeEditor;

export interface OracleEditorProps {
  /** Controlled value. */
  value?: string;
  /** Uncontrolled initial value. */
  defaultValue?: string;
  /** Called on every content change. */
  onChange?: (value: string) => void;
  /**
   * Ctrl/Cmd+Enter: the statement under the caret, or the selected statement.
   * A selection holding several statements goes to `onRunScript` instead when
   * that is set (otherwise its first statement comes here).
   */
  onRunStatement?: (statement: SqlStatement, editor: OracleEditorInstance) => void;
  /** F5: every statement of the selection, or of the whole document. */
  onRunScript?: (statements: SqlStatement[], editor: OracleEditorInstance) => void;
  /** F10: the current SQL statement (PL/SQL and SQL*Plus commands are skipped). */
  onExplainPlan?: (statement: SqlStatement, editor: OracleEditorInstance) => void;
  /** Shift+F4: the (qualified) object name under the caret or the selected text. */
  onDescribe?: (objectName: string, editor: OracleEditorInstance) => void;
  /**
   * trino-monaco compatible alias of `onRunStatement`: receives the text to
   * send to the database (`EXEC p` arrives as `BEGIN p; END;`; SQL*Plus-only
   * commands are not passed).
   */
  onRunQuery?: (sql: string, editor: OracleEditorInstance) => void;
  /** Highlight the statement under the caret when the script has several. Default true. */
  highlightCurrentStatement?: boolean;
  /** Statement splitting options (e.g. `{ blankLine: true }`). */
  statementSeparator?: { blankLine?: boolean };
  /**
   * Errors from running statements, shown as markers: pass the runner's
   * `OracleQueryError`s and/or `StatementResult.compileErrors` (anything with
   * a 1-based line / column and a message). Replace with `[]` to clear.
   */
  executionErrors?: ExecutionMarker[];
  /** Color theme. */
  theme?: "light" | "dark";
  /** Make the editor read-only. */
  readOnly?: boolean;
  /** Override or extend the built-in language elements (completion). */
  languageElements?: Partial<OracleLanguageElements>;
  /** Highest Oracle version whose syntax is suggested. Default "19c" (minimum supported). */
  targetVersion?: OracleVersion;
  /** Casing of inserted keywords / types. Default "preserve" (follow typing). */
  keywordCase?: CaseMode;
  /**
   * Casing of inserted dictionary names (context-aware mode). Names that need
   * quoting are always inserted quoted. Default "preserve".
   */
  identifierCase?: CaseMode;
  /**
   * Context-aware completion + grammar validation via the ANTLR/c3 Web Worker:
   * suggestions follow the grammar at the caret, aliases / CTEs / PL/SQL
   * variables of the statement are offered, and the metadata provider receives
   * the caret context. Read once at mount. Default `false`.
   */
  contextAware?: boolean;
  /**
   * Grammar error markers while typing (context-aware mode only):
   * "sql" checks SQL statements, "all" also PL/SQL, `false` disables.
   * Default "sql" (the reduced PL/SQL grammar is more likely to flag valid code).
   */
  validateOnType?: ValidateMode | false;
  /**
   * Async provider for schema/table/column suggestions. When it also has
   * `signatures` / `describe` (as `createOracleMetadataProvider` does), those
   * feed signature help, `name =>` completion and hovers.
   */
  metadataProvider?: MetadataProvider;
  /** Parameter hints on `(` and `,`. Default true. */
  signatureHelp?: boolean;
  /** Hover information for names (tables, columns, routines, variables). Default true. */
  hover?: boolean;
  /**
   * Built-in help for functions, keywords, pseudo-columns, types and packages
   * (syntax, summary, example, link to the Oracle manual for `targetVersion`),
   * opened with Shift+F1 or Ctrl/Cmd+Click. Also works with `hover={false}`. Default true.
   */
  help?: boolean;
  /**
   * UI language: action labels, hovers, built-in help and grammar-check
   * messages ("en" | "ko" | "ja" | "zh"). Default "en".
   */
  locale?: OracleLocale;
  /** Routine overloads for signature help (default: `metadataProvider.signatures`). */
  signatureProvider?: SignatureSource;
  /** Name lookups for hovers (default: `metadataProvider.describe`). */
  describeProvider?: DescribeSource;
  /**
   * Validate queries / DML against the database without running them
   * (`createServerValidator`: EXPLAIN PLAN), shown as error markers.
   * DDL and PL/SQL are never sent. Off when unset.
   */
  serverValidator?: ServerValidator;
  /** Idle time before server validation runs, in ms. Default 1200. */
  serverValidateDelay?: number;
  /** Custom SQL formatter (defaults to the built-in lightweight formatter). */
  formatter?: Formatter;
  /** Extra Monaco options merged over the defaults. */
  options?: editor.IStandaloneEditorConstructionOptions;
  /**
   * CSS font-family for the code (e.g. `ORACLE_EDITOR_FONTS[i].fontFamily`).
   * Default: D2Coding Ligature with fallbacks. The page must load the font;
   * the editor re-measures glyphs once it has loaded.
   */
  fontFamily?: string;
  /** Render programming ligatures (`=>`, `!=`, `||`). Default true. */
  fontLigatures?: boolean;
  /** Editor height (CSS value or number of px). Default "100%". */
  height?: string | number;
  /** Editor width. Default "100%". */
  width?: string | number;
  /** className on the wrapper Monaco renders. */
  className?: string;
  /** Escape hatch: called after the editor mounts. */
  onMount?: (editor: OracleEditorInstance, monaco: Monaco) => void;
}

const MARKER_OWNER = "oracle-grammar";
const EXEC_MARKER_OWNER = "oracle-exec";
const SERVER_MARKER_OWNER = "oracle-server";
const SERVER_CACHE_SIZE = 500;

/** A runtime / compilation error to mark in the editor (document coordinates). */
export interface ExecutionMarker {
  line?: number;
  column?: number;
  endLine?: number;
  endColumn?: number;
  message: string;
  severity?: "error" | "warning";
  /** ORA code, shown as the marker's code. */
  code?: string;
}

const STATEMENT_CSS = `
.monaco-editor .oracle-current-statement { background: rgba(47, 111, 221, 0.06); }
.monaco-editor .oracle-current-statement-gutter { border-left: 2px solid rgba(47, 111, 221, 0.6); margin-left: 3px; }
`;

/**
 * An Oracle SQL / PL/SQL editor built on Monaco for React.
 *
 * - Registers the `oracle` language (Monarch tokenizer + config) once
 * - Light/dark Oracle themes
 * - Autocomplete routed per editor model (several editors keep their own
 *   metadata): static (keywords, functions, packages, pseudo-columns, types)
 *   or context-aware (`contextAware`: ANTLR + antlr4-c3 worker) with grammar
 *   validation markers
 * - Statement-aware actions (SQL*Plus rules: `;`, `/`, PL/SQL blocks):
 *   Run Statement (Ctrl/Cmd+Enter), Run Script (F5), Explain Plan (F10),
 *   Describe (Shift+F4), Prettify (Shift+Alt+F), Toggle Case (Ctrl/Cmd+'),
 *   Show Help (Shift+F1, Ctrl/Cmd+Click)
 * - Highlights the statement under the caret
 * - Signature help (`(`, `,`), `name =>` argument completion and hovers,
 *   from built-ins and the metadata provider's `signatures` / `describe`
 * - Optional server validation (`serverValidator`: EXPLAIN PLAN, no execution)
 */
export function OracleEditor({
  value,
  defaultValue,
  onChange,
  onRunStatement,
  onRunScript,
  onExplainPlan,
  onDescribe,
  onRunQuery,
  highlightCurrentStatement = true,
  statementSeparator,
  executionErrors,
  theme = "light",
  readOnly = false,
  languageElements,
  targetVersion = "19c",
  keywordCase = "preserve",
  identifierCase = "preserve",
  contextAware = false,
  validateOnType = "sql",
  metadataProvider,
  signatureHelp = true,
  hover = true,
  help = true,
  locale = "en",
  signatureProvider,
  describeProvider,
  serverValidator,
  serverValidateDelay = 1200,
  formatter = formatOracleSql,
  options,
  fontFamily,
  fontLigatures,
  height = "100%",
  width = "100%",
  className,
  onMount,
}: OracleEditorProps) {
  const handlers = useRef({
    onRunStatement, onRunScript, onExplainPlan, onDescribe, onRunQuery, formatter, metadataProvider,
    signatureProvider, describeProvider, serverValidator, serverValidateDelay,
  });
  handlers.current = {
    onRunStatement, onRunScript, onExplainPlan, onDescribe, onRunQuery, formatter, metadataProvider,
    signatureProvider, describeProvider, serverValidator, serverValidateDelay,
  };

  const splitOptions = useRef<SplitOptions>({});
  splitOptions.current = { blankLineSeparates: !!statementSeparator?.blankLine };
  const statementsOf = useRef(createStatementCache(() => splitOptions.current)).current;

  const highlightRef = useRef(highlightCurrentStatement);
  highlightRef.current = highlightCurrentStatement;
  const refreshHighlightRef = useRef<() => void>(() => {});

  // Stable delegator so the attached completion provider always uses the
  // LATEST metadataProvider (e.g. after the host connects to a database).
  const stableMetadata = useRef<MetadataProvider>((ctx) =>
    handlers.current.metadataProvider ? handlers.current.metadataProvider(ctx) : [],
  );
  const currentSignatures = (): SignatureSource | undefined =>
    handlers.current.signatureProvider ?? handlers.current.metadataProvider?.signatures;
  const stableSignatures = useRef<SignatureSource>((call) => currentSignatures()?.(call) ?? []);
  const currentDescribe = (): DescribeSource | undefined =>
    handlers.current.describeProvider ?? handlers.current.metadataProvider?.describe;

  const monacoRef = useRef<Monaco | null>(null);
  const editorRef = useRef<OracleEditorInstance | null>(null);
  const routerRef = useRef<OracleRouters | null>(null);
  const detachRef = useRef<(() => void) | null>(null);
  const listenersRef = useRef<IDisposable[]>([]);
  const workerRef = useRef<CompletionWorkerHandle | null>(null);
  const validateRef = useRef(validateOnType);
  validateRef.current = validateOnType;
  const versionRef = useRef(targetVersion);
  versionRef.current = targetVersion;
  const helpRef = useRef(help);
  helpRef.current = help;
  const helpRequestedAt = useRef(0);
  const localeRef = useRef(locale);
  localeRef.current = locale;
  /** Editor actions, re-registered with translated labels when `locale` changes. */
  const actionsRef = useRef<{ descriptors: ActionDescriptor[]; registered: IDisposable[] }>({ descriptors: [], registered: [] });
  const registerActions = useCallback(() => {
    const ed = editorRef.current;
    const actions = actionsRef.current;
    actions.registered.forEach((d) => d.dispose());
    if (!ed) return;
    const labels = uiStrings(localeRef.current).actions;
    actions.registered = actions.descriptors.map(({ labelKey, ...d }) => ed.addAction({ ...d, label: labels[labelKey] }));
  }, []);
  const revalidateRef = useRef<() => void>(() => {});
  const serverRevalidateRef = useRef<(reset?: boolean) => void>(() => {});

  const elements = useMemo(
    () => resolveLanguageElements(languageElements, targetVersion),
    [languageElements, targetVersion],
  );

  const monacoTheme = theme === "dark" ? ORACLE_DARK_THEME : ORACLE_LIGHT_THEME;

  const [mounted, setMounted] = useState(false);
  const mergedOptions = useMemo<editor.IStandaloneEditorConstructionOptions>(
    () => ({
      ...DEFAULT_EDITOR_OPTIONS,
      readOnly,
      ...(fontFamily ? { fontFamily } : {}),
      ...(fontLigatures !== undefined ? { fontLigatures } : {}),
      ...options,
    }),
    [readOnly, options, fontFamily, fontLigatures],
  );

  // Web fonts load after Monaco measured the fallback font: re-measure once the chosen font is ready.
  const effectiveFont = mergedOptions.fontFamily;
  useEffect(() => {
    const monaco = monacoRef.current;
    if (!monaco || !effectiveFont || typeof document === "undefined" || !document.fonts) return;
    let cancelled = false;
    const size = mergedOptions.fontSize ?? 12;
    void document.fonts
      .load(`${size}px ${effectiveFont}`)
      .catch(() => [])
      .then(() => !cancelled && monaco.editor.remeasureFonts());
    return () => {
      cancelled = true;
    };
    // mounted: run once Monaco exists.
  }, [effectiveFont, mergedOptions.fontSize, mounted]);

  /** (Re)attach this editor's completion / signature help / hover providers to its current model. */
  const attachCompletion = useCallback(() => {
    detachRef.current?.();
    detachRef.current = null;
    const monaco = monacoRef.current;
    const model = editorRef.current?.getModel();
    const router = routerRef.current;
    if (!monaco || !model || !router) return;
    const worker = workerRef.current;
    const uri = model.uri.toString();
    const signatures = stableSignatures.current;
    const hoverProvider = createOracleHoverProvider(monaco, {
      elements,
      describe: currentDescribe,
      worker: worker?.api,
      version: () => versionRef.current,
      locale: () => localeRef.current,
    });
    const detach = [
      router.attach(
        uri,
        worker
          ? createContextAwareCompletionProvider(monaco, worker.api, elements, stableMetadata.current, {
              keywordCase,
              identifierCase,
              signatures,
              targetVersion,
            })
          : createOracleCompletionProvider(monaco, elements, stableMetadata.current, { keywordCase, signatures }),
      ),
      router.signatureHelp.attach(
        uri,
        signatureHelp
          ? createOracleSignatureHelpProvider(currentSignatures, () => localeRef.current)
          : { signatureHelpTriggerCharacters: [], provideSignatureHelp: () => null },
      ),
      router.hover.attach(uri, {
        // With hover off, answer only right after an explicit help request (Shift+F1 / Ctrl+Click).
        provideHover: (model, position, token) =>
          hover || (helpRef.current && Date.now() - helpRequestedAt.current < 2000)
            ? hoverProvider.provideHover(model, position, token)
            : null,
      }),
    ];
    detachRef.current = () => detach.forEach((d) => d());
    // currentSignatures / currentDescribe only read refs.
  }, [elements, keywordCase, identifierCase, targetVersion, signatureHelp, hover]);

  const beforeMount = useCallback((monaco: Monaco) => {
    routerRef.current = setupOracle(monaco);
  }, []);

  const handleMount = useCallback<OnMount>(
    (ed, monaco) => {
      monacoRef.current = monaco;
      editorRef.current = ed;

      /** Selected statements, or the one under the caret. */
      const targetStatements = (e: editor.ICodeEditor): SqlStatement[] => {
        const model = e.getModel();
        if (!model) return [];
        const sel = e.getSelection();
        if (sel && !sel.isEmpty()) return runnable(statementsInRange(model, sel, splitOptions.current));
        const pos = e.getPosition();
        const stmt = pos && statementAtPosition(model, pos, statementsOf(model));
        return stmt ? [stmt] : [];
      };
      const addAction = (d: ActionDescriptor) => actionsRef.current.descriptors.push(d);
      actionsRef.current.descriptors = [];

      addAction({
        id: "oracle.run-statement",
        labelKey: "runStatement",
        keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter],
        contextMenuGroupId: "1_execute",
        contextMenuOrder: 1,
        run: (e) => {
          const stmts = targetStatements(e);
          if (!stmts.length) return;
          const h = handlers.current;
          const self = e as OracleEditorInstance;
          if (stmts.length > 1 && h.onRunScript) {
            h.onRunScript(stmts, self);
            return;
          }
          h.onRunStatement?.(stmts[0], self);
          const sql = toExecutable(stmts[0]);
          if (sql !== undefined) h.onRunQuery?.(sql, self);
        },
      });

      addAction({
        id: "oracle.run-script",
        labelKey: "runScript",
        keybindings: [monaco.KeyCode.F5],
        contextMenuGroupId: "1_execute",
        contextMenuOrder: 2,
        run: (e) => {
          const model = e.getModel();
          if (!model) return;
          const sel = e.getSelection();
          const stmts = runnable(
            sel && !sel.isEmpty()
              ? statementsInRange(model, sel, splitOptions.current)
              : statementsOf(model),
          );
          if (stmts.length) handlers.current.onRunScript?.(stmts, e as OracleEditorInstance);
        },
      });

      addAction({
        id: "oracle.explain-plan",
        labelKey: "explainPlan",
        keybindings: [monaco.KeyCode.F10],
        contextMenuGroupId: "1_execute",
        contextMenuOrder: 3,
        run: (e) => {
          const stmt = targetStatements(e).find((s) => s.kind === "sql");
          if (stmt) handlers.current.onExplainPlan?.(stmt, e as OracleEditorInstance);
        },
      });

      addAction({
        id: "oracle.describe",
        labelKey: "describe",
        keybindings: [monaco.KeyMod.Shift | monaco.KeyCode.F4],
        contextMenuGroupId: "1_execute",
        contextMenuOrder: 4,
        run: (e) => {
          const model = e.getModel();
          const sel = e.getSelection();
          const pos = e.getPosition();
          if (!model || !pos) return;
          const selected = sel && !sel.isEmpty() ? model.getValueInRange(sel).trim() : "";
          const name = selected && !selected.includes("\n") ? selected : qualifiedNameAt(model, pos);
          if (name) handlers.current.onDescribe?.(name, e as OracleEditorInstance);
        },
      });

      addAction({
        id: "oracle.prettify",
        labelKey: "prettify",
        keybindings: [monaco.KeyMod.Shift | monaco.KeyMod.Alt | monaco.KeyCode.KeyF],
        contextMenuGroupId: "2_modification",
        contextMenuOrder: 1,
        run: async (e) => {
          await prettifyEditor(e, handlers.current.formatter, "oracle-prettify");
        },
      });

      addAction({
        id: "oracle.toggle-case",
        labelKey: "toggleCase",
        keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.Quote],
        contextMenuGroupId: "2_modification",
        contextMenuOrder: 2,
        run: (e) => {
          const model = e.getModel();
          const pos = e.getPosition();
          if (!model || !pos) return;
          let range: IRange | null = e.getSelection();
          if (!range || (range.startLineNumber === range.endLineNumber && range.startColumn === range.endColumn)) {
            const word = model.getWordAtPosition(pos);
            if (!word) return;
            range = { startLineNumber: pos.lineNumber, endLineNumber: pos.lineNumber, startColumn: word.startColumn, endColumn: word.endColumn };
          }
          e.executeEdits("oracle-toggle-case", [{ range, text: toggleCase(model.getValueInRange(range)) }]);
        },
      });

      // Built-in help: Shift+F1 on the word at the caret, or Ctrl/Cmd+Click on a word.
      const showHelp = (e: editor.ICodeEditor) => {
        if (!helpRef.current) return;
        helpRequestedAt.current = Date.now();
        e.trigger("oracle-help", "editor.action.showHover", { focus: false });
      };
      addAction({
        id: "oracle.show-help",
        labelKey: "showHelp",
        keybindings: [monaco.KeyMod.Shift | monaco.KeyCode.F1],
        contextMenuGroupId: "1_execute",
        contextMenuOrder: 5,
        run: (e) => showHelp(e),
      });
      registerActions();
      listenersRef.current.push(
        ed.onMouseUp((m) => {
          const ev = m.event;
          if (!(ev.ctrlKey || ev.metaKey) || ev.shiftKey || ev.altKey || !m.target.position) return;
          if (m.target.type !== monaco.editor.MouseTargetType.CONTENT_TEXT) return;
          ed.setPosition(m.target.position);
          showHelp(ed);
        }),
      );

      // Current-statement highlight.
      injectStyles("oracle-monaco-styles", STATEMENT_CSS);
      const decorations = ed.createDecorationsCollection();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const refresh = () => {
        const model = ed.getModel();
        const pos = ed.getPosition();
        const all = model ? statementsOf(model) : [];
        const stmt =
          highlightRef.current && model && pos && runnable(all).length > 1
            ? statementAtPosition(model, pos, all)
            : undefined;
        decorations.set(
          stmt
            ? [{
                range: new monaco.Range(stmt.startLine, 1, stmt.endLine, 1),
                options: {
                  isWholeLine: true,
                  className: "oracle-current-statement",
                  linesDecorationsClassName: "oracle-current-statement-gutter",
                },
              }]
            : [],
        );
      };
      const schedule = () => {
        clearTimeout(timer);
        timer = setTimeout(refresh, 50);
      };
      refreshHighlightRef.current = schedule;
      listenersRef.current.push(
        ed.onDidChangeCursorPosition(schedule),
        ed.onDidChangeModelContent(schedule),
        { dispose: () => { clearTimeout(timer); decorations.clear(); } },
      );
      schedule();

      if (contextAware) {
        const worker = createCompletionWorker();
        workerRef.current = worker;

        // Grammar validation markers (debounced).
        let validateTimer: ReturnType<typeof setTimeout> | undefined;
        const validate = async () => {
          const model = ed.getModel();
          if (!model) return;
          const mode = validateRef.current;
          if (!mode) {
            monaco.editor.setModelMarkers(model, MARKER_OWNER, []);
            return;
          }
          const version = model.getVersionId();
          try {
            const errors = await worker.api.validateGrammar(model.getValue(), mode, versionRef.current);
            if (model.isDisposed() || model.getVersionId() !== version) return; // stale
            monaco.editor.setModelMarkers(
              model,
              MARKER_OWNER,
              errors.map((err) => ({
                severity: err.severity === "warning" ? monaco.MarkerSeverity.Warning : monaco.MarkerSeverity.Error,
                message: localizeMessage(err.message, localeRef.current),
                startLineNumber: err.line,
                startColumn: err.column,
                endLineNumber: err.line,
                endColumn: err.endColumn,
              })),
            );
          } catch {
            /* ignore transient worker errors */
          }
        };
        const scheduleValidate = () => {
          clearTimeout(validateTimer);
          validateTimer = setTimeout(validate, 250);
        };
        revalidateRef.current = scheduleValidate;
        listenersRef.current.push(
          ed.onDidChangeModelContent(scheduleValidate),
          ed.onDidChangeModel(scheduleValidate),
          {
            dispose: () => {
              clearTimeout(validateTimer);
              const model = ed.getModel();
              if (model && !model.isDisposed()) monaco.editor.setModelMarkers(model, MARKER_OWNER, []);
            },
          },
        );
        scheduleValidate();
      }

      // Server validation (EXPLAIN PLAN of queries / DML), debounced, cached by statement text.
      const serverCache = new Map<string, ServerValidationIssue | null>();
      let serverTimer: ReturnType<typeof setTimeout> | undefined;
      let serverRound: AbortController | null = null;
      const renderServerMarkers = (model: editor.ITextModel, stmts: SqlStatement[]) => {
        const markers: editor.IMarkerData[] = [];
        for (const s of stmts) {
          const issue = serverCache.get(s.text);
          if (!issue) continue;
          const start = model.getPositionAt(s.startOffset + issue.offset);
          const end = model.getPositionAt(s.startOffset + issue.offset + issue.length);
          markers.push({
            severity: monaco.MarkerSeverity.Error,
            message: issue.message,
            code: issue.code,
            source: "Oracle",
            startLineNumber: start.lineNumber,
            startColumn: start.column,
            endLineNumber: end.lineNumber,
            endColumn: end.column,
          });
        }
        monaco.editor.setModelMarkers(model, SERVER_MARKER_OWNER, markers);
      };
      const serverValidate = async () => {
        serverRound?.abort();
        const model = ed.getModel();
        if (!model) return;
        const validator = handlers.current.serverValidator;
        if (!validator) {
          monaco.editor.setModelMarkers(model, SERVER_MARKER_OWNER, []);
          return;
        }
        const round = (serverRound = new AbortController());
        const version = model.getVersionId();
        const stmts = runnable(statementsOf(model)).filter(isServerValidatable);
        renderServerMarkers(model, stmts);
        // Statements with client-side syntax errors are not worth a round trip.
        const badLines = new Set(
          monaco.editor
            .getModelMarkers({ resource: model.uri, owner: MARKER_OWNER })
            .filter((m) => m.severity === monaco.MarkerSeverity.Error)
            .map((m) => m.startLineNumber),
        );
        for (const s of stmts) {
          if (serverCache.has(s.text)) continue;
          let broken = false;
          for (let l = s.startLine; l <= s.endLine && !broken; l++) broken = badLines.has(l);
          if (broken) continue;
          const issue = await validator(s, round.signal).catch(() => undefined);
          if (round.signal.aborted || model.isDisposed() || model.getVersionId() !== version) return;
          if (issue === undefined) continue;
          if (serverCache.size >= SERVER_CACHE_SIZE) serverCache.delete(serverCache.keys().next().value!);
          serverCache.set(s.text, issue);
          renderServerMarkers(model, stmts);
        }
      };
      const scheduleServer = (reset = false) => {
        if (reset) serverCache.clear();
        clearTimeout(serverTimer);
        serverTimer = setTimeout(serverValidate, handlers.current.serverValidateDelay);
      };
      serverRevalidateRef.current = scheduleServer;
      listenersRef.current.push(
        ed.onDidChangeModelContent(() => {
          serverRound?.abort();
          scheduleServer();
        }),
        ed.onDidChangeModel(() => scheduleServer()),
        {
          dispose: () => {
            clearTimeout(serverTimer);
            serverRound?.abort();
            const model = ed.getModel();
            if (model && !model.isDisposed()) monaco.editor.setModelMarkers(model, SERVER_MARKER_OWNER, []);
          },
        },
      );
      scheduleServer();

      attachCompletion();
      listenersRef.current.push(
        ed.onDidChangeModel(() => {
          attachCompletion();
          schedule();
        }),
      );

      setMounted(true);
      onMount?.(ed, monaco);
    },
    // attachCompletion is read at mount; later changes are applied by the effect below.
    [onMount],
  );

  // Apply languageElements / targetVersion / case / signatureHelp / hover changes after mount.
  useEffect(() => {
    if (editorRef.current) attachCompletion();
  }, [attachCompletion]);

  // Execution / compilation error markers.
  useEffect(() => {
    const monaco = monacoRef.current;
    const model = editorRef.current?.getModel();
    if (!monaco || !model) return;
    monaco.editor.setModelMarkers(
      model,
      EXEC_MARKER_OWNER,
      (executionErrors ?? [])
        .filter((e) => e.line)
        .map((e) => {
          const line = Math.min(e.line!, model.getLineCount());
          const column = e.column ?? 1;
          const endColumn = e.endColumn ?? (model.getWordAtPosition({ lineNumber: line, column })?.endColumn ?? column + 1);
          return {
            severity: e.severity === "warning" ? monaco.MarkerSeverity.Warning : monaco.MarkerSeverity.Error,
            message: e.message,
            ...(e.code ? { code: e.code } : {}),
            startLineNumber: line,
            startColumn: column,
            endLineNumber: e.endLine ?? line,
            endColumn: Math.max(endColumn, column + 1),
          };
        }),
    );
  }, [executionErrors, mounted]);

  // Re-validate when the validation mode, target version or language changes.
  useEffect(() => {
    revalidateRef.current();
  }, [validateOnType, targetVersion, locale]);

  // Translated action labels (context menu / command palette).
  useEffect(() => {
    registerActions();
  }, [locale, registerActions]);

  // A new validator (other connection / schema) invalidates every server result.
  useEffect(() => {
    serverRevalidateRef.current(true);
  }, [serverValidator]);

  // Re-evaluate the highlight when its props change.
  useEffect(() => {
    refreshHighlightRef.current();
  }, [highlightCurrentStatement, statementSeparator?.blankLine]);

  // Detach provider / listeners on unmount.
  useEffect(() => {
    return () => {
      listenersRef.current.forEach((d) => d.dispose());
      listenersRef.current = [];
      workerRef.current?.dispose();
      workerRef.current = null;
      detachRef.current?.();
      detachRef.current = null;
    };
  }, []);

  return (
    <Editor
      language={ORACLE_LANGUAGE_ID}
      theme={monacoTheme}
      value={value}
      defaultValue={defaultValue}
      defaultLanguage={ORACLE_LANGUAGE_ID}
      onChange={(v) => onChange?.(v ?? "")}
      beforeMount={beforeMount}
      onMount={handleMount}
      options={mergedOptions}
      height={height}
      width={width}
      className={className}
      loading={<div style={{ padding: 12, fontFamily: "sans-serif" }}>Loading editor…</div>}
    />
  );
}

export default OracleEditor;
