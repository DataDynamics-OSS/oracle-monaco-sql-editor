/**
 * Context-aware completion core for Oracle SQL / PL/SQL.
 *
 * Finds the statement under the caret (splitter.ts), lexes & parses only that
 * statement with the generated ANTLR parser, then uses antlr4-c3
 * (CodeCompletionCore) to compute — from the grammar's ATN — which keywords
 * and which kinds of names are valid at the caret ("after FROM expect a
 * table", "after `e.` expect columns of alias e", "in a PL/SQL statement
 * expect a procedure or variable"). It also collects what the statement
 * itself declares: table aliases, CTEs, inline views, cursors, PL/SQL
 * variables and loop records.
 *
 * Pure logic (no Worker/DOM APIs) so it can be unit-tested in Node and reused
 * by the Web Worker.
 */
import {
  CharStream,
  CommonTokenStream,
  Token,
  BaseErrorListener,
  ParserRuleContext,
  type Recognizer,
  type ATNSimulator,
} from "antlr4ng";
import { CodeCompletionCore } from "antlr4-c3";
import { OracleSqlLexer } from "../generated/OracleSqlLexer.js";
import {
  OracleSqlParser,
  CreateIndexStatementContext,
  CreateTriggerContext,
  CursorDeclarationContext,
  DeleteStatementContext,
  ExceptionDeclarationContext,
  InsertIntoClauseContext,
  LoopStatementContext,
  MergeStatementContext,
  NamedQueryContext,
  ParameterContext,
  QueryBlockContext,
  SubqueryContext,
  TableRefContext,
  TableReferenceContext,
  TruncateStatementContext,
  AlterTableStatementContext,
  TypeDeclarationContext,
  UpdateStatementContext,
  VariableDeclarationContext,
  type RootContext,
} from "../generated/OracleSqlParser.js";
import { splitStatements, type SqlStatement } from "../oracle/splitter.js";
import type { OracleVersion } from "../oracle/keywords.js";
import { gateKeywords, versionIssues } from "./versionGate.js";
import type {
  AliasInfo,
  CteInfo,
  GrammarError,
  OracleCaretContext,
  PlsqlSymbol,
  ValidateMode,
} from "./protocol.js";

/** Options for `getCaretContext`. */
export interface CaretOptions {
  /** Hide keywords of syntax newer than this version (default: everything the grammar knows). */
  version?: OracleVersion;
}

// ---------------------------------------------------------------- parsing

class CollectingErrorListener extends BaseErrorListener {
  readonly errors: GrammarError[] = [];

  override syntaxError<S extends Token, T extends ATNSimulator>(
    _recognizer: Recognizer<T>,
    offendingSymbol: S | null,
    line: number,
    column: number,
    msg: string,
  ): void {
    const len = offendingSymbol && offendingSymbol.type !== Token.EOF ? offendingSymbol.text?.length ?? 1 : 1;
    this.errors.push({
      line,
      column: column + 1, // antlr is 0-based, Monaco is 1-based
      endColumn: column + 1 + Math.max(len, 1),
      message: friendlyMessage(msg),
    });
  }
}

interface ParseResult {
  parser: OracleSqlParser;
  tokens: Token[];
  tree: RootContext;
  errors: GrammarError[];
}

function parse(text: string): ParseResult {
  const errorListener = new CollectingErrorListener();

  const lexer = new OracleSqlLexer(CharStream.fromString(text));
  lexer.removeErrorListeners();
  lexer.addErrorListener(errorListener);

  const tokenStream = new CommonTokenStream(lexer);
  const parser = new OracleSqlParser(tokenStream);
  parser.removeErrorListeners();
  parser.addErrorListener(errorListener);

  const tree = parser.root();
  tokenStream.fill();

  return { parser, tokens: tokenStream.getTokens(), tree, errors: errorListener.errors };
}

