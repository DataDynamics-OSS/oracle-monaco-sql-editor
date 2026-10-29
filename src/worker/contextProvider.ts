/**
 * Context-aware Monaco completion provider.
 *
 * Calls the worker for the parser-derived caret context, then expands it into
 * concrete Monaco completion items:
 *   - names the statement declares: table aliases, CTEs, inline-view / cursor
 *     columns, PL/SQL variables, parameters and loop records
 *   - `expectColumn`    -> + pseudo-columns (ROWNUM, LEVEL, SYSDATE, …)
 *   - `expectFunction`  -> built-in functions + Oracle-supplied packages
 *   - `expectProcedure` -> Oracle-supplied packages
 *   - `expectType`      -> built-in types + declared PL/SQL types
 *   - grammar-valid keywords (cased by `keywordCase`)
 *   - schema objects via the host `metadataProvider` (tables, columns,
 *     synonyms, package members, types, db links), inserted with Oracle
 *     quoting rules and `identifierCase`
 *   - `x.` qualifier    -> only members of x (columns of an alias / record,
 *     objects of a schema, members of a package)
 */
import type { Monaco } from "@monaco-editor/react";
import type { languages, editor, Position, IRange } from "monaco-editor";
import type { Remote } from "comlink";
import type { CompletionWorkerApi, OracleCaretContext, TargetVersion } from "./protocol.js";
import type { OracleLanguageElements } from "../oracle/keywords.js";
import {
  ORACLE_TRIGGER_CHARACTERS,
  metadataKind,
  type MetadataProvider,
} from "../oracle/completion.js";
import { renderIdent, sameIdent } from "../oracle/identifiers.js";
import { applyCase, dedupeByLabel, type CaseMode } from "../core/completionItems.js";
import { namedArgumentItems } from "../oracle/signatureHelp.js";
import type { SignatureSource } from "../oracle/signatures.js";

export interface ContextCompletionOptions {
  /** Casing of inserted keywords / built-ins. Default `preserve` (follow typing). */
  keywordCase?: CaseMode;
  /** Casing of inserted dictionary names. Default `preserve`. */
  identifierCase?: CaseMode;
  /** Parameters for `name =>` suggestions inside calls (defaults to `metadataProvider.signatures`). */
  signatures?: SignatureSource;
  /** Hide keywords of syntax newer than this version. Default: all the grammar knows. */
  targetVersion?: TargetVersion;
}

/** Built-in functions called without parentheses. */
const NO_PAREN_FUNCTIONS = new Set([
  "CURRENT_DATE", "CURRENT_TIMESTAMP", "LOCALTIMESTAMP", "DBTIMEZONE", "SESSIONTIMEZONE",
]);

/** Whether the host metadata provider has anything to add at this caret. */
function wantsMetadata(ctx: OracleCaretContext): boolean {
  return (
    ctx.qualifier.length > 0 ||
    ctx.expectTable ||
    ctx.expectColumn ||
    ctx.expectFunction ||
    ctx.expectProcedure ||
    ctx.expectType ||
    ctx.expectDbLink
  );
}

