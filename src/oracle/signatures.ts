/**
 * Function / procedure signatures and call-site analysis.
 *
 * `callAt(text, offset)` finds the call the caret is inside — `nvl(a, |`,
 * `hr.pkg.proc(p_id => 1, |` — with the argument index and the named
 * arguments already written. Signatures come from the built-in table below
 * (common SQL functions, offline) or from a `SignatureSource` such as the
 * dictionary metadata provider (ALL_ARGUMENTS, with overloads).
 *
 * Text-level and DOM-free (scanner based), so it runs on the main thread
 * and in Node tests.
 */
import { scan } from "./scanner";

/** One formal parameter. */
export interface OracleParameter {
  name: string;
  /** Declared type (`VARCHAR2`, `HR.EMP_T`, `EMPLOYEES%ROWTYPE`). */
  type?: string;
  mode?: "IN" | "OUT" | "IN OUT";
  /** Has a default value / may be omitted. */
  optional?: boolean;
}

export interface OracleSignature {
  /** Routine name as stored (`PUT_LINE`, `NVL`). */
  name: string;
  /** `function` returns a value, `procedure` does not. */
  kind: "function" | "procedure";
  owner?: string;
  /** Package of a member routine. */
  package?: string;
  parameters: OracleParameter[];
  returnType?: string;
  /** Short description (markdown). */
  documentation?: string;
  /**
   * Parameters `[start, start + count)` may repeat (`DECODE`, `COALESCE`):
   * arguments past the declared list cycle through that range.
   */
  repeat?: [start: number, count: number];
}

/** The call around the caret. */
export interface CallSite {
  /** Name parts as written, unquoted: `hr.pkg.proc(` → ["hr", "pkg", "proc"]. */
  parts: string[];
  /** Per part: quoted identifier (case-sensitive)? */
  quoted: boolean[];
  /** `f@link(` */
  dbLink?: string;
  /** 0-based index of the argument the caret is in. */
  argIndex: number;
  /** Names used with `=>` in the arguments before the current one (upper-cased unless quoted). */
  namedArgs: string[];
  /** The current argument is named: `p_id => |`. */
  currentNamed?: string;
  /** The current argument is still empty or a bare partial word (a place for `name =>`). */
  atArgStart: boolean;
  /** Offset of the `(`. */
  openOffset: number;
}

/** Where signatures for user routines come from (e.g. the metadata provider). */
export type SignatureSource = (
  call: CallSite,
) => OracleSignature[] | Promise<OracleSignature[]>;

// ---------------------------------------------------------------- call site

const IDENT = String.raw`(?:"[^"]+"|[A-Za-z][\w$#]*)`;
const CALL_NAME = new RegExp(`(${IDENT}(?:\\s*\\.\\s*${IDENT})*)(?:\\s*@\\s*([A-Za-z][\\w$#]*(?:\\.[A-Za-z][\\w$#]*)*))?\\s*$`);
const NAMED_ARG = new RegExp(`^\\s*(${IDENT})\\s*=>`);

/** Words after which `name (` is a declaration or column list, not a call. */
const NOT_A_CALL_BEFORE = new Set([
  "INTO", "TABLE", "VIEW", "INDEX", "REFERENCES", "KEY", "PROCEDURE", "FUNCTION",
  "PACKAGE", "BODY", "TRIGGER", "TYPE", "CURSOR", "SYNONYM", "AS", "OF",
]);
/** Words directly followed by `(` that are syntax, not routines. */
const NOT_A_CALL = new Set([
  "IN", "VALUES", "EXISTS", "AND", "OR", "NOT", "ON", "USING", "OVER", "FROM", "SELECT",
  "WHERE", "THEN", "ELSE", "WHEN", "RETURNING", "BY", "ANY", "ALL", "SOME", "AS", "IS",
  "INTO", "WITHIN", "KEEP", "PIVOT", "UNPIVOT", "FOR", "CHECK", "UNIQUE", "PRIMARY",
  "TABLE", "MULTISET", "CURSOR", "LOOP", "IF", "ELSIF", "WHILE", "RETURN", "SET", "JOIN",
  "LATERAL", "APPLY", "DEFAULT", "WITH", "PARTITION", "MEASURES", "PATTERN", "DEFINE",
]);

function unquoteIdent(raw: string): { text: string; quoted: boolean } {
  const t = raw.trim();
  return t.startsWith('"') ? { text: t.slice(1, -1), quoted: true } : { text: t, quoted: false };
}