/** Shorten ANTLR's messages ("expecting {…200 tokens…}") into something readable. */
function friendlyMessage(msg: string): string {
  const mm = /^(?:mismatched|extraneous) input ('(?:[^']|'')*'|<EOF>) expecting (.*)$/s.exec(msg);
  if (mm) {
    if (mm[1] === "'<EOF>'" || mm[1] === "<EOF>") return "Incomplete statement";
    const at = mm[1];
    const expected = mm[2].startsWith("{") ? mm[2].slice(1, -1).split(", ") : [mm[2]];
    return expected.length <= 5
      ? `Syntax error at ${at}: expected ${expected.join(", ")}`
      : `Syntax error at ${at}`;
  }
  const nv = /^no viable alternative at input '(.*)'$/s.exec(msg);
  if (nv) {
    const last = nv[1].trim().split(/\s+/).pop() ?? "";
    return last === "<EOF>" || !last ? "Incomplete statement" : `Syntax error at '${last}'`;
  }
  const missing = /^missing (.*) at '<EOF>'$/s.exec(msg);
  if (missing) return `Incomplete statement: missing ${missing[1]}`;
  const tre = /^token recognition error at: '(.*)'$/s.exec(msg);
  if (tre) return `Invalid character '${tre[1]}'`;
  return msg;
}

// ---------------------------------------------------------------- caret

const ID_TYPES = new Set<number>([
  OracleSqlParser.IDENTIFIER,
  OracleSqlParser.QUOTED_IDENTIFIER,
]);

/** Absolute character offset for a 1-based (line, column) position. */
function offsetAt(text: string, line: number, column: number): number {
  let offset = 0;
  for (let l = 1; l < line; l++) {
    const nl = text.indexOf("\n", offset);
    if (nl < 0) return text.length;
    offset = nl + 1;
  }
  return Math.min(offset + column - 1, text.length);
}

/** Token index (into the full stream) the parser is "at" for the caret. */
function caretTokenIndex(tokens: Token[], caretOffset: number): number {
  let eofIndex = 0;
  for (const t of tokens) {
    if (t.type === Token.EOF) {
      eofIndex = t.tokenIndex;
      continue;
    }
    if (t.channel !== 0) continue;
    const endExclusive = t.stop + 1;
    if (caretOffset <= t.start) return t.tokenIndex; // caret before this token
    if (caretOffset < endExclusive) return t.tokenIndex; // caret strictly inside
    if (caretOffset === endExclusive && ID_TYPES.has(t.type)) {
      return t.tokenIndex; // at the end of an identifier being typed -> complete it
    }
    // Caret just after this token (e.g. after `(` or a keyword): what may follow.
  }
  return eofIndex;
}

function unquote(raw: string): { text: string; quoted: boolean } {
  return raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')
    ? { text: raw.slice(1, -1), quoted: true }
    : { text: raw, quoted: false };
}

/** Partial word and qualifier chain (`a.b.`, `:new.`) just before the caret. */
function analyzePrefix(
  defaultTokens: Token[],
  caretOffset: number,
): { partialWord: string; qualifier: string[]; qualifierQuoted: boolean[] } {
  let partialIdx = -1;
  let partialWord = "";
  for (let i = 0; i < defaultTokens.length; i++) {
    const t = defaultTokens[i];
    if (caretOffset > t.start && caretOffset <= t.stop + 1) {
      if (ID_TYPES.has(t.type)) {
        partialIdx = i;
        partialWord = (t.text ?? "").slice(0, caretOffset - t.start);
      }
      break;
    }
    if (t.start >= caretOffset) break;
  }

  let j: number;
  if (partialIdx >= 0) {
    j = partialIdx - 1;
  } else {
    j = -1;
    for (let i = 0; i < defaultTokens.length; i++) {
      if (defaultTokens[i].stop + 1 <= caretOffset) j = i;
      else break;
    }
  }

  const qualifier: string[] = [];
  const qualifierQuoted: boolean[] = [];
  while (j >= 1 && defaultTokens[j].type === OracleSqlParser.DOT) {
    const prev = defaultTokens[j - 1];
    const isName =
      ID_TYPES.has(prev.type) ||
      prev.type === OracleSqlParser.BIND_VARIABLE ||
      isKeywordToken(prev.type);
    if (!isName) break;
    const { text, quoted } = unquote(prev.text ?? "");
    qualifier.unshift(text);
    qualifierQuoted.unshift(quoted);
    j -= 2;
  }

  return { partialWord, qualifier, qualifierQuoted };
}