export function createContextAwareCompletionProvider(
  monaco: Monaco,
  api: Remote<CompletionWorkerApi>,
  elements: OracleLanguageElements,
  metadataProvider?: MetadataProvider,
  options: ContextCompletionOptions = {},
): languages.CompletionItemProvider {
  const K = monaco.languages.CompletionItemKind;
  const Snippet = monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet;
  const keywordCase = options.keywordCase ?? "preserve";
  const identifierCase = options.identifierCase ?? "preserve";

  return {
    triggerCharacters: ORACLE_TRIGGER_CHARACTERS,

    async provideCompletionItems(
      model: editor.ITextModel,
      position: Position,
    ): Promise<languages.CompletionList> {
      const text = model.getValue();
      const ctx = await api.getCaretContext(
        text,
        { line: position.lineNumber, column: position.column },
        { version: options.targetVersion },
      );

      const wordInfo = model.getWordUntilPosition(position);
      const typed = ctx.partialWord || wordInfo.word;
      const range: IRange = {
        startLineNumber: position.lineNumber,
        startColumn: wordInfo.startColumn,
        endLineNumber: position.lineNumber,
        endColumn: wordInfo.endColumn,
      };

      const items: languages.CompletionItem[] = [];
      const add = (
        label: string,
        kind: languages.CompletionItemKind,
        detail: string,
        sort: string,
        extra: Partial<languages.CompletionItem> = {},
      ) => items.push({ label, kind, detail, insertText: label, range, sortText: `${sort}-${label}`, ...extra });
      const builtin = (s: string) => applyCase(s, typed, keywordCase);
      const name = (s: string) => renderIdent(s, typed, identifierCase);

      const q = ctx.qualifier;
      const last = q[q.length - 1];
      let localColumns = false;

      if (q.length) {
        // `x.` where x is something the statement defines with known columns.
        const alias = ctx.aliases.find((a) => sameIdent(a.alias, last));
        if (alias?.columns && q.length === 1) {
          localColumns = true;
          for (const c of alias.columns) add(c, K.Field, `column · ${alias.alias}`, "0");
        }
      } else {
        if (ctx.expectColumn || ctx.expectFunction) {
          const signatures = options.signatures ?? metadataProvider?.signatures;
          items.push(...(await namedArgumentItems(monaco, model, position, range, signatures, typed)));
        }
        if (ctx.expectColumn) {
          for (const a of ctx.aliases) {
            if (a.alias.startsWith(":")) continue; // :NEW / :OLD are typed with their colon
            add(a.alias, K.Variable, a.kind === "table" ? `alias · ${a.table}` : a.kind, "0");
          }
          for (const pc of elements.pseudoColumns) add(builtin(pc), K.Constant, "pseudo-column", "2");
        }
        if (ctx.expectColumn || ctx.expectVariable || ctx.expectProcedure) {
          for (const s of ctx.plsql) {
            if (s.kind === "exception" || s.kind === "type") continue;
            add(s.name, K.Variable, s.type ? `${s.kind} · ${s.type}` : s.kind, "0");
          }
        }
        if (ctx.expectTable) {
          for (const c of ctx.ctes) add(c.name, K.Struct, "cte", "0");
        }
        if (ctx.expectFunction) {
          for (const fn of elements.functions) {
            const label = builtin(fn);
            const noParen = NO_PAREN_FUNCTIONS.has(fn);
            add(label, K.Function, "function", "2", noParen ? {} : { insertText: `${label}($0)`, insertTextRules: Snippet });
          }
        }
        if (ctx.expectFunction || ctx.expectProcedure) {
          for (const pkg of elements.builtinPackages) add(builtin(pkg), K.Module, "package", "2");
        }
        if (ctx.expectType) {
          for (const t of elements.types) add(builtin(t), K.TypeParameter, "type", "4");
          for (const s of ctx.plsql) if (s.kind === "type") add(s.name, K.TypeParameter, "type", "0");
        }
        if (ctx.expectProcedure || ctx.expectVariable) {
          for (const s of ctx.plsql) if (s.kind === "exception") add(s.name, K.Event, "exception", "0");
        }
      }

      // Schema objects from the host.
      if (metadataProvider && !localColumns && wantsMetadata(ctx)) {
        try {
          const metas = await metadataProvider({
            text,
            position: { line: position.lineNumber, column: position.column },
            word: typed,
            expectTable: ctx.expectTable,
            expectColumn: ctx.expectColumn,
            expectFunction: ctx.expectFunction,
            expectProcedure: ctx.expectProcedure,
            expectVariable: ctx.expectVariable,
            expectType: ctx.expectType,
            expectDbLink: ctx.expectDbLink,
            qualifier: ctx.qualifier,
            qualifierQuoted: ctx.qualifierQuoted,
            aliases: ctx.aliases,
            ctes: ctx.ctes,
            statementKind: ctx.statementKind,
          });
          for (const m of metas) {
            add(m.label, metadataKind(monaco, m.kind), m.detail ?? m.kind, "1", {
              insertText: m.insertText ?? name(m.label),
              documentation: m.documentation,
            });
          }
        } catch {
          /* keep going with local suggestions */
        }
      }

      // Keywords last so a schema name that equals a keyword (a TYPE column) wins de-duplication.
      if (!q.length) for (const kw of ctx.keywords) add(builtin(kw), K.Keyword, "keyword", "3");

      return { suggestions: dedupeByLabel(items) };
    },
  };
}
