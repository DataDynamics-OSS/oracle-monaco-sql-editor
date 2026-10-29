/*---------------------------------------------------------------------------------------------
 *  Oracle SQL / PL/SQL language definition for Monaco.
 *
 *  Derived from the Monaco Editor open-source SQL language definition
 *  (microsoft/monaco-editor, `src/basic-languages/sql/sql.ts`, MIT License,
 *  Copyright (c) Microsoft Corporation) by way of trino-monaco (MIT).
 *  Adapted here for Oracle:
 *    - `N'…'` and alternative quoting `q'[…]'`, `q'{…}'`, `q'(…)'`, `q'<…>'`, `q'!…!'`
 *    - double-quoted identifiers only; `[]` is not a bracket in Oracle
 *    - optimizer hints `/*+ … *\/`, bind variables `:name` / `:1`,
 *      substitution variables `&name` / `&&name`, `@dblink`, `<<label>>`
 *    - `%TYPE` / `%ROWTYPE` / cursor attributes, `:=`, `=>`, `||`, `**`, `..`, `(+)`
 *    - SQL*Plus terminator: a line containing only `/`
 *    - `$` and `#` are identifier characters (e.g. `V$SESSION`)
 *    - keyword lists are injected at registration time (see setup.ts)
 *--------------------------------------------------------------------------------------------*/

import type { languages } from "monaco-editor";

/** Oracle language id used to register with Monaco. */
export const ORACLE_LANGUAGE_ID = "oracle";

/** Language configuration: comments, brackets, auto-closing & surrounding pairs. */
export const oracleLanguageConf: languages.LanguageConfiguration = {
  comments: {
    lineComment: "--",
    blockComment: ["/*", "*/"],
  },
  // `$` and `#` are valid identifier characters (V$SESSION, SYS#X).
  wordPattern: /(-?\d*\.\d\w*)|([^`~!@%^&*()\-=+[{\]}\\|;:'",.<>/?\s]+)/g,
  brackets: [["(", ")"]],
  autoClosingPairs: [
    { open: "(", close: ")" },
    { open: '"', close: '"', notIn: ["string", "comment"] },
    { open: "'", close: "'", notIn: ["string", "comment"] },
  ],
  surroundingPairs: [
    { open: "(", close: ")" },
    { open: '"', close: '"' },
    { open: "'", close: "'" },
  ],
};

/** PL/SQL cursor / type attributes that follow `%`. */
const ATTRIBUTES =
  /%(?:TYPE|ROWTYPE|ROWCOUNT|FOUND|NOTFOUND|ISOPEN|BULK_ROWCOUNT|BULK_EXCEPTIONS)\b/;

/**
 * Monarch tokenizer for Oracle SQL / PL/SQL.
 *
 * `keywords`, `operators`, `builtinFunctions`, `builtinVariables` (pseudo
 * columns), `typeKeywords` and `builtinPackages` are populated at registration
 * time from the configured language elements (see setup.ts).
 */
export const oracleLanguage: languages.IMonarchLanguage = {
  defaultToken: "",
  tokenPostfix: ".oracle",
  ignoreCase: true,

  brackets: [{ open: "(", close: ")", token: "delimiter.parenthesis" }],

  // Populated at registration time.
  keywords: [],
  operators: [],
  builtinFunctions: [],
  builtinVariables: [],
  typeKeywords: [],
  builtinPackages: [],

  tokenizer: {
    root: [
      // SQL*Plus / SQL Developer statement terminator: `/` alone on a line.
      [/^\s*\/\s*$/, "delimiter.terminator"],
      { include: "@comments" },
      { include: "@whitespace" },
      { include: "@strings" },
      { include: "@numbers" },
      [/"/, { token: "identifier.quote", next: "@quotedIdentifier" }],
      [/<<[A-Za-z][\w$#]*>>/, "tag"],
      [/:(?:[A-Za-z][\w$#]*|\d+)/, "variable"],
      [/&&?[A-Za-z][\w$#]*\.?/, "variable.substitution"],
      [/@[A-Za-z][\w$#]*(?:\.[A-Za-z][\w$#]*)*/, "identifier.dblink"],
      [ATTRIBUTES, "keyword.attribute"],
      // A word followed by `(` is a call: prefer function colouring (REPLACE(…)).
      [
        /[A-Za-z][\w$#]*(?=\s*\()/,
        {
          cases: {
            "@builtinFunctions": "predefined",
            "@typeKeywords": "type",
            "@keywords": "keyword",
            "@operators": "operator",
            "@default": "identifier",
          },
        },
      ],
      [
        /[A-Za-z][\w$#]*/,
        {
          cases: {
            "@operators": "operator",
            "@builtinVariables": "predefined",
            "@typeKeywords": "type",
            "@builtinPackages": "namespace",
            "@keywords": "keyword",
            "@builtinFunctions": "predefined",
            "@default": "identifier",
          },
        },
      ],
      [/\(\+\)/, "operator"],
      [/:=|=>|\|\||\*\*|\.\.|<>|!=|\^=|~=|<=|>=/, "operator"],
      [/[;,.]/, "delimiter"],
      [/[()]/, "@brackets"],
      [/[<>=!+\-*/|^~%]/, "operator"],
    ],

    whitespace: [[/\s+/, "white"]],

    comments: [
      [/--.*$/, "comment"],
      [/\/\*\+/, { token: "comment.hint", next: "@hint" }],
      [/\/\*/, { token: "comment.quote", next: "@comment" }],
    ],
    comment: [
      [/[^*/]+/, "comment"],
      // Oracle does not support nested block comments.
      [/\*\//, { token: "comment.quote", next: "@pop" }],
      [/./, "comment"],
    ],
    hint: [
      [/[^*]+/, "comment.hint"],
      [/\*\//, { token: "comment.hint", next: "@pop" }],
      [/\*/, "comment.hint"],
    ],

    numbers: [
      [/0[xX][0-9a-fA-F]+/, "number"],
      [/\d*\.\d+(?:[eE][-+]?\d+)?[fFdD]?/, "number.float"],
      [/\d+(?:[eE][-+]?\d+)?[fFdD]?/, "number"],
    ],

    strings: [
      // Alternative quoting: the closing delimiter mirrors the opening bracket.
      [/[nN]?[qQ]'\[/, { token: "string", next: "@qstring.]" }],
      [/[nN]?[qQ]'\{/, { token: "string", next: "@qstring.}" }],
      [/[nN]?[qQ]'\(/, { token: "string", next: "@qstring.)" }],
      [/[nN]?[qQ]'</, { token: "string", next: "@qstring.>" }],
      [/[nN]?[qQ]'([^\s.])/, { token: "string", next: "@qstring.$1" }],
      [/[nN]?'/, { token: "string", next: "@string" }],
    ],
    string: [
      [/[^']+/, "string"],
      [/''/, "string.escape"],
      [/'/, { token: "string", next: "@pop" }],
    ],
    qstring: [
      [
        /(.)'/,
        {
          cases: {
            "$1==$S2": { token: "string", next: "@pop" },
            "@default": "string",
          },
        },
      ],
      [/./, "string"],
    ],

    quotedIdentifier: [
      [/[^"]+/, "identifier"],
      [/"/, { token: "identifier.quote", next: "@pop" }],
    ],
  },
};
