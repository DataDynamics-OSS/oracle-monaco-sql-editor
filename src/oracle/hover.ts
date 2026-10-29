/**
 * Hover: what the name under the mouse is.
 *
 *   e / e.salary         alias → table, column type / NOT NULL / comment
 *   hr.employees         table / view (comment, columns), synonym target
 *   pkg.proc / nvl       routine signatures (dictionary or built-in)
 *   v_total              PL/SQL variable / parameter with its declared type
 *   emp_seq              sequence properties
 *   NVL( / CONNECT / LOOP built-in help: syntax, summary, example, manual link
 *
 * Names resolve through a `DescribeSource` (the dictionary metadata
 * provider's `describe`); aliases and PL/SQL declarations come from the
 * context-aware worker when it is running. Built-in functions and packages
 * need neither.
 */
import type { Monaco } from "@monaco-editor/react";
import type { editor, IRange, languages, Position } from "monaco-editor";
import type { Remote } from "comlink";
import type { OracleObjectKind } from "./completion";
import { ORACLE_RESERVED_WORDS, type OracleLanguageElements, type OracleVersion } from "./keywords";
import { signatureLabel, type OracleSignature } from "./signatures";
import { docFor, docUrl, renderDoc } from "./docs";
import { uiStrings, type OracleLocale } from "./i18n";
import { scan } from "./scanner";
import { splitStatements } from "./splitter";
import { sameIdent } from "./identifiers";
import type { AliasInfo, CompletionWorkerApi, OracleCaretContext } from "../worker/protocol";

/** A (prefix of a) qualified name to describe: `hr.employees` → parts ["hr", "employees"]. */
export interface DescribeTarget {
  /** Name parts as written, unquoted. */
  parts: string[];
  /** Per part: quoted identifier (case-sensitive)? */
  quoted: boolean[];
  /** `emp@prod` */
  dbLink?: string;
  /** Tables / CTEs / records of the statement (context-aware mode), so `e.x` resolves through alias `e`. */
  aliases?: AliasInfo[];
}

export interface OracleColumnInfo {
  name: string;
  /** `VARCHAR2(25 CHAR)`, `NUMBER(8,2)` … */
  type: string;
  nullable: boolean;
  comment?: string;
}

/** What a name refers to. */
export interface OracleObjectInfo {
  kind: OracleObjectKind;
  /** Dictionary name. */
  name: string;
  owner?: string;
  /** Dictionary object type (`TABLE`, `PACKAGE`, …). */
  objectType?: string;
  /** `VALID` / `INVALID`. */
  status?: string;
  comment?: string;
  /** Columns: data type, nullability, and the owning table (`HR.EMPLOYEES`). */
  dataType?: string;
  nullable?: boolean;
  parent?: string;
  /** Reached through this synonym (`PUBLIC.EMP`). */
  synonym?: string;
  dbLink?: string;
  /** The alias the user hovered (`e` → HR.EMPLOYEES). */
  alias?: string;
  /** Table / view columns (possibly truncated). */
  columns?: OracleColumnInfo[];
  /** Package members (names). */
  members?: string[];
  /** Routine overloads. */
  signatures?: OracleSignature[];
  /** Extra facts shown as a list (sequence settings …). */
  properties?: [string, string][];
}

export type DescribeSource = (
  target: DescribeTarget,
) => OracleObjectInfo | undefined | Promise<OracleObjectInfo | undefined>;

// ---------------------------------------------------------------- rendering

