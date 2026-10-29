import type { Monaco } from "@monaco-editor/react";
import type { languages, editor, Position, IRange } from "monaco-editor";
import { applyCase, dedupeByLabel, type CaseMode } from "../core/completionItems";
import type { OracleLanguageElements } from "./keywords";
import type { AliasInfo, CteInfo } from "../worker/protocol";
import type { SignatureSource } from "./signatures";
import type { DescribeSource } from "./hover";
import { namedArgumentItems } from "./signatureHelp";

/** Kinds of objects a metadata provider can suggest. */
export type OracleObjectKind =
  | "schema"
  | "table"
  | "view"
  | "materialized_view"
  | "synonym"
  | "column"
  | "sequence"
  | "package"
  | "procedure"
  | "function"
  | "type"
  | "dblink"
  | "variable";

/**
 * A metadata suggestion supplied by the host application
 * (e.g. a table/column from the Oracle data dictionary).
 */
export interface OracleMetadataItem {
  /** Text shown (and inserted unless `insertText` is set). */
  label: string;
  /** Object kind — drives the icon and sort order. */
  kind: OracleObjectKind;
  /** Secondary text shown to the right, e.g. "VARCHAR2(100) · HR.EMPLOYEES". */
  detail?: string;
  /** Markdown documentation (e.g. the dictionary comment). */
  documentation?: string;
  /** Overrides the inserted text (e.g. a quoted `"MixedCase"` name). */
  insertText?: string;
  /** Owning schema. */
  owner?: string;
}

/**
 * What the host's metadata provider receives. Without `contextAware` only the
 * text, position and current word are set; the context-aware worker adds the
 * parser-derived fields.
 */
export interface MetadataProviderContext {
  text: string;
  position: { line: number; column: number };
  /** The word currently being typed (before the cursor). */
  word: string;
  /** A table/view/synonym is expected here (after FROM / JOIN …). */
  expectTable?: boolean;
  /** A column / qualified reference is expected here. */
  expectColumn?: boolean;
  /** A function is expected (schema / package functions). */
  expectFunction?: boolean;
  /** A procedure call is expected (PL/SQL statement position). */
  expectProcedure?: boolean;
  /** A PL/SQL variable / INTO target is expected. */
  expectVariable?: boolean;
  /** A data type is expected (user-defined types). */
  expectType?: boolean;
  /** A database link is expected (after `@`). */
  expectDbLink?: boolean;
  /**
   * Qualifier chain typed before the caret, unquoted: `hr.` → ["hr"],
   * `e.` → ["e"], `dbms_output.` → ["dbms_output"], `:new.` → [":new"].
   */
  qualifier?: string[];
  /** Per qualifier part: was it quoted (case-sensitive)? Unquoted parts compare upper-cased. */
  qualifierQuoted?: boolean[];
  /** Tables, inline views, CTEs and PL/SQL records in scope (`alias` → `table`, maybe `@dbLink`). */
  aliases?: AliasInfo[];
  /** WITH-clause names of the statement. */
  ctes?: CteInfo[];
  /** Kind of the statement under the caret. */
  statementKind?: "sql" | "plsql" | "sqlplus" | "none";
}

export type MetadataProvider = ((
  context: MetadataProviderContext,
) => OracleMetadataItem[] | Promise<OracleMetadataItem[]>) & {
  /**
   * Optional: routine overloads for signature help and `name =>` completion
   * (`createOracleMetadataProvider` implements it with ALL_ARGUMENTS).
   */
  signatures?: SignatureSource;
  /** Optional: what a name refers to, for hovers (`createOracleMetadataProvider` implements it). */
  describe?: DescribeSource;
};

export interface CompletionOptions {
  /** Casing of inserted keywords / types. Default `preserve` (follow typing). */
  keywordCase?: CaseMode;
  /** Parameters for `name =>` suggestions inside calls (defaults to `metadataProvider.signatures`). */
  signatures?: SignatureSource;
}

/** Trigger characters shared by every Oracle completion provider. */
export const ORACLE_TRIGGER_CHARACTERS = [".", " ", "(", ","];

/** Built-in functions called without parentheses. */
const NO_PAREN_FUNCTIONS = new Set([
  "CURRENT_DATE", "CURRENT_TIMESTAMP", "LOCALTIMESTAMP", "DBTIMEZONE", "SESSIONTIMEZONE",
]);

