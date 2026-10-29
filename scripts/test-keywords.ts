/* Node test for the language element lists. Run: npx tsx scripts/test-keywords.ts */
import {
  DEFAULT_LANGUAGE_ELEMENTS,
  ORACLE_VERSIONED_KEYWORDS,
  resolveLanguageElements,
} from "../src/oracle/keywords.js";
import { applyCase } from "../src/core/completionItems.js";
import { assert, done, eq, section } from "./harness.js";

section("element lists");
for (const [name, list] of Object.entries(DEFAULT_LANGUAGE_ELEMENTS)) {
  const dupes = list.filter((v, i) => list.indexOf(v) !== i);
  eq(`${name}: no duplicates`, dupes, []);
  assert(`${name}: all UPPER case`, list.every((v) => v === v.toUpperCase()));
}

section("targetVersion gating");
{
  const v19 = resolveLanguageElements(undefined, "19c").keywords;
  const v21 = resolveLanguageElements(undefined, "21c").keywords;
  const v23 = resolveLanguageElements(undefined, "23ai").keywords;
  assert("19c excludes 21c keywords", !ORACLE_VERSIONED_KEYWORDS["21c"].some((k) => v19.includes(k)));
  assert("21c includes QUALIFY", v21.includes("QUALIFY"));
  assert("21c excludes 23ai VECTOR", !v21.includes("VECTOR"));
  assert("23ai includes VECTOR and QUALIFY", v23.includes("VECTOR") && v23.includes("QUALIFY"));
  assert("default is 19c", resolveLanguageElements().keywords.length === v19.length);
}

section("overrides");
{
  const e = resolveLanguageElements({ functions: ["MY_UDF"] });
  eq("functions override replaces list", e.functions, ["MY_UDF"]);
  assert("other lists keep defaults", e.types === DEFAULT_LANGUAGE_ELEMENTS.types);
}

section("applyCase");
eq("preserve + empty prefix -> UPPER", applyCase("select", ""), "SELECT");
eq("preserve + upper prefix -> UPPER", applyCase("select", "SEL"), "SELECT");
eq("preserve + lower prefix -> lower", applyCase("SELECT", "sel"), "select");
eq("preserve + mixed prefix -> lower", applyCase("SELECT", "Sel"), "select");
eq("upper mode", applyCase("select", "sel", "upper"), "SELECT");
eq("lower mode", applyCase("SELECT", "SEL", "lower"), "select");

done();
