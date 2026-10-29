/**
 * Substitution (`&name`, `&&name`) and bind (`:name`, `:1`) variable helpers.
 *
 * Substitution follows SQL*Plus (`SET DEFINE ON`): variables are replaced in
 * code AND inside string literals (`WHERE name = '&who'` is the common form),
 * but not in comments or quoted identifiers. A `.` right after the name ends
 * it and is consumed (`&tab._backup`). `&&name` stores the value so later
 * references reuse it; `&name` asks again unless already DEFINEd.
 *
 * Bind variables are only recognised in code — never in strings or comments.
 */
import { scan } from "./scanner";

/** Case-insensitive variable store (SQL*Plus names are case-insensitive). */
export type SubstitutionVariables = Map<string, string>;

/** Asked for the value of an undefined variable. */
export type SubstitutionPrompt = (name: string) => string | Promise<string>;

export interface SubstitutionRef {
  /** Upper-cased variable name. */
  name: string;
  /** `&&name` (defines the variable for later references). */
  define: boolean;
  start: number;
  end: number;
}

const SUBST = /&(&?)([A-Za-z_][\w$#]*)(\.?)/g;
const BIND = /(^|[^\w$#:])(:(?:[A-Za-z][\w$#]*|\d+))/g;

/** All substitution references in `text`, in order. */
export function findSubstitutionVariables(text: string): SubstitutionRef[] {
  const refs: SubstitutionRef[] = [];
  for (const seg of scan(text)) {
    if (seg.type !== "code" && seg.type !== "string") continue;
    for (const m of seg.text.matchAll(SUBST)) {
      const start = seg.start + m.index!;
      refs.push({ name: m[2].toUpperCase(), define: m[1] === "&", start, end: start + m[0].length });
    }
  }
  return refs;
}

/** Substituted text plus a map from its offsets back to the original text. */
export interface SubstitutionResult {
  text: string;
  /** Offset in `text` → offset in the original (inside a value → the `&` of its reference). */
  toOriginal(offset: number): number;
}

/**
 * Replace substitution variables in `text`. Values come from `vars`, then
 * `prompt`; `&&name` values are stored back into `vars`. Throws when a value
 * is missing and there is no prompt.
 */
export async function substitute(
  text: string,
  vars: SubstitutionVariables,
  prompt?: SubstitutionPrompt,
): Promise<SubstitutionResult> {
  const refs = findSubstitutionVariables(text);
  if (!refs.length) return { text, toOriginal: (o) => o };

  const asked = new Map<string, string>(); // one prompt per `&name` per statement
  const spans: { origStart: number; origEnd: number; newStart: number; newEnd: number }[] = [];
  let out = "";
  let last = 0;
  for (const ref of refs) {
    let value = vars.get(ref.name) ?? asked.get(ref.name);
    if (value === undefined) {
      if (!prompt) throw new Error(`Substitution variable &${ref.name} is not defined`);
      value = await prompt(ref.name);
      asked.set(ref.name, value);
    }
    if (ref.define) vars.set(ref.name, value);
    out += text.slice(last, ref.start);
    spans.push({ origStart: ref.start, origEnd: ref.end, newStart: out.length, newEnd: out.length + value.length });
    out += value;
    last = ref.end;
  }
  out += text.slice(last);

  return {
    text: out,
    toOriginal(offset) {
      let shift = 0;
      for (const s of spans) {
        if (offset < s.newStart) break;
        if (offset < s.newEnd) return s.origStart;
        shift = s.origEnd - s.newEnd;
      }
      return offset + shift;
    },
  };
}

/** `substitute` returning only the text. */
export async function resolveSubstitutions(
  text: string,
  vars: SubstitutionVariables,
  prompt?: SubstitutionPrompt,
): Promise<string> {
  return (await substitute(text, vars, prompt)).text;
}

/**
 * Parse the arguments of a SQL*Plus `DEFINE` command.
 * `x = 1`, `x = 'a b'`, `x = "a b"` → `{ name: "X", value }`; `x` alone → no value.
 */
export function parseDefine(args: string): { name: string; value?: string } | undefined {
  const m = /^([A-Za-z_][\w$#]*)\s*(?:=\s*(.*))?$/s.exec(args.trim());
  if (!m) return undefined;
  const name = m[1].toUpperCase();
  if (m[2] === undefined) return { name };
  let value = m[2].trim();
  const q = value[0];
  if ((q === "'" || q === '"') && value.endsWith(q) && value.length >= 2) {
    value = value.slice(1, -1).split(q + q).join(q);
  }
  return { name, value };
}

/**
 * Bind variable names used in `text`, de-duplicated in order of first use
 * (`:name` → "NAME", `:1` → "1"; with `preserveCase`, as written).
 * `:NEW` / `:OLD` / `:PARENT` followed by `.` are trigger correlation names,
 * not binds.
 */
export function findBindVariables(text: string, options: { preserveCase?: boolean } = {}): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const seg of scan(text)) {
    if (seg.type !== "code") continue;
    for (const m of seg.text.matchAll(BIND)) {
      const raw = m[2].slice(1);
      const upper = raw.toUpperCase();
      const after = seg.text[m.index! + m[0].length];
      if (after === "." && (upper === "NEW" || upper === "OLD" || upper === "PARENT")) continue;
      if (seen.has(upper)) continue;
      seen.add(upper);
      names.push(options.preserveCase ? raw : upper);
    }
  }
  return names;
}