// ---------------------------------------------------------------- c3 setup

/** Keyword tokens are everything lexed before LPAREN (see the grammar). */
function isKeywordToken(type: number): boolean {
  return type > 0 && type < OracleSqlParser.LPAREN;
}

// Never offered as keyword suggestions: punctuation, operators, literals, names.
const IGNORED_TOKENS = new Set<number>([Token.EOF]);
for (let t = OracleSqlParser.LPAREN; t <= OracleSqlParser.WS; t++) IGNORED_TOKENS.add(t);

const PREFERRED_RULES = new Set<number>([
  OracleSqlParser.RULE_tableRef,
  OracleSqlParser.RULE_columnRef,
  OracleSqlParser.RULE_functionName,
  OracleSqlParser.RULE_procedureRef,
  OracleSqlParser.RULE_variableRef,
  OracleSqlParser.RULE_typeName,
  OracleSqlParser.RULE_dblinkRef,
  // Stops c3 from listing every non-reserved keyword wherever a name may go.
  OracleSqlParser.RULE_nonReserved,
]);

// ---------------------------------------------------------------- scope

/** Depth-first search for the first descendant of a given context class. */
function findFirst<T>(node: unknown, cls: new (...args: never[]) => T): T | undefined {
  if (!node || typeof node !== "object") return undefined;
  if (node instanceof cls) return node;
  const children = (node as { children?: unknown[] }).children;
  if (Array.isArray(children)) {
    for (const c of children) {
      const hit = findFirst(c, cls);
      if (hit) return hit;
    }
  }
  return undefined;
}

function walk(node: unknown, visit: (n: unknown) => void): void {
  if (!node || typeof node !== "object") return;
  visit(node);
  const children = (node as { children?: unknown[] }).children;
  if (Array.isArray(children)) for (const c of children) walk(c, visit);
}

function nameText(ctx: ParserRuleContext | null | undefined): string | undefined {
  if (!ctx) return undefined;
  const t = ctx.getText();
  return unquote(t).text || undefined;
}

function lastPart(qualified: string): string {
  const parts = qualified.split(".");
  return unquote(parts[parts.length - 1]).text;
}

/**
 * Column names a subquery produces, from its first query block's select list:
 * explicit aliases and bare column references. `undefined` for `SELECT *`.
 */
function deriveColumns(sub: SubqueryContext | null | undefined): string[] | undefined {
  const block = sub ? findFirst(sub, QueryBlockContext) : undefined;
  const list = block?.selectList();
  if (!list || list.ASTERISK()) return undefined;
  const cols: string[] = [];
  for (const item of list.selectItem()) {
    if (item.allColumns()) return undefined;
    const alias = item.identifier();
    if (alias) {
      cols.push(unquote(alias.getText()).text);
      continue;
    }
    const expr = item.expression();
    const col = expr?.getChildCount() === 1 ? expr.primary()?.columnRef() : null;
    if (col && expr?.primary()?.getChildCount() === 1) cols.push(lastPart(col.getText()));
  }
  return cols;
}

/** First table a subquery reads from (for `SELECT *` loop records / views). */
function firstTable(sub: SubqueryContext | null | undefined): string | undefined {
  const block = sub ? findFirst(sub, QueryBlockContext) : undefined;
  const ref = block?.fromClause() ? findFirst(block.fromClause(), TableRefContext) : undefined;
  return ref?.getText();
}

interface Scope {
  aliases: AliasInfo[];
  ctes: CteInfo[];
  plsql: PlsqlSymbol[];
}