const SORT = {
  metadata: "1",
  function: "2",
  package: "2",
  keyword: "3",
  type: "4",
} as const;

export function metadataKind(
  monaco: Monaco,
  kind: OracleObjectKind,
): languages.CompletionItemKind {
  const K = monaco.languages.CompletionItemKind;
  switch (kind) {
    case "schema": return K.Folder;
    case "table": return K.Struct;
    case "view":
    case "materialized_view": return K.Interface;
    case "synonym": return K.Reference;
    case "column": return K.Field;
    case "sequence": return K.Constant;
    case "package": return K.Module;
    case "procedure":
    case "function": return K.Function;
    case "type": return K.TypeParameter;
    case "dblink": return K.Unit;
    case "variable": return K.Variable;
    default: return K.Value;
  }
}

/**
 * Build the static Oracle completion item provider.
 *
 * Suggests built-in functions, packages, pseudo-columns, keywords and data
 * types from the configured language elements, plus optional schema metadata
 * from `metadataProvider`. De-duplicates by label and cases keywords according
 * to `keywordCase`.
 */
export function createOracleCompletionProvider(
  monaco: Monaco,
  elements: OracleLanguageElements,
  metadataProvider?: MetadataProvider,
  options: CompletionOptions = {},
): languages.CompletionItemProvider {
  const keywordCase = options.keywordCase ?? "preserve";

  return {
    triggerCharacters: ORACLE_TRIGGER_CHARACTERS,

    async provideCompletionItems(
      model: editor.ITextModel,
      position: Position,
    ): Promise<languages.CompletionList> {
      const wordInfo = model.getWordUntilPosition(position);
      const typed = wordInfo.word;
      const range: IRange = {
        startLineNumber: position.lineNumber,
        startColumn: wordInfo.startColumn,
        endLineNumber: position.lineNumber,
        endColumn: wordInfo.endColumn,
      };

      const K = monaco.languages.CompletionItemKind;
      const Snippet = monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet;
      const items: languages.CompletionItem[] = [];
      const cased = (s: string) => applyCase(s, typed, keywordCase);

      // named arguments of the call around the caret
      items.push(
        ...(await namedArgumentItems(monaco, model, position, range, options.signatures ?? metadataProvider?.signatures, typed)),
      );

      // host-supplied metadata first so it wins de-duplication
      if (metadataProvider) {
        try {
          const metas = await metadataProvider({
            text: model.getValue(),
            position: { line: position.lineNumber, column: position.column },
            word: typed,
          });
          for (const m of metas) {
            items.push({
              label: m.label,
              kind: metadataKind(monaco, m.kind),
              insertText: m.insertText ?? m.label,
              detail: m.detail ?? m.kind,
              documentation: m.documentation,
              range,
              sortText: `${SORT.metadata}-${m.label}`,
            });
          }
        } catch {
          // ignore metadata errors — keep static suggestions
        }
      }

      for (const fn of elements.functions) {
        const name = cased(fn);
        const noParen = NO_PAREN_FUNCTIONS.has(fn);
        items.push({
          label: name,
          kind: K.Function,
          insertText: noParen ? name : `${name}($0)`,
          insertTextRules: noParen ? undefined : Snippet,
          detail: "function",
          range,
          sortText: `${SORT.function}-${fn}`,
        });
      }

      for (const pkg of elements.builtinPackages) {
        const name = cased(pkg);
        items.push({
          label: name,
          kind: K.Module,
          insertText: name,
          detail: "package",
          range,
          sortText: `${SORT.package}-${pkg}`,
        });
      }

      for (const pc of elements.pseudoColumns) {
        const name = cased(pc);
        items.push({
          label: name,
          kind: K.Constant,
          insertText: name,
          detail: "pseudo-column",
          range,
          sortText: `${SORT.function}-${pc}`,
        });
      }

      for (const kw of [...elements.keywords, ...elements.plsqlKeywords]) {
        const value = cased(kw);
        items.push({
          label: value,
          kind: K.Keyword,
          insertText: value,
          detail: "keyword",
          range,
          sortText: `${SORT.keyword}-${kw}`,
        });
      }

      for (const t of elements.types) {
        const value = cased(t);
        items.push({
          label: value,
          kind: K.TypeParameter,
          insertText: value,
          detail: "type",
          range,
          sortText: `${SORT.type}-${t}`,
        });
      }

      return { suggestions: dedupeByLabel(items) };
    },
  };
}
