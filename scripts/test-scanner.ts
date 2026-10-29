/* Node test for the lexical scanner. Run: npx tsx scripts/test-scanner.ts */
import { scan, type SegmentType } from "../src/oracle/scanner.js";
import { done, eq, section } from "./harness.js";

const types = (sql: string) => scan(sql).map((s) => s.type);
const texts = (sql: string, t: SegmentType) =>
  scan(sql).filter((s) => s.type === t).map((s) => s.text);

section("coverage");
{
  const sql = "SELECT 'a' || q'[b;c]' FROM \"T\" -- x\n/* y */ /*+ FULL(t) */";
  const segs = scan(sql);
  eq("segments re-join to the input", segs.map((s) => s.text).join(""), sql);
  eq("offsets are contiguous", segs.every((s, i) => i === 0 || s.start === segs[i - 1].end), true);
}

section("string literals");
eq("plain string", texts("x = 'a;b'", "string"), ["'a;b'"]);
eq("escaped quote", texts("x = 'it''s'", "string"), ["'it''s'"]);
eq("N'' national string", texts("x = N'abc'", "string"), ["N'abc'"]);
eq("q'[ ]' keeps inner quote", texts("x = q'[it's]' y", "string"), ["q'[it's]'"]);
eq("q'{ }'", texts("q'{a}'b", "string"), ["q'{a}'"]);
eq("q'( )'", texts("q'(a)'", "string"), ["q'(a)'"]);
eq("q'< >'", texts("q'<a>'", "string"), ["q'<a>'"]);
eq("q'! !' custom delimiter", texts("q'!a'b!' c", "string"), ["q'!a'b!'"]);
eq("nq'[ ]'", texts("NQ'[x]'", "string"), ["NQ'[x]'"]);
eq("identifier ending in q is not a q-quote", texts("seq'x'", "string"), ["'x'"]);
eq("unterminated string runs to end", texts("x = 'abc", "string"), ["'abc"]);

section("identifiers / comments / hints");
eq("quoted identifier", texts('SELECT "My Col" FROM t', "quotedIdent"), ['"My Col"']);
eq("line comment excludes newline", texts("a -- c\nb", "lineComment"), ["-- c"]);
eq("block comment", texts("a /* c */ b", "blockComment"), ["/* c */"]);
eq("optimizer hint", texts("SELECT /*+ FULL(t) */ 1", "hint"), ["/*+ FULL(t) */"]);
eq("-- inside a string is not a comment", types("'--x'"), ["string"]);
eq("quote inside a comment is not a string", types("-- it's"), ["lineComment"]);

done();