function collectScope(tree: unknown): Scope {
  const aliases: AliasInfo[] = [];
  const ctes: CteInfo[] = [];
  const plsql: PlsqlSymbol[] = [];
  const cursors = new Map<string, { columns?: string[]; table?: string }>();

  // CTEs and cursors first so table references / records can resolve them.
  walk(tree, (n) => {
    if (n instanceof NamedQueryContext) {
      const name = nameText(n.identifier());
      if (!name) return;
      const explicit = n.columnAliases()?.identifier().map((i) => unquote(i.getText()).text);
      ctes.push({ name, columns: explicit ?? deriveColumns(n.subquery()) });
    } else if (n instanceof CursorDeclarationContext) {
      const name = nameText(n.identifier());
      if (!name) return;
      const sub = n.selectStatement()?.subquery();
      cursors.set(name.toUpperCase(), { columns: deriveColumns(sub), table: firstTable(sub) });
      plsql.push({ name, kind: "cursor" });
    }
  });

  const cteNamed = (table: string) => ctes.find((c) => c.name.toUpperCase() === table.toUpperCase());

  const addTable = (ref: TableRefContext | null | undefined, alias?: string, dbLink?: string) => {
    if (!ref) return;
    const table = ref.getText();
    // Skip names the parser had to invent or truncate during error recovery.
    if (!table || table.endsWith(".") || table.includes("<missing") || table.includes(PLACEHOLDER)) return;
    const cte = table.includes(".") ? undefined : cteNamed(unquote(table).text);
    aliases.push({
      alias: alias ?? lastPart(table),
      table,
      kind: cte ? "cte" : "table",
      ...(dbLink ? { dbLink } : {}),
      ...(cte?.columns ? { columns: cte.columns } : {}),
    });
  };

  walk(tree, (n) => {
    if (n instanceof TableReferenceContext) {
      const qte = n.queryTableExpression();
      const alias = nameText(n.tableAlias()?.identifier());
      if (qte.tableRef()) {
        addTable(qte.tableRef(), alias, qte.dbLink()?.dblinkRef().getText());
      } else if (qte.subquery() && alias) {
        const sub = qte.subquery();
        const columns = deriveColumns(sub);
        aliases.push(
          columns
            ? { alias, table: "(subquery)", kind: "subquery", columns }
            : { alias, table: firstTable(sub) ?? "(subquery)", kind: "subquery" },
        );
      }
    } else if (n instanceof InsertIntoClauseContext || n instanceof UpdateStatementContext || n instanceof DeleteStatementContext) {
      addTable(n.tableRef(), nameText(n.tableAlias()?.identifier()), n.dbLink()?.dblinkRef().getText());
    } else if (n instanceof MergeStatementContext) {
      const usingAt = n.USING().symbol.tokenIndex;
      const [targetAlias, sourceAlias] = [
        n.tableAlias().find((a) => a.start!.tokenIndex < usingAt),
        n.tableAlias().find((a) => a.start!.tokenIndex > usingAt),
      ];
      const refs = n.tableRef();
      addTable(refs[0], nameText(targetAlias?.identifier()));
      if (refs[1]) addTable(refs[1], nameText(sourceAlias?.identifier()));
      else if (n.subquery() && sourceAlias) {
        const alias = nameText(sourceAlias.identifier())!;
        const columns = deriveColumns(n.subquery());
        aliases.push({ alias, table: columns ? "(subquery)" : firstTable(n.subquery()) ?? "(subquery)", kind: "subquery", ...(columns ? { columns } : {}) });
      }
    } else if (
      n instanceof CreateIndexStatementContext ||
      n instanceof AlterTableStatementContext ||
      n instanceof TruncateStatementContext
    ) {
      addTable(n.tableRef());
    } else if (n instanceof CreateTriggerContext) {
      const ref = n.tableRef();
      addTable(ref);
      if (ref) {
        aliases.push({ alias: ":NEW", table: ref.getText(), kind: "record" });
        aliases.push({ alias: ":OLD", table: ref.getText(), kind: "record" });
      }
    } else if (n instanceof VariableDeclarationContext) {
      const name = nameText(n.identifier());
      if (!name) return;
      const type = n.plsqlType().getText();
      plsql.push({ name, kind: n.CONSTANT() ? "constant" : "variable", type });
      const rowtype = /^(.*)%ROWTYPE$/i.exec(type);
      if (rowtype) {
        const cur = cursors.get(unquote(rowtype[1]).text.toUpperCase());
        if (cur?.columns) aliases.push({ alias: name, table: "(cursor)", kind: "record", columns: cur.columns });
        else aliases.push({ alias: name, table: cur?.table ?? rowtype[1], kind: "record" });
      }
    } else if (n instanceof ParameterContext) {
      const name = nameText(n.identifier());
      if (name) plsql.push({ name, kind: "parameter", type: n.plsqlType().getText() });
    } else if (n instanceof ExceptionDeclarationContext) {
      const name = nameText(n.identifier());
      if (name) plsql.push({ name, kind: "exception" });
    } else if (n instanceof TypeDeclarationContext) {
      const name = nameText(n.identifier());
      if (name) plsql.push({ name, kind: "type" });
    } else if (n instanceof LoopStatementContext && n.FOR()) {
      const name = nameText(n.identifier(0));
      const range = n.loopRange();
      if (!name || !range) return;
      if (range.DOTDOT()) {
        plsql.push({ name, kind: "variable", type: "PLS_INTEGER" });
        return;
      }
      plsql.push({ name, kind: "record" });
      const sub = range.subquery();
      if (sub) {
        const columns = deriveColumns(sub);
        aliases.push(columns
          ? { alias: name, table: "(subquery)", kind: "record", columns }
          : { alias: name, table: firstTable(sub) ?? "(subquery)", kind: "record" });
      } else {
        const cur = cursors.get(unquote(range.variableRef()?.getText() ?? "").text.toUpperCase());
        if (cur) {
          aliases.push(cur.columns
            ? { alias: name, table: "(cursor)", kind: "record", columns: cur.columns }
            : { alias: name, table: cur.table ?? "(cursor)", kind: "record" });
        }
      }
    }
  });

  return { aliases, ctes, plsql };
}