const code = (s: string) => "`" + s.replace(/`/g, "'") + "`";

/** Markdown for a hover / documentation panel, in `locale`. */
export function renderObjectInfo(info: OracleObjectInfo, maxColumns = 30, locale?: OracleLocale): string {
  const t = uiStrings(locale);
  const kind = t.objectKind[info.kind] ?? info.kind;
  const qualified = info.owner && info.kind !== "column" && info.kind !== "schema" ? `${info.owner}.${info.name}` : info.name;
  const out: string[] = [];

  if (info.kind === "column") {
    const type = info.dataType ? ` ${info.dataType}${info.nullable === false ? " NOT NULL" : ""}` : "";
    out.push(`${code(`${info.name}${type}`)} — ${info.parent ? t.columnOf(code(info.parent)) : t.objectKind.column}`);
  } else {
    let head = `${code(qualified + (info.dbLink ? `@${info.dbLink}` : ""))} — ${kind}`;
    if (info.alias) head = `${code(info.alias)} → ${head}`;
    if (info.status && info.status !== "VALID") head += ` **(${info.status})**`;
    out.push(head);
  }
  if (info.synonym) out.push(t.viaSynonym(code(info.synonym)));
  if (info.comment) out.push(info.comment);

  for (const sig of info.signatures ?? []) {
    out.push("```oracle\n" + signatureLabel(sig).label + "\n```");
    if (sig.documentation) out.push(sig.documentation);
  }

  if (info.columns?.length) {
    const shown = info.columns.slice(0, maxColumns);
    const rows = shown.map((c) => `| ${c.name} | ${c.type}${c.nullable ? "" : " NOT NULL"} |`);
    out.push([`| ${t.columnHeader} | ${t.typeHeader} |`, "|---|---|", ...rows].join("\n"));
    if (info.columns.length > shown.length) out.push(t.moreColumns(info.columns.length - shown.length));
  }
  if (info.members?.length) {
    const shown = info.members.slice(0, 40);
    out.push(`${t.members}: ${shown.map(code).join(", ")}${info.members.length > shown.length ? ", …" : ""}`);
  }
  if (info.properties?.length) out.push(info.properties.map(([k, v]) => `- ${t.sequenceProperty[k] ?? k}: ${code(v)}`).join("\n"));
  return out.join("\n\n");
}

// ---------------------------------------------------------------- name at position

export interface NameAt {
  parts: string[];
  quoted: boolean[];
  dbLink?: string;
  /** Index of the part under the position. */
  index: number;
  /** 1-based columns of each part on its line. */
  ranges: { start: number; end: number }[];
  /** A `(` follows the name (a call). */
  call: boolean;
}

const PART = String.raw`"[^"]+"|[A-Za-z][\w$#]*`;

/**
 * The qualified name on `line` covering 1-based `column`, with the part the
 * column is on: `hr.emp.sal` at "emp" → index 1.
 */
export function nameAtColumn(line: string, column: number): NameAt | undefined {
  const re = new RegExp(`(?:${PART})(?:\\s*\\.\\s*(?:${PART}))*(?:@[A-Za-z][\\w$#]*(?:\\.[A-Za-z][\\w$#]*)*)?`, "g");
  const col = column - 1;
  for (const m of line.matchAll(re)) {
    const start = m.index!;
    if (col < start || col >= start + m[0].length) continue;
    if (start > 0 && /[\w$#:&]/.test(line[start - 1])) continue; // bind / substitution variable or mid-word
    const at = m[0].search(/@(?=(?:[^"]*"[^"]*")*[^"]*$)/);
    const namePart = at >= 0 ? m[0].slice(0, at) : m[0];
    const parts: string[] = [];
    const quoted: boolean[] = [];
    const ranges: { start: number; end: number }[] = [];
    for (const p of namePart.matchAll(new RegExp(PART, "g"))) {
      const q = p[0].startsWith('"');
      parts.push(q ? p[0].slice(1, -1) : p[0]);
      quoted.push(q);
      ranges.push({ start: start + p.index! + 1, end: start + p.index! + p[0].length + 1 });
    }
    let index = ranges.findIndex((r) => column >= r.start && column < r.end);
    if (index < 0) index = parts.length - 1; // on a dot or the @link part
    const call = /^\s*\(/.test(line.slice(start + m[0].length));
    return { parts, quoted, ...(at >= 0 ? { dbLink: m[0].slice(at + 1).toUpperCase() } : {}), index, ranges, call };
  }
  return undefined;
}

const RESERVED = new Set(ORACLE_RESERVED_WORDS);

/** The next few words (and `;`) after `offset`, upper-case: context for multi-word keywords. */
function wordsAfter(text: string, offset: number, n = 4): string[] {
  return (text.slice(offset, offset + 200).match(/[A-Za-z_][\w$#]*|;/g) ?? []).slice(0, n).map((w) => w.toUpperCase());
}

/** Whether `offset` is inside a string, comment or hint. */
function inLiteral(text: string, offset: number): boolean {
  return scan(text).some((s) => s.type !== "code" && s.type !== "quotedIdent" && offset >= s.start && offset < s.end);
}

// ---------------------------------------------------------------- provider

export interface HoverOptions {
  elements: OracleLanguageElements;
  /** Release the manual links point to (default 19c). */
  version?: () => OracleVersion | undefined;
  /** Language of the hover text (default English). */
  locale?: () => OracleLocale | undefined;
  /** Dictionary lookups (e.g. `createOracleMetadataProvider(...).describe`). */
  describe?: () => DescribeSource | undefined;
  /** Context-aware worker for aliases and PL/SQL declarations. */
  worker?: Remote<CompletionWorkerApi>;
}

/** Hover info for the name at `position` (no Monaco types: testable). */
export async function hoverInfo(
  text: string,
  lineText: string,
  position: { line: number; column: number },
  offset: number,
  options: HoverOptions,
): Promise<{ markdown: string; start: number; end: number } | undefined> {
  const name = nameAtColumn(lineText, position.column);
  if (!name || inLiteral(text, offset)) return undefined;
  const parts = name.parts.slice(0, name.index + 1);
  const quoted = name.quoted.slice(0, name.index + 1);
  const range = name.ranges[name.index];
  const done = (markdown: string | undefined) => (markdown ? { markdown, start: range.start, end: range.end } : undefined);
  const word = parts[parts.length - 1];
  const upper = word.toUpperCase();
  const els = options.elements;
  const version = options.version?.() ?? "19c";
  const locale = options.locale?.();
  const t = uiStrings(locale);
  const cols = (c?: string[]) => (c?.length ? `\n\n${t.columns}: ${c.map(code).join(", ")}` : "");

  let ctx: OracleCaretContext | undefined;
  if (options.worker) {
    try {
      ctx = await options.worker.getCaretContext(text, { line: position.line, column: range.end });
    } catch {
      /* hover without statement scope */
    }
  }

  let help: ReturnType<typeof docFor>;
  if (parts.length === 1 && !quoted[0] && !name.dbLink) {
    // Declared in the statement: PL/SQL symbols, CTEs.
    const sym = ctx?.plsql.find((s) => sameIdent(s.name, word));
    if (sym) return done(`${code(sym.type ? `${sym.name} ${sym.type}` : sym.name)} — ${t.plsqlSymbol[sym.kind] ?? `PL/SQL ${sym.kind}`}`);
    const cte = ctx?.ctes.find((c) => sameIdent(c.name, word));
    if (cte) return done(`${code(cte.name)} — ${t.cte}${cols(cte.columns)}`);
    const local = ctx?.aliases.find((a) => sameIdent(a.alias, word) && a.kind !== "table");
    if (local) {
      const what = local.kind === "record" ? t.record : local.kind === "cte" ? t.cte : t.inlineView;
      return done(`${code(local.alias)} — ${what}${cols(local.columns)}`);
    }
    // Built-in help: functions called here, keywords, pseudo-columns.
    const wordEnd = offset + (range.end - position.column);
    const plsql = ctx
      ? ctx.statementKind === "plsql"
      : splitStatements(text).find((st) => offset >= st.startOffset && offset <= st.endOffset)?.kind === "plsql";
    help = docFor(word, {
      next: wordsAfter(text, wordEnd),
      plsql,
      call: name.call,
      afterPercent: lineText[range.start - 2] === "%",
    });
    const keyword =
      RESERVED.has(upper) || els.keywords.includes(upper) || els.plsqlKeywords.includes(upper) || els.operators.includes(upper);
    if (help && ((help.kind === "function" && name.call) || (keyword && help.kind !== "package"))) {
      return done(renderDoc(help, version, locale));
    }
    if (els.pseudoColumns.includes(upper) && !ctx?.aliases.some((a) => sameIdent(a.alias, word))) {
      return done(help ? renderDoc(help, version, locale) : `${code(upper)} — ${t.docKind["pseudo-column"]}`);
    }
  }
  // `x.y` where x is a CTE / inline view / record with known columns.
  if (parts.length === 2 && ctx) {
    const a = ctx.aliases.find((x) => sameIdent(x.alias, parts[0]));
    if (a?.columns) return done(`${code(word)} — ${t.columnOf(code(a.alias))}`);
  }

  const describe = options.describe?.();
  if (describe) {
    try {
      const info = await describe({ parts, quoted, ...(name.dbLink && name.index === name.parts.length - 1 ? { dbLink: name.dbLink } : {}), aliases: ctx?.aliases });
      if (info) {
        // Oracle-supplied packages: dictionary members plus the manual link.
        const link = help?.kind === "package" && help.page ? `\n\n[${t.documentation(version)}](${docUrl(help.page, version)})` : "";
        return done(renderObjectInfo(info, 30, locale) + link);
      }
    } catch {
      /* fall through to built-in knowledge */
    }
  }
  if (help) return done(renderDoc(help, version, locale));
  if (parts.length === 1 && !quoted[0] && els.builtinPackages.includes(upper)) {
    return done(`${code(upper)} — ${t.docKind.package}`);
  }
  return undefined;
}

export function createOracleHoverProvider(monaco: Monaco, options: HoverOptions): languages.HoverProvider {
  return {
    async provideHover(model: editor.ITextModel, position: Position) {
      const result = await hoverInfo(
        model.getValue(),
        model.getLineContent(position.lineNumber),
        { line: position.lineNumber, column: position.column },
        model.getOffsetAt(position),
        options,
      );
      if (!result) return null;
      const range: IRange = new monaco.Range(position.lineNumber, result.start, position.lineNumber, result.end);
      return { range, contents: [{ value: result.markdown }] };
    },
  };
}