/**
 * Code-only view of `text`: strings, comments and hints become spaces and the
 * inside of quoted identifiers becomes `_`, so offsets match the original
 * while parentheses / commas inside literals are ignored.
 */
function codeMask(text: string): string {
  let out = "";
  for (const s of scan(text)) {
    if (s.type === "code") out += s.text;
    else if (s.type === "quotedIdent") out += s.text.length > 1 ? `"${"_".repeat(s.text.length - 2)}${s.text.endsWith('"') ? '"' : "_"}` : s.text;
    else out += s.text.replace(/[^\n]/g, " ");
  }
  return out;
}

/**
 * The call whose argument list contains `offset`, or undefined. Looks back at
 * most `maxLookBack` characters and never past a `;` outside parentheses.
 */
export function callAt(text: string, offset: number, maxLookBack = 4000): CallSite | undefined {
  const from = Math.max(0, offset - maxLookBack);
  const mask = codeMask(text.slice(from, offset));
  const base = from;

  // Innermost unclosed `(` before the caret.
  let depth = 0;
  let open = -1;
  for (let i = mask.length - 1; i >= 0; i--) {
    const ch = mask[i];
    if (ch === ")") depth++;
    else if (ch === "(") {
      if (depth === 0) {
        open = i;
        break;
      }
      depth--;
    } else if (ch === ";" && depth === 0) return undefined;
  }
  if (open < 0) return undefined;

  const head = CALL_NAME.exec(mask.slice(0, open));
  if (!head) return undefined;
  const nameStart = head.index;
  const rawName = text.slice(base + nameStart, base + nameStart + head[1].length);
  const parts: string[] = [];
  const quoted: boolean[] = [];
  for (const m of rawName.matchAll(new RegExp(IDENT, "g"))) {
    const p = unquoteIdent(m[0]);
    parts.push(p.text);
    quoted.push(p.quoted);
  }
  if (!parts.length) return undefined;
  if (parts.length === 1 && !quoted[0] && NOT_A_CALL.has(parts[0].toUpperCase())) return undefined;
  const before = /([A-Za-z_][\w$#]*)\s*$/.exec(mask.slice(0, nameStart));
  if (before && NOT_A_CALL_BEFORE.has(before[1].toUpperCase())) return undefined;

  // Top-level argument boundaries.
  const args: [number, number][] = [];
  let start = open + 1;
  depth = 0;
  for (let i = open + 1; i < mask.length; i++) {
    const ch = mask[i];
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (ch === "," && depth === 0) {
      args.push([start, i]);
      start = i + 1;
    }
  }
  const namedOf = (a: number, b: number): string | undefined => {
    const m = NAMED_ARG.exec(mask.slice(a, b));
    if (!m) return undefined;
    const raw = text.slice(base + a + m.index + m[0].indexOf(m[1]), base + a + m.index + m[0].indexOf(m[1]) + m[1].length);
    const u = unquoteIdent(raw);
    return u.quoted ? u.text : u.text.toUpperCase();
  };
  const namedArgs = args.map(([a, b]) => namedOf(a, b)).filter((n): n is string => !!n);
  const current = mask.slice(start);
  const currentNamed = namedOf(start, mask.length);

  return {
    parts,
    quoted,
    ...(head[2] ? { dbLink: head[2].toUpperCase() } : {}),
    argIndex: args.length,
    namedArgs,
    ...(currentNamed ? { currentNamed } : {}),
    atArgStart: /^\s*[A-Za-z_]?[\w$#]*$/.test(current),
    openOffset: base + open,
  };
}

// ---------------------------------------------------------------- choosing

const norm = (s: string) => s.toUpperCase();

/** Index of the parameter an argument maps to (repeating groups cycle). */
function parameterIndex(sig: OracleSignature, argIndex: number): number {
  const n = sig.parameters.length;
  if (argIndex < n) return argIndex;
  if (sig.repeat) {
    const [s, c] = sig.repeat;
    return s + ((argIndex - s) % c);
  }
  return -1;
}

/** Whether `sig` can take the arguments written so far. */
function accepts(sig: OracleSignature, call: CallSite): boolean {
  const names = new Set(sig.parameters.map((p) => norm(p.name)));
  for (const n of call.namedArgs) if (!names.has(norm(n))) return false;
  if (call.currentNamed && !names.has(norm(call.currentNamed))) return false;
  return parameterIndex(sig, call.argIndex) >= 0 || !!call.currentNamed;
}

/** Which overload and parameter to highlight for `call`. */
export function activeSignature(
  signatures: OracleSignature[],
  call: CallSite,
): { signature: number; parameter: number } {
  if (!signatures.length) return { signature: 0, parameter: 0 };
  let signature = signatures.findIndex((s) => accepts(s, call));
  if (signature < 0) signature = 0;
  const sig = signatures[signature];
  const parameter = call.currentNamed
    ? sig.parameters.findIndex((p) => norm(p.name) === norm(call.currentNamed!))
    : parameterIndex(sig, call.argIndex);
  return { signature, parameter };
}

/** `NAME(a VARCHAR2, b NUMBER DEFAULT) RETURN DATE` plus each parameter's label range. */
export function signatureLabel(sig: OracleSignature): { label: string; parameters: [number, number][] } {
  const name = sig.package ? `${sig.package}.${sig.name}` : sig.name;
  let label = `${name}(`;
  const ranges: [number, number][] = [];
  sig.parameters.forEach((p, i) => {
    if (i) label += ", ";
    let text = p.name;
    if (p.mode && p.mode !== "IN") text += ` ${p.mode}`;
    if (p.type) text += ` ${p.type}`;
    if (p.optional) text = `[${text}]`;
    ranges.push([label.length, label.length + text.length]);
    label += text;
  });
  if (sig.repeat) label += ", …";
  label += ")";
  if (sig.kind === "function" && sig.returnType) label += ` RETURN ${sig.returnType}`;
  return { label, parameters: ranges };
}

// ---------------------------------------------------------------- built-ins

/**
 * Compact built-in signature table: `NAME(param TYPE, [param TYPE], ...) RETURN TYPE`
 * (`[..]` optional, trailing `...` repeats the last bracketed group).
 * From the Oracle SQL Language Reference; positional notation only.
 */
const BUILTIN_SPECS: [spec: string, doc: string][] = [
  // null handling / comparison
  ["NVL(expr1 ANY, expr2 ANY) RETURN ANY", "`expr2` when `expr1` is null, else `expr1`."],
  ["NVL2(expr1 ANY, if_not_null ANY, if_null ANY) RETURN ANY", "`if_not_null` when `expr1` is not null, else `if_null`."],
  ["NULLIF(expr1 ANY, expr2 ANY) RETURN ANY", "Null when the arguments are equal, else `expr1`."],
  ["COALESCE(expr ANY, expr ANY, ...) RETURN ANY", "First non-null argument."],
  ["DECODE(expr ANY, search ANY, result ANY, ...) RETURN ANY", "Compares `expr` to each `search`; returns the matching `result`, or the trailing default."],
  ["GREATEST(expr ANY, expr ANY, ...) RETURN ANY", "Largest argument."],
  ["LEAST(expr ANY, expr ANY, ...) RETURN ANY", "Smallest argument."],
  ["LNNVL(condition) RETURN BOOLEAN", "True when the condition is false or unknown."],
  // character
  ["SUBSTR(char VARCHAR2, position NUMBER, [length NUMBER]) RETURN VARCHAR2", "Substring starting at `position` (1-based; negative counts from the end)."],
  ["INSTR(string VARCHAR2, substring VARCHAR2, [position NUMBER], [occurrence NUMBER]) RETURN NUMBER", "Position of `substring` in `string` (0 when absent)."],
  ["LENGTH(char VARCHAR2) RETURN NUMBER", "Length in characters."],
  ["UPPER(char VARCHAR2) RETURN VARCHAR2", "Upper case."],
  ["LOWER(char VARCHAR2) RETURN VARCHAR2", "Lower case."],
  ["INITCAP(char VARCHAR2) RETURN VARCHAR2", "First letter of each word upper case."],
  ["LPAD(expr VARCHAR2, n NUMBER, [pad VARCHAR2]) RETURN VARCHAR2", "Left-pads to length `n` (default pad: blank)."],
  ["RPAD(expr VARCHAR2, n NUMBER, [pad VARCHAR2]) RETURN VARCHAR2", "Right-pads to length `n` (default pad: blank)."],
  ["LTRIM(char VARCHAR2, [set VARCHAR2]) RETURN VARCHAR2", "Removes leading characters in `set` (default blank)."],
  ["RTRIM(char VARCHAR2, [set VARCHAR2]) RETURN VARCHAR2", "Removes trailing characters in `set` (default blank)."],
  ["REPLACE(char VARCHAR2, search VARCHAR2, [replacement VARCHAR2]) RETURN VARCHAR2", "Replaces every `search` (removes it when no replacement)."],
  ["TRANSLATE(expr VARCHAR2, from_string VARCHAR2, to_string VARCHAR2) RETURN VARCHAR2", "Character-by-character substitution."],
  ["CONCAT(char1 VARCHAR2, char2 VARCHAR2) RETURN VARCHAR2", "Concatenation (same as `||`)."],
  ["CHR(n NUMBER) RETURN VARCHAR2", "Character with code `n`."],
  ["ASCII(char VARCHAR2) RETURN NUMBER", "Code of the first character."],
  ["REGEXP_LIKE(source VARCHAR2, pattern VARCHAR2, [match_param VARCHAR2]) RETURN BOOLEAN", "Regular-expression match condition."],
  ["REGEXP_SUBSTR(source VARCHAR2, pattern VARCHAR2, [position NUMBER], [occurrence NUMBER], [match_param VARCHAR2], [subexpr NUMBER]) RETURN VARCHAR2", "Substring matching a regular expression."],
  ["REGEXP_INSTR(source VARCHAR2, pattern VARCHAR2, [position NUMBER], [occurrence NUMBER], [return_opt NUMBER], [match_param VARCHAR2], [subexpr NUMBER]) RETURN NUMBER", "Position of a regular-expression match."],
  ["REGEXP_REPLACE(source VARCHAR2, pattern VARCHAR2, [replace_string VARCHAR2], [position NUMBER], [occurrence NUMBER], [match_param VARCHAR2]) RETURN VARCHAR2", "Replaces regular-expression matches."],
  ["REGEXP_COUNT(source VARCHAR2, pattern VARCHAR2, [position NUMBER], [match_param VARCHAR2]) RETURN NUMBER", "Number of regular-expression matches."],
  // numeric
  ["ROUND(n NUMBER, [integer NUMBER]) RETURN NUMBER", "Rounds to `integer` decimal places (dates: to a format unit)."],
  ["TRUNC(n NUMBER, [integer NUMBER]) RETURN NUMBER", "Truncates to `integer` decimal places (dates: to a format unit)."],
  ["MOD(n2 NUMBER, n1 NUMBER) RETURN NUMBER", "Remainder of `n2 / n1`."],
  ["REMAINDER(n2 NUMBER, n1 NUMBER) RETURN NUMBER", "IEEE remainder of `n2 / n1`."],
  ["POWER(n2 NUMBER, n1 NUMBER) RETURN NUMBER", "`n2` raised to `n1`."],
  ["ABS(n NUMBER) RETURN NUMBER", "Absolute value."],
  ["CEIL(n NUMBER) RETURN NUMBER", "Smallest integer ≥ `n`."],
  ["FLOOR(n NUMBER) RETURN NUMBER", "Largest integer ≤ `n`."],
  ["SIGN(n NUMBER) RETURN NUMBER", "-1, 0 or 1."],
  ["SQRT(n NUMBER) RETURN NUMBER", "Square root."],
  ["BITAND(expr1 NUMBER, expr2 NUMBER) RETURN NUMBER", "Bitwise AND."],
  ["WIDTH_BUCKET(expr NUMBER, min_value NUMBER, max_value NUMBER, num_buckets NUMBER) RETURN NUMBER", "Equi-width histogram bucket."],
  // datetime
  ["ADD_MONTHS(date DATE, integer NUMBER) RETURN DATE", "`date` plus `integer` months."],
  ["MONTHS_BETWEEN(date1 DATE, date2 DATE) RETURN NUMBER", "Months between two dates."],
  ["LAST_DAY(date DATE) RETURN DATE", "Last day of the month."],
  ["NEXT_DAY(date DATE, char VARCHAR2) RETURN DATE", "First weekday named `char` after `date`."],
  ["NUMTODSINTERVAL(n NUMBER, interval_unit VARCHAR2) RETURN INTERVAL DAY TO SECOND", "`n` days / hours / minutes / seconds as an interval."],
  ["NUMTOYMINTERVAL(n NUMBER, interval_unit VARCHAR2) RETURN INTERVAL YEAR TO MONTH", "`n` years / months as an interval."],
  ["FROM_TZ(timestamp_value TIMESTAMP, time_zone_value VARCHAR2) RETURN TIMESTAMP WITH TIME ZONE", "Attaches a time zone."],
  ["SYS_EXTRACT_UTC(datetime_with_timezone TIMESTAMP WITH TIME ZONE) RETURN TIMESTAMP", "UTC time of a zoned timestamp."],
  // conversion
  ["TO_CHAR(expr ANY, [fmt VARCHAR2], [nlsparam VARCHAR2]) RETURN VARCHAR2", "Number / date / interval to text."],
  ["TO_DATE(char VARCHAR2, [fmt VARCHAR2], [nlsparam VARCHAR2]) RETURN DATE", "Text to DATE."],
  ["TO_NUMBER(expr VARCHAR2, [fmt VARCHAR2], [nlsparam VARCHAR2]) RETURN NUMBER", "Text to NUMBER."],
  ["TO_TIMESTAMP(char VARCHAR2, [fmt VARCHAR2], [nlsparam VARCHAR2]) RETURN TIMESTAMP", "Text to TIMESTAMP."],
  ["TO_TIMESTAMP_TZ(char VARCHAR2, [fmt VARCHAR2], [nlsparam VARCHAR2]) RETURN TIMESTAMP WITH TIME ZONE", "Text to TIMESTAMP WITH TIME ZONE."],
  ["TO_CLOB(expr ANY) RETURN CLOB", "Converts to CLOB."],
  ["TO_DSINTERVAL(char VARCHAR2) RETURN INTERVAL DAY TO SECOND", "Text to a day-to-second interval."],
  ["TO_YMINTERVAL(char VARCHAR2) RETURN INTERVAL YEAR TO MONTH", "Text to a year-to-month interval."],
  ["HEXTORAW(char VARCHAR2) RETURN RAW", "Hex text to RAW."],
  ["RAWTOHEX(raw RAW) RETURN VARCHAR2", "RAW to hex text."],
  ["VALIDATE_CONVERSION(expr ANY, [fmt VARCHAR2], [nlsparam VARCHAR2]) RETURN NUMBER", "1 when `expr AS type` would convert (write `expr AS type` as the first argument)."],
  // misc
  ["SYS_CONTEXT(namespace VARCHAR2, parameter VARCHAR2, [length NUMBER]) RETURN VARCHAR2", "Context attribute, e.g. `SYS_CONTEXT('USERENV', 'CURRENT_SCHEMA')`."],
  ["ORA_HASH(expr ANY, [max_bucket NUMBER], [seed_value NUMBER]) RETURN NUMBER", "Hash value."],
  ["STANDARD_HASH(expr ANY, [method VARCHAR2]) RETURN RAW", "SHA1 (default) / SHA256 / SHA384 / SHA512 / MD5 hash."],
  ["DUMP(expr ANY, [return_fmt NUMBER], [start_position NUMBER], [length NUMBER]) RETURN VARCHAR2", "Internal representation."],
  ["SYS_CONNECT_BY_PATH(column ANY, char VARCHAR2) RETURN VARCHAR2", "Path from the root in a hierarchical query."],
  // aggregate / analytic
  ["COUNT(expr ANY) RETURN NUMBER", "Number of rows where `expr` is not null (`*`: all rows)."],
  ["SUM(expr NUMBER) RETURN NUMBER", "Sum."],
  ["AVG(expr NUMBER) RETURN NUMBER", "Average."],
  ["MIN(expr ANY) RETURN ANY", "Minimum."],
  ["MAX(expr ANY) RETURN ANY", "Maximum."],
  ["MEDIAN(expr NUMBER) RETURN NUMBER", "Median."],
  ["STDDEV(expr NUMBER) RETURN NUMBER", "Sample standard deviation."],
  ["VARIANCE(expr NUMBER) RETURN NUMBER", "Sample variance."],
  ["LISTAGG(measure_expr VARCHAR2, [delimiter VARCHAR2]) RETURN VARCHAR2", "Concatenates values: `LISTAGG(x, ',') WITHIN GROUP (ORDER BY …)`."],
  ["LAG(value_expr ANY, [offset NUMBER], [default ANY]) RETURN ANY", "Value from a previous row: `LAG(x) OVER (ORDER BY …)`."],
  ["LEAD(value_expr ANY, [offset NUMBER], [default ANY]) RETURN ANY", "Value from a following row: `LEAD(x) OVER (ORDER BY …)`."],
  ["FIRST_VALUE(expr ANY) RETURN ANY", "First value in the window."],
  ["LAST_VALUE(expr ANY) RETURN ANY", "Last value in the window."],
  ["NTH_VALUE(measure_expr ANY, n NUMBER) RETURN ANY", "`n`-th value in the window."],
  ["NTILE(expr NUMBER) RETURN NUMBER", "Bucket number of the row."],
  ["RATIO_TO_REPORT(expr NUMBER) RETURN NUMBER", "Ratio of a value to the window sum."],
  ["APPROX_COUNT_DISTINCT(expr ANY) RETURN NUMBER", "Approximate number of distinct values."],
  // JSON
  ["JSON_VALUE(expr VARCHAR2, path VARCHAR2) RETURN VARCHAR2", "Scalar at a JSON path (`RETURNING`, `ON ERROR` clauses follow the path)."],
  ["JSON_QUERY(expr VARCHAR2, path VARCHAR2) RETURN VARCHAR2", "Object / array at a JSON path."],
  ["JSON_EXISTS(expr VARCHAR2, path VARCHAR2) RETURN BOOLEAN", "Whether a JSON path matches."],
  ["JSON_MERGEPATCH(target_expr VARCHAR2, patch_expr VARCHAR2) RETURN VARCHAR2", "RFC 7396 merge patch."],
  // more numeric
  ["ACOS(n NUMBER) RETURN NUMBER", "Arc cosine, in radians."],
  ["ASIN(n NUMBER) RETURN NUMBER", "Arc sine, in radians."],
  ["ATAN(n NUMBER) RETURN NUMBER", "Arc tangent, in radians."],
  ["ATAN2(n1 NUMBER, n2 NUMBER) RETURN NUMBER", "Arc tangent of `n1 / n2`, in radians."],
  ["COS(n NUMBER) RETURN NUMBER", "Cosine of an angle in radians."],
  ["COSH(n NUMBER) RETURN NUMBER", "Hyperbolic cosine."],
  ["SIN(n NUMBER) RETURN NUMBER", "Sine of an angle in radians."],
  ["SINH(n NUMBER) RETURN NUMBER", "Hyperbolic sine."],
  ["TAN(n NUMBER) RETURN NUMBER", "Tangent of an angle in radians."],
  ["TANH(n NUMBER) RETURN NUMBER", "Hyperbolic tangent."],
  ["EXP(n NUMBER) RETURN NUMBER", "e raised to `n`."],
  ["LN(n NUMBER) RETURN NUMBER", "Natural logarithm."],
  ["LOG(base NUMBER, n NUMBER) RETURN NUMBER", "Logarithm of `n` in base `base`."],
  ["NANVL(n2 BINARY_DOUBLE, n1 BINARY_DOUBLE) RETURN BINARY_DOUBLE", "`n1` when `n2` is NaN, else `n2`."],
  ["BIN_TO_NUM(expr NUMBER, expr NUMBER, ...) RETURN NUMBER", "Bit vector (0 / 1 arguments) to a number."],
  // more character
  ["INSTRB(string VARCHAR2, substring VARCHAR2, [position NUMBER], [occurrence NUMBER]) RETURN NUMBER", "INSTR counting bytes."],
  ["LENGTHB(char VARCHAR2) RETURN NUMBER", "Length in bytes."],
  ["SUBSTRB(char VARCHAR2, position NUMBER, [length NUMBER]) RETURN VARCHAR2", "SUBSTR counting bytes."],
  ["NLS_INITCAP(char VARCHAR2, [nlsparam VARCHAR2]) RETURN VARCHAR2", "INITCAP with a linguistic sort (`'NLS_SORT = XDutch'`)."],
  ["NLS_LOWER(char VARCHAR2, [nlsparam VARCHAR2]) RETURN VARCHAR2", "LOWER with a linguistic sort."],
  ["NLS_UPPER(char VARCHAR2, [nlsparam VARCHAR2]) RETURN VARCHAR2", "UPPER with a linguistic sort."],
  ["NLSSORT(char VARCHAR2, [nlsparam VARCHAR2]) RETURN RAW", "Collation key for linguistic ordering."],
  ["SOUNDEX(char VARCHAR2) RETURN VARCHAR2", "Phonetic representation (English)."],
  ["ASCIISTR(char VARCHAR2) RETURN VARCHAR2", "ASCII text with non-ASCII characters as `\\xxxx` escapes."],
  ["UNISTR(string VARCHAR2) RETURN NVARCHAR2", "Text with `\\xxxx` Unicode escapes decoded."],
  ["CONVERT(char VARCHAR2, dest_char_set VARCHAR2, [source_char_set VARCHAR2]) RETURN VARCHAR2", "Converts between character sets."],
  // more datetime
  ["NEW_TIME(date DATE, timezone1 VARCHAR2, timezone2 VARCHAR2) RETURN DATE", "Converts a date between two (North American) time zones."],
  ["TZ_OFFSET(time_zone VARCHAR2) RETURN VARCHAR2", "UTC offset of a time zone, e.g. `'+09:00'`."],
  // more conversion
  ["CHARTOROWID(char VARCHAR2) RETURN ROWID", "Text to ROWID."],
  ["ROWIDTOCHAR(rowid ROWID) RETURN VARCHAR2", "ROWID to text."],
  ["TO_BINARY_DOUBLE(expr ANY, [fmt VARCHAR2], [nlsparam VARCHAR2]) RETURN BINARY_DOUBLE", "Converts to BINARY_DOUBLE."],
  ["TO_BINARY_FLOAT(expr ANY, [fmt VARCHAR2], [nlsparam VARCHAR2]) RETURN BINARY_FLOAT", "Converts to BINARY_FLOAT."],
  ["TO_BLOB(raw_value RAW) RETURN BLOB", "RAW (or BFILE) to BLOB."],
  ["TO_LOB(long_column LONG) RETURN CLOB", "LONG / LONG RAW column to a LOB (only in INSERT … SELECT / CREATE TABLE … AS)."],
  ["TO_NCHAR(expr ANY, [fmt VARCHAR2], [nlsparam VARCHAR2]) RETURN NVARCHAR2", "Converts to the national character set."],
  ["TO_NCLOB(expr ANY) RETURN NCLOB", "Converts to NCLOB."],
  ["TO_MULTI_BYTE(char VARCHAR2) RETURN VARCHAR2", "Single-byte characters to their multibyte equivalents."],
  ["TO_SINGLE_BYTE(char VARCHAR2) RETURN VARCHAR2", "Multibyte characters to their single-byte equivalents."],
  // more misc
  ["EMPTY_BLOB() RETURN BLOB", "Empty LOB locator, to initialise a BLOB column."],
  ["EMPTY_CLOB() RETURN CLOB", "Empty LOB locator, to initialise a CLOB column."],
  ["SYS_GUID() RETURN RAW", "Globally unique 16-byte identifier."],
  ["USERENV(parameter VARCHAR2) RETURN VARCHAR2", "Legacy session information; prefer `SYS_CONTEXT('USERENV', …)`."],
  ["VSIZE(expr ANY) RETURN NUMBER", "Bytes in the internal representation."],
  // more aggregate / analytic
  ["APPROX_MEDIAN(expr NUMBER) RETURN NUMBER", "Approximate median."],
  ["APPROX_PERCENTILE(percentile NUMBER) RETURN NUMBER", "Approximate percentile: `APPROX_PERCENTILE(0.9) WITHIN GROUP (ORDER BY x)`."],
  ["CORR(expr1 NUMBER, expr2 NUMBER) RETURN NUMBER", "Correlation coefficient."],
  ["COVAR_POP(expr1 NUMBER, expr2 NUMBER) RETURN NUMBER", "Population covariance."],
  ["COVAR_SAMP(expr1 NUMBER, expr2 NUMBER) RETURN NUMBER", "Sample covariance."],
  ["STDDEV_POP(expr NUMBER) RETURN NUMBER", "Population standard deviation."],
  ["STDDEV_SAMP(expr NUMBER) RETURN NUMBER", "Sample standard deviation."],
  ["VAR_POP(expr NUMBER) RETURN NUMBER", "Population variance."],
  ["VAR_SAMP(expr NUMBER) RETURN NUMBER", "Sample variance."],
  ["STATS_MODE(expr ANY) RETURN ANY", "Most frequent value."],
  ["COLLECT(column ANY) RETURN NESTED TABLE", "Aggregates values into a nested table (`CAST(COLLECT(x) AS t)`)."],
  ["PERCENTILE_CONT(percentile NUMBER) RETURN NUMBER", "Interpolated percentile: `PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY x)`."],
  ["PERCENTILE_DISC(percentile NUMBER) RETURN ANY", "Discrete percentile: `PERCENTILE_DISC(0.5) WITHIN GROUP (ORDER BY x)`."],
  ["ROW_NUMBER() RETURN NUMBER", "1, 2, 3 … within the window: `ROW_NUMBER() OVER (PARTITION BY … ORDER BY …)`."],
  ["RANK() RETURN NUMBER", "Rank with gaps after ties: `RANK() OVER (ORDER BY …)`."],
  ["DENSE_RANK() RETURN NUMBER", "Rank without gaps after ties: `DENSE_RANK() OVER (ORDER BY …)`."],
  ["PERCENT_RANK() RETURN NUMBER", "(rank - 1) / (rows - 1): `PERCENT_RANK() OVER (ORDER BY …)`."],
  ["CUME_DIST() RETURN NUMBER", "Cumulative distribution: `CUME_DIST() OVER (ORDER BY …)`."],
  ["GROUP_ID() RETURN NUMBER", "Distinguishes duplicate groups from GROUP BY extensions."],
  ["GROUPING_ID(expr ANY, expr ANY, ...) RETURN NUMBER", "Bit vector of GROUPING() values for ROLLUP / CUBE rows."],
  // XML
  ["EXTRACTVALUE(xmltype_instance XMLTYPE, xpath VARCHAR2) RETURN VARCHAR2", "Scalar value of an XPath (deprecated; prefer XMLTABLE / XMLCAST)."],
  ["XMLAGG(xmltype_instance XMLTYPE) RETURN XMLTYPE", "Aggregates XML fragments (`ORDER BY` allowed inside)."],
  ["XMLFOREST(value_expr ANY, value_expr ANY, ...) RETURN XMLTYPE", "One element per argument (`expr AS \"name\"`)."],
];

const SPEC = /^([A-Z_0-9]+)\((.*)\)(?:\s+RETURN\s+(.+))?$/;

function parseSpec(spec: string, documentation: string): OracleSignature {
  const m = SPEC.exec(spec);
  if (!m) throw new Error(`bad builtin spec: ${spec}`);
  const [, name, params, returnType] = m;
  const parameters: OracleParameter[] = [];
  let repeat: [number, number] | undefined;
  for (const raw of params.split(/,\s*/).filter(Boolean)) {
    if (raw === "...") {
      // repeat the previous parameter(s): DECODE repeats (search, result), others the last one
      repeat = name === "DECODE" ? [1, 2] : [parameters.length - 1, 1];
      continue;
    }
    const optional = raw.startsWith("[");
    const body = raw.replace(/^\[|\]$/g, "");
    const [pname, ...type] = body.split(/\s+/);
    parameters.push({ name: pname, ...(type.length ? { type: type.join(" ") } : {}), ...(optional ? { optional } : {}) });
  }
  return {
    name,
    kind: "function",
    parameters,
    ...(returnType ? { returnType } : {}),
    documentation,
    ...(repeat ? { repeat } : {}),
  };
}

/** Built-in SQL function signatures by upper-case name. */
export const BUILTIN_SIGNATURES: ReadonlyMap<string, OracleSignature[]> = new Map(
  BUILTIN_SPECS.map(([spec, doc]) => {
    const sig = parseSpec(spec, doc);
    return [sig.name, [sig]];
  }),
);

/** Built-in signatures for a call (unqualified names only). */
export function builtinSignatures(call: Pick<CallSite, "parts" | "quoted">): OracleSignature[] {
  if (call.parts.length !== 1 || call.quoted[0]) return [];
  return BUILTIN_SIGNATURES.get(call.parts[0].toUpperCase()) ?? [];
}

/**
 * Parameters still available for `name => ` at this call: every parameter
 * of every overload not yet passed by name (positional arguments consume
 * the leading parameters).
 */
export function namedParameterCandidates(signatures: OracleSignature[], call: CallSite): OracleParameter[] {
  const used = new Set(call.namedArgs.map(norm));
  const positional = call.namedArgs.length ? 0 : call.argIndex; // named notation can't precede positional
  const out = new Map<string, OracleParameter>();
  for (const sig of signatures) {
    sig.parameters.forEach((p, i) => {
      if (i < positional || used.has(norm(p.name)) || out.has(norm(p.name))) return;
      out.set(norm(p.name), p);
    });
  }
  return [...out.values()];
}