// ---------------------------------------------------------------- public API

/**
 * Identifier inserted at the caret to re-parse an incomplete statement for
 * its scope: `SELECT | FROM emp e` has no select item, so error recovery
 * would drop the FROM clause; `SELECT __caret__ FROM emp e` keeps it.
 */
const PLACEHOLDER = "__caret__";

function withoutPlaceholder(scope: Scope): Scope {
  const clean = (s: string) => !s.includes(PLACEHOLDER);
  return {
    aliases: scope.aliases.filter((a) => clean(a.alias) && clean(a.table)),
    ctes: scope.ctes.filter((c) => clean(c.name)),
    plsql: scope.plsql.filter((p) => clean(p.name)),
  };
}

let emptyKeywords: string[] | undefined;

function noContext(kind: OracleCaretContext["statementKind"], keywords: string[] = []): OracleCaretContext {
  return {
    keywords,
    expectTable: false,
    expectColumn: false,
    expectFunction: false,
    expectProcedure: false,
    expectVariable: false,
    expectType: false,
    expectDbLink: false,
    qualifier: [],
    qualifierQuoted: [],
    partialWord: "",
    aliases: [],
    ctes: [],
    plsql: [],
    statementKind: kind,
  };
}

/** Keywords valid at the start of a statement (cached). */
function statementStartKeywords(): string[] {
  if (!emptyKeywords) emptyKeywords = getContextForText("", 0).keywords;
  return emptyKeywords;
}

const literalOf = (type: number): string | undefined => {
  const literal = OracleSqlParser.literalNames[type];
  return literal ? literal.slice(1, -1) : undefined; // strip surrounding quotes
};

/** The statement the caret belongs to, if any (caret right after `;` starts a new one). */
function statementForCaret(statements: SqlStatement[], offset: number): SqlStatement | undefined {
  return statements.find(
    (s) =>
      offset >= s.startOffset &&
      (offset < s.endOffset ||
        (offset === s.endOffset && (s.terminator === "eof" || s.terminator === "eol"))),
  );
}

