/**
 * Oracle identifier rules.
 *
 * Unquoted identifiers are stored upper-cased in the data dictionary
 * (`employees` → EMPLOYEES); quoted identifiers keep their exact text
 * (`"Mixed Case"`). A dictionary name must be quoted when inserted if it is
 * not a valid unquoted identifier: lower-case letters, characters other than
 * A–Z 0–9 _ $ #, a leading non-letter, or a reserved word.
 */
import type { CaseMode } from "../core/completionItems";
import { ORACLE_RESERVED_WORDS } from "./keywords";

const RESERVED = new Set(ORACLE_RESERVED_WORDS);
const UNQUOTED = /^[A-Z][A-Z0-9_$#]*$/;

/** Dictionary form of a name as typed: `emp` → EMP, `"Emp"` → Emp. */
export function normalizeIdent(raw: string): string {
  if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) return raw.slice(1, -1);
  return raw.toUpperCase();
}

/** Whether `dictName` (exact dictionary text) needs double quotes. */
export function needsQuoting(dictName: string, reserved: Set<string> = RESERVED): boolean {
  return !UNQUOTED.test(dictName) || reserved.has(dictName);
}

/**
 * Text to insert for a dictionary name. Names that need quoting are quoted
 * verbatim; others follow `mode` — `preserve` lower-cases when the user is
 * typing in lower case and keeps the dictionary case otherwise.
 */
export function renderIdent(dictName: string, typed: string, mode: CaseMode = "preserve"): string {
  if (needsQuoting(dictName)) return `"${dictName}"`;
  if (mode === "upper") return dictName.toUpperCase();
  if (mode === "lower") return dictName.toLowerCase();
  return typed && typed === typed.toLowerCase() && typed !== typed.toUpperCase()
    ? dictName.toLowerCase()
    : dictName;
}

/** Case-insensitive match of a typed name (quoted or not) to a dictionary/declared name. */
export function sameIdent(a: string, b: string): boolean {
  return normalizeIdent(a) === normalizeIdent(b) || a.toUpperCase() === b.toUpperCase();
}

/**
 * Split a qualified name into parts: `hr."Emp".x@prod.world` →
 * `{ parts: ["HR", "Emp", "X"], quoted: [false, true, false], dbLink: "PROD.WORLD" }`.
 */
export function splitQualified(text: string): { parts: string[]; quoted: boolean[]; dbLink?: string } {
  const at = text.search(/@(?=(?:[^"]*"[^"]*")*[^"]*$)/); // `@` outside quotes
  const name = at >= 0 ? text.slice(0, at) : text;
  const dbLink = at >= 0 ? text.slice(at + 1).toUpperCase() : undefined;
  const parts: string[] = [];
  const quoted: boolean[] = [];
  for (const m of name.matchAll(/"([^"]*)"|([^."]+)/g)) {
    if (m[1] !== undefined) {
      parts.push(m[1]);
      quoted.push(true);
    } else {
      const p = m[2].trim();
      if (!p) continue;
      parts.push(p.toUpperCase());
      quoted.push(false);
    }
  }
  return dbLink ? { parts, quoted, dbLink } : { parts, quoted };
}
