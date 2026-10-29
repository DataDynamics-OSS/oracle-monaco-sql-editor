/**
 * `targetVersion` gating for the context-aware worker.
 *
 * The grammar accepts 23ai syntax unconditionally (one parser for every
 * version). This module takes it back out when the target is older:
 *   - completion: drops keywords that only start newer syntax
 *     (`IF` of `IF [NOT] EXISTS`, `QUALIFY`, `BOOLEAN` …)
 *   - validation: warns on parsed constructs the target version rejects
 *     (`IF [NOT] EXISTS`, SELECT without FROM, SQL `BOOLEAN` / TRUE / FALSE)
 *
 * Semantic 23ai features (GROUP BY alias / position) are not detected.
 */
import { Token, type ParserRuleContext } from "antlr4ng";
import {
  OracleSqlParser,
  IfExistsContext,
  IfNotExistsContext,
  LiteralContext,
  QueryBlockContext,
  TypeNameContext,
} from "../generated/OracleSqlParser.js";
import { ORACLE_VERSIONED_KEYWORDS, type OracleVersion } from "../oracle/keywords.js";

const ORDER: OracleVersion[] = ["19c", "21c", "23ai"];

/** Whether `target` accepts syntax introduced in `since`. */
export function supports(target: OracleVersion | undefined, since: OracleVersion): boolean {
  return ORDER.indexOf(target ?? "23ai") >= ORDER.indexOf(since);
}

/** Keywords newer than `version`, upper-case. */
function newerKeywords(version: OracleVersion): Set<string> {
  const out = new Set<string>();
  if (!supports(version, "21c")) ORACLE_VERSIONED_KEYWORDS["21c"].forEach((k) => out.add(k));
  if (!supports(version, "23ai")) ORACLE_VERSIONED_KEYWORDS["23ai"].forEach((k) => out.add(k));
  return out;
}

/**
 * Filter c3 keyword candidates (`type → following tokens`) for `version`.
 * `IF` is kept where it starts a PL/SQL IF statement and dropped where it
 * starts `IF [NOT] EXISTS` (23ai).
 */
export function gateKeywords(
  candidates: Map<number, number[]>,
  version: OracleVersion | undefined,
  literalOf: (type: number) => string | undefined,
): string[] {
  const hidden = version ? newerKeywords(version) : new Set<string>();
  const out: string[] = [];
  for (const [type, following] of candidates) {
    const kw = literalOf(type);
    if (!kw || hidden.has(kw)) continue;
    if (
      type === OracleSqlParser.IF &&
      !supports(version, "23ai") &&
      (following[0] === OracleSqlParser.NOT || following[0] === OracleSqlParser.EXISTS)
    ) {
      continue;
    }
    out.push(kw);
  }
  return out;
}

export interface VersionIssue {
  /** First token of the construct. */
  token: Token;
  /** Last token (for the marker's width). */
  stop: Token;
  message: string;
}

function walk(node: unknown, visit: (n: unknown) => void): void {
  if (!node || typeof node !== "object") return;
  visit(node);
  const children = (node as { children?: unknown[] }).children;
  if (Array.isArray(children)) for (const c of children) walk(c, visit);
}

/**
 * Constructs in a parsed statement that `version` does not accept.
 * `sqlStatement`: the statement is SQL (not PL/SQL), where BOOLEAN / TRUE /
 * FALSE are 23ai-only (PL/SQL has always had them).
 */
export function versionIssues(tree: unknown, version: OracleVersion, sqlStatement: boolean): VersionIssue[] {
  if (supports(version, "23ai")) return [];
  const issues: VersionIssue[] = [];
  const add = (ctx: ParserRuleContext, what: string) => {
    if (ctx.start && ctx.stop) {
      issues.push({ token: ctx.start, stop: ctx.stop, message: `${what} requires Oracle 23ai (target: ${version})` });
    }
  };
  walk(tree, (n) => {
    if (n instanceof IfNotExistsContext) add(n, "IF NOT EXISTS");
    else if (n instanceof IfExistsContext) add(n, "IF EXISTS");
    else if (n instanceof QueryBlockContext) {
      if (!n.fromClause() && n.start && n.stop && n.selectList()) {
        // Flag just the SELECT keyword: the whole query block can span many lines.
        issues.push({ token: n.start, stop: n.start, message: `SELECT without FROM requires Oracle 23ai (target: ${version}); use FROM dual` });
      }
    } else if (sqlStatement && n instanceof TypeNameContext) {
      if (n.getText().toUpperCase() === "BOOLEAN") add(n, "The SQL BOOLEAN type");
    } else if (sqlStatement && n instanceof LiteralContext) {
      const t = n.start?.type;
      if (t === OracleSqlParser.TRUE || t === OracleSqlParser.FALSE) add(n, "SQL boolean literals");
    }
  });
  return issues;
}