function getContextForText(text: string, caretOffset: number, version?: OracleVersion): OracleCaretContext {
  const { parser, tokens, tree, errors } = parse(text);
  const defaultTokens = tokens.filter((t) => t.channel === 0 && t.type !== Token.EOF);

  const core = new CodeCompletionCore(parser);
  core.preferredRules = PREFERRED_RULES;
  core.ignoredTokens = IGNORED_TOKENS;
  const candidates = core.collectCandidates(caretTokenIndex(tokens, caretOffset));

  const keywords = gateKeywords(candidates.tokens, version, literalOf);

  const has = (rule: number) => candidates.rules.has(rule);
  const prefix = analyzePrefix(defaultTokens, caretOffset);

  let scope = collectScope(tree);
  if (errors.length && !prefix.partialWord) {
    const patched = parse(`${text.slice(0, caretOffset)} ${PLACEHOLDER} ${text.slice(caretOffset)}`);
    if (patched.errors.length < errors.length) scope = withoutPlaceholder(collectScope(patched.tree));
  }

  const expectType = has(OracleSqlParser.RULE_typeName);

  return {
    keywords: keywords.sort(),
    expectTable: has(OracleSqlParser.RULE_tableRef),
    // `v emp.|` before %TYPE: the qualified type position wants columns too.
    expectColumn: has(OracleSqlParser.RULE_columnRef) || (expectType && prefix.qualifier.length > 0),
    expectFunction: has(OracleSqlParser.RULE_functionName),
    expectProcedure: has(OracleSqlParser.RULE_procedureRef),
    expectVariable: has(OracleSqlParser.RULE_variableRef),
    expectType,
    expectDbLink: has(OracleSqlParser.RULE_dblinkRef),
    ...prefix,
    ...scope,
    statementKind: "sql",
  };
}

export function getCaretContext(
  text: string,
  position: { line: number; column: number },
  options: CaretOptions = {},
): OracleCaretContext {
  const offset = offsetAt(text, position.line, position.column);
  const stmt = statementForCaret(splitStatements(text), offset);

  if (!stmt) {
    // Between statements: what may start a new one.
    return noContext("none", statementStartKeywords());
  }
  if (stmt.kind === "empty") return noContext("none");
  if (stmt.kind === "sqlplus") {
    // `DESC <object>` is the one SQL*Plus command worth completing.
    const ctx = noContext("sqlplus");
    if (stmt.command?.name === "DESC") {
      const body = text.slice(stmt.startOffset, offset);
      const { qualifier, qualifierQuoted } = analyzePrefix(
        parse(body).tokens.filter((t) => t.channel === 0 && t.type !== Token.EOF),
        body.length,
      );
      return { ...ctx, expectTable: true, qualifier, qualifierQuoted };
    }
    return ctx;
  }

  // Parse just this statement (plus any whitespace typed after its text).
  const end = Math.max(stmt.startOffset + stmt.text.length, offset);
  const ctx = getContextForText(text.slice(stmt.startOffset, end), offset - stmt.startOffset, options.version);
  return { ...ctx, statementKind: stmt.kind };
}

/**
 * Grammar errors for every statement (SQL only, or SQL + PL/SQL), in
 * document coordinates. Only the first error per statement is reported —
 * later ones are usually recovery noise. SQL*Plus commands are skipped.
 * With `version`, statements that parse cleanly are also checked for
 * syntax newer than that version (reported as warnings).
 */
export function validateGrammar(text: string, mode: ValidateMode = "sql", version?: OracleVersion): GrammarError[] {
  if (!text.trim()) return [];
  const out: GrammarError[] = [];
  for (const stmt of splitStatements(text)) {
    if (stmt.kind !== "sql" && !(mode === "all" && stmt.kind === "plsql")) continue;
    const { tree, errors } = parse(stmt.text);
    const lineStart = text.lastIndexOf("\n", stmt.startOffset - 1) + 1;
    const startCol = stmt.startOffset - lineStart + 1;
    /** Statement-relative (1-based line, 1-based column) → document. */
    const toDoc = (line: number, column: number) => ({
      line: line + stmt.startLine - 1,
      column: column + (line === 1 ? startCol - 1 : 0),
    });
    const [first] = errors;
    if (first) {
      const pos = toDoc(first.line, first.column);
      out.push({ ...pos, endColumn: first.endColumn + (pos.column - first.column), message: first.message });
      continue;
    }
    if (!version) continue;
    for (const issue of versionIssues(tree, version, stmt.kind === "sql")) {
      const pos = toDoc(issue.token.line, issue.token.column + 1);
      const sameLine = issue.stop.line === issue.token.line;
      const width = sameLine ? issue.stop.stop - issue.token.start + 1 : (issue.token.text?.length ?? 1);
      out.push({ ...pos, endColumn: pos.column + Math.max(1, width), message: issue.message, severity: "warning" });
    }
  }
  return out;
}
