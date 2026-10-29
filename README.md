# Monaco based SQL Editor for Oracle

> English · [한국어](./README.ko.md)

An **Oracle SQL / PL/SQL editor** component for React, built on the Monaco Editor.
Its architecture is based on [`trino-monaco-sql-editor`](https://github.com/DataDynamics-OSS/trino-monaco-sql-editor).

- Design document: [`docs/DESIGN.md`](./docs/DESIGN.md) (Korean)
- Current stage: **Phase 4 (Polish)** complete — signature help and named-argument completion, hover, server-side validation (EXPLAIN PLAN), `targetVersion` syntax gating, multi-editor routing, review of common-core extraction

![Oracle Monaco Editor — light theme](./docs/screenshot-light.png)

## Features

- Registers the `oracle` language (Monarch tokenizer + language configuration)
  - `q'[…]'` alternative quoting, `N'…'`, optimizer hints `/*+ … */`, bind variables `:name`,
    substitution variables `&var`, `@dblink`, `%TYPE`/`%ROWTYPE`, `<<label>>`, the stand-alone `/` terminator line
  - `$` and `#` are identifier characters (`V$SESSION`)
  - `REPLACE(…)` followed by `(` is a function, while `OR REPLACE` is a keyword
- Light / Dark themes
- Static completion: keywords, PL/SQL keywords, built-in functions, built-in packages (`DBMS_*`, `UTL_*`),
  pseudo-columns, types + a host-supplied `metadataProvider`
- **Per-editor routing**: with several editors (tabs) on one page, completion, signature help and hover each use their own `metadataProvider`
- Keyword exposure and **syntax gating** by `targetVersion` (`19c` default and minimum / `21c` / `23ai`) (see below)
- **Signature help** (`(` `,`), **named-argument `p_name =>` completion**, **hover** (tables, columns, routines, sequences, PL/SQL variables)
- **Server-side validation** (optional): shows ORA-00942 / ORA-00904 etc. as markers via `EXPLAIN PLAN`, without executing anything
- **Statement splitting** (SQL*Plus / SQL Developer rules)
  - SQL ends with `;` or a stand-alone `/` line; the `;` is stripped from the executable text
  - PL/SQL (`DECLARE`, `BEGIN`, `CREATE [OR REPLACE] PROCEDURE|FUNCTION|PACKAGE [BODY]|TRIGGER|TYPE …`, `WITH FUNCTION`) is one statement up to `/`
  - `;` and `/` inside strings, q-quotes, comments and quoted identifiers are ignored
  - SQL*Plus commands (`SET`, `DEFINE`, `PROMPT`, `EXEC`, `@file`, `DESC`, … including abbreviations) are line-based; `EXEC p` → `BEGIN p; END;`
  - Optional: blank lines separate SQL statements (`statementSeparator={{ blankLine: true }}`)
- Helpers to detect **substitution variables** `&x` / `&&x` (including inside strings, with `DEFINE` parsing) and **bind variables** `:x`
- **Actions**

  | Key | Action | Callback |
  |---|---|---|
  | `Ctrl/Cmd+Enter` | Run Statement — the statement at the cursor (or the selected statement) | `onRunStatement` / `onRunQuery` |
  | `F5` | Run Script — all statements (or those in the selection) | `onRunScript` |
  | `F10` | Explain Plan — the current SQL statement | `onExplainPlan` |
  | `Shift+F1` / `Ctrl/Cmd+Click` | Show Help — usage (syntax, description, examples) of the function, reserved word, pseudo-column, type or package under the cursor + a link to the `targetVersion` manual | `help` |
  | `Shift+F4` | Describe — the object name under the cursor (`hr.employees`, `emp@prod`) | `onDescribe` |
  | `Shift+Alt+F` | Prettify | `formatter` |
  | `Ctrl/Cmd+'` | Toggle Case — skips strings and comments | — |

  Selecting several statements and pressing `Ctrl/Cmd+Enter` sends them to `onRunScript` (without it, only the first statement goes to `onRunStatement`).
- **Current statement highlight**: when there are two or more statements, the statement at the cursor gets a background and a gutter bar
- Formatter: preserves strings, q-quotes, comments and hints as-is, keeps `;`/`/` terminators and blank lines between statements, leaves SQL*Plus commands untouched,
  does not break inside function calls (`EXTRACT(YEAR FROM d)`), and indents PL/SQL blocks (`DECLARE/BEGIN/EXCEPTION/END`, `IF/ELSIF/ELSE`, `LOOP`, `CASE`, header `IS/AS`)

### Context-aware completion (`contextAware`)

A Web Worker parses **only the statement at the cursor** with an ANTLR grammar (`src/grammar/OracleSql.g4`),
and [antlr4-c3](https://github.com/mike-lischke/antlr4-c3) suggests only what the grammar allows at the cursor.

| Cursor | Suggestions |
|---|---|
| `FROM \|` | CTE names, metadata tables/schemas/synonyms, `TABLE` `LATERAL` `ONLY` |
| `FROM hr.\|` | Objects in the HR schema (metadata) |
| `SELECT \| FROM emp e` | Alias `e`, columns of in-scope tables, functions, packages, pseudo-columns, expression keywords |
| `WHERE e.\|` | Only the columns of the table aliased `e` |
| `x.\|` (CTE, inline view, cursor loop record) | Columns derived from the statement (no metadata lookup) |
| `r.\|` (`r emp%ROWTYPE`) / `:new.\|` (trigger) | Columns of that table |
| `DECLARE v \|` / `CAST(x AS \|)` | Types, `CONSTANT`, etc. |
| `BEGIN \|` | Procedures/packages, declared variables and parameters, `IF` `LOOP` `NULL` … |
| `emp@\|` | DB links (metadata) |
| `MERGE … WHEN \|` / `FETCH \|` | `MATCHED` `NOT` / `FIRST` `NEXT` |

- Collects the names the statement itself declares: table aliases (including DML targets and MERGE sources), CTE and inline-view columns, PL/SQL variables, constants, parameters, cursors, exceptions and types, cursor FOR loop records, `%ROWTYPE` records, trigger `:NEW`/`:OLD`
- Dictionary-name insertion: names containing lowercase letters, special characters or reserved words are automatically quoted as `"..."`; otherwise `identifierCase` applies (typed in lowercase → inserted in lowercase)
- **Syntax validation markers** `validateOnType`: `"sql"` (default) / `"all"` (including PL/SQL) / `false`. Only the first error per statement is shown

`metadataProvider` receives this context:

```ts
{
  word, text, position,
  expectTable, expectColumn, expectFunction, expectProcedure, expectType, expectDbLink,
  qualifier: ["e"],               // `e.` / `hr.` / `dbms_output.` / `:new.`
  qualifierQuoted: [false],       // quoted parts compare case-sensitively, others in uppercase
  aliases: [{ alias: "e", table: "hr.employees", kind: "table", dbLink?: "prod" }],
  ctes: [{ name: "x", columns: ["a", "b"] }],
  statementKind: "sql" | "plsql" | "sqlplus" | "none",
}
```

### Database connection (Phase 3)

Browsers cannot speak Oracle Net, so requests go through a server. The editor depends only on the `OracleTransport` interface.

| Transport | Server | Characteristics |
|---|---|---|
| `createGatewayTransport()` (**recommended**) | [`servers/server-node/`](./servers/server-node/README.md) — Fastify + node-oracledb Thin<br>(same API: [`servers/server-python/`](./servers/server-python/README.md) FastAPI + python-oracledb, [`servers/server-java/`](./servers/server-java/README.md) Spring Boot + ojdbc11) | **A dedicated Oracle session per user**: transactions, `ALTER SESSION`, server-side cursor paging, cancellation via `connection.break()`, DBMS_OUTPUT. httpOnly cookie authentication, rejects databases older than 19c |
| `createOrdsTransport()` | ORDS REST-Enabled SQL | No server development needed. A new session per request (no transactions or session state), paging re-executes with an offset, cancellation only aborts the HTTP request |
| `createMockTransport()` | None | Tests and offline use |

```tsx
import {
  OracleEditor, createGatewayTransport, createOracleMetadataProvider, createOracleQueryRunner,
} from "@datadynamics/oracle-monaco";

const transport = createGatewayTransport({ baseUrl: "/api" });
await transport.login({ connectAlias: "dev", user, password });     // the password is sent only this once

const metadata = createOracleMetadataProvider({ transport });          // ALL_* dictionary, cache, synonym resolution
const runner = createOracleQueryRunner({
  transport, metadata,
  onBindPrompt: async (names) => askUser(names),                       // :bind values
  onSubstitutionPrompt: async (name) => askUser(name),                 // &var values
});

<OracleEditor
  contextAware
  metadataProvider={metadata}
  executionErrors={errors}                                             // ORA error / PL/SQL compile error markers
  onRunStatement={async (stmt) => {
    try { const r = await runner.run(stmt); show(r); setErrors(r.compileErrors ?? []); }
    catch (e) { setErrors([e]); }                                      // OracleQueryError: code, line, column
  }}
  onRunScript={async (stmts) => { for await (const r of runner.runScript(stmts)) append(r); }}
  onExplainPlan={async (stmt) => showPlan((await runner.explain(stmt)).lines)}
  onDescribe={async (name) => show(await runner.describe(name))}
/>;
```

What the runner (`createOracleQueryRunner`) handles:

- `&var` / `&&var` substitution (`DEFINE`/`UNDEFINE`, prompts when undefined), `:bind` values (call arguments → remembered values → prompt)
- SQL*Plus commands: `SET SERVEROUTPUT ON|OFF`, `SET DEFINE`, `DEFINE`, `UNDEFINE`, `PROMPT`, `EXEC`, `DESC`, `WHENEVER SQLERROR EXIT|CONTINUE` (others produce an "ignored" message)
- Result paging (`fetchMore`), cancellation (`AbortSignal` → server `break()`), SQL*Plus-style feedback (`3 rows updated.`, `Procedure created with compilation errors.`)
- ORA error positions in **document coordinates** (mapped back to the original text even when substitution changes the length), and compile-error positions from `ALL_ERRORS` after creating PL/SQL
- Invalidates the metadata cache after DDL and `ALTER SESSION SET CURRENT_SCHEMA`, `explain()` (EXPLAIN PLAN + DBMS_XPLAN), `describe()` (with synonym resolution)

### Signature help · hover · server-side validation (Phase 4)

| Feature | Behavior | Source |
|---|---|---|
| Signature help | `nvl(a, \|` → highlights the active parameter, picks overloads (by argument count and named arguments), repeating arguments of `DECODE`/`COALESCE` | Built-in SQL function table (offline) + `metadataProvider.signatures` (`ALL_ARGUMENTS`) |
| Named-argument completion | `hr_pkg.raise_salary(\|` → `P_EMP_ID =>`, `P_PCT =>` (excluding names already written and parameters consumed by positional arguments) | `metadataProvider.signatures` |
| Hover | Alias `e` → table + column list and comments, `e.salary` → type, NOT NULL and comment, synonym resolution, `pkg.proc` signature, sequence settings, `INVALID` status, PL/SQL variable types, built-in function signatures | `metadataProvider.describe` + worker scope (`contextAware`) |
| Built-in help | `Shift+F1` / `Ctrl/Cmd+Click` (or hover): ~250 built-in functions, ~90 reserved words and statements (context-aware: `CREATE TABLE`, PL/SQL `FETCH` vs `FETCH FIRST`, `FOR` loop vs `FOR UPDATE`, `%TYPE`, …), pseudo-columns, types and Oracle-supplied packages → syntax, description, examples + links to the Oracle 19c/21c/23ai manuals. The shortcut works even with `hover={false}` | `oracle/docs.ts` (offline) |
| Server-side validation | When typing pauses (1.2 s by default), only changed SELECT/DML statements are sent as `EXPLAIN PLAN FOR …` → ORA error position markers (owner `oracle-server`) | `createServerValidator({ transport })` |
| Version gating | Syntax newer than `targetVersion` is hidden from completion (`IF` of `IF [NOT] EXISTS`, `QUALIFY`, …) and warned about in validation (`IF [NOT] EXISTS`, `SELECT` without `FROM`, SQL `BOOLEAN`/`TRUE`/`FALSE`) | Worker |

```tsx
const metadata = createOracleMetadataProvider({ transport });   // includes signatures() / describe()
const validator = createServerValidator({
  transport,
  substitutionVariables: runner.variables,   // defined &vars are substituted; undefined ones are skipped
  paused: () => running,                      // hold off while the same session is running something
});

<OracleEditor contextAware metadataProvider={metadata} serverValidator={validator} targetVersion="19c" />;
```

- Server-side validation sends **only SELECT / WITH / INSERT / UPDATE / DELETE / MERGE**. DDL is executed at parse time, so it is never sent. PL/SQL and SQL*Plus commands are excluded too.
- Binds are bound as NULL (no effect on the plan), and PLAN_TABLE rows are deleted right after (skipped for ORDS, whose session ends with each request).
  Statements with client-side syntax errors and environment errors — missing PLAN_TABLE, view-based object privileges (ORA-01039), session errors — do not produce markers.
- Results are cached by statement text, so editing another statement does not resend them. The cache is cleared when `serverValidator` changes (e.g. on reconnect).
- A gateway session is a single connection, so EXPLAIN queues behind a long-running query → hold it with `paused`, or use a dedicated validation session (a separate transport).
- With a hand-written provider, attach `signatures` / `describe` properties to the function or pass them as the `signatureProvider` / `describeProvider` props.

## Development

```bash
npm install
npm run dev          # demo (offline sample metadata, HR / SCOTT tabs)
npm test             # scanner / splitter / format / keywords / core / grammar / runner / metadata / signature (Node, no DB needed)
npm run test:gateway # servers/server-node gateway HTTP, session and auth tests (fake driver, no DB needed)
npm run gateway      # run the gateway (CONNECT_ALIASES etc. — servers/server-node/README.md)
(cd servers/server-python && .venv/bin/python -m pytest)   # Python gateway tests (servers/server-python/README.md)
(cd servers/server-java && mvn test)                      # Java gateway tests (servers/server-java/README.md)
npm run gen:parser   # src/grammar/OracleSql.g4 → src/generated (requires Java)
npm run typecheck
npm run build        # dist/ (ES module + d.ts)
npm run build:demo   # dist-demo/
```

End-to-end tests against a real database (optional):

```bash
# 1) Oracle Free container + a gateway (any one of the three)
docker run -d -p 1521:1521 -e ORACLE_PASSWORD=... -e APP_USER=scott -e APP_USER_PASSWORD=... gvenzl/oracle-free:23-slim-faststart
export CONNECT_ALIASES='{"free":{"connectString":"localhost:1521/FREEPDB1"}}' SECURE_COOKIE=false ALLOW_HEADER_AUTH=true
npm run gateway                                                         # Node
(cd servers/server-python && .venv/bin/python -m oracle_monaco_gateway) # Python
(cd servers/server-java && mvn -q package -DskipTests && java -jar target/oracle-monaco-gateway.jar)  # Java

# 2) Tests / demo through the gateway (Vite proxies /api to the gateway; change it with VITE_ORACLE_GATEWAY)
ORACLE_GATEWAY_URL=http://127.0.0.1:8787/api ORACLE_ALIAS=free ORACLE_USER=scott ORACLE_PASSWORD=... npm run test:live
npm run dev

# 3) ORDS (requires restEnabledSql.active=true and ORDS.ENABLE_SCHEMA)
ORDS_URL=http://ords-host:8080/ords ORDS_SCHEMA=scott ORDS_USER=scott ORDS_PASSWORD=... npm run test:live:ords
```

The demo loads Monaco from the local bundle rather than a CDN (`loader.config({ monaco })` in `src/main.tsx`).
The library itself follows the default behavior of `@monaco-editor/react`, so on air-gapped networks the host app should use the same setting.

## Usage

```tsx
import { OracleEditor, toExecutable } from "@datadynamics/oracle-monaco";

<OracleEditor
  value={sql}
  onChange={setSql}
  theme="dark"
  targetVersion="19c"
  metadataProvider={async ({ word }) => lookup(word)}   // [{ label, kind: "table" | "column" | …, detail }]
  onRunStatement={(stmt) => run(toExecutable(stmt))}     // stmt.kind: "sql" | "plsql" | "sqlplus"
  onRunScript={(stmts) => runAll(stmts)}
  onExplainPlan={(stmt) => explain(stmt.text)}
  onDescribe={(name) => describe(name)}
/>;
```

## Props

| Prop | Type | Default | Description |
|---|---|---|---|
| `value` / `defaultValue` / `onChange` | | | Controlled / uncontrolled value |
| `onRunStatement` | `(stmt: SqlStatement, editor) => void` | — | `Ctrl/Cmd+Enter` |
| `onRunScript` | `(stmts: SqlStatement[], editor) => void` | — | `F5`, or `Ctrl/Cmd+Enter` with several statements selected |
| `onExplainPlan` | `(stmt: SqlStatement, editor) => void` | — | `F10` (SQL statements only) |
| `onDescribe` | `(objectName, editor) => void` | — | `Shift+F4` |
| `onRunQuery` | `(sql, editor) => void` | — | trino-monaco compatible: the text to execute (with `EXEC` conversion, excluding SQL*Plus-only commands) |
| `highlightCurrentStatement` | `boolean` | `true` | Highlight the current statement |
| `statementSeparator` | `{ blankLine?: boolean }` | `{}` | Blank-line statement separation |
| `theme` | `"light" \| "dark"` | `"light"` | |
| `readOnly` | `boolean` | `false` | |
| `languageElements` | `Partial<OracleLanguageElements>` | built-in | Override the completion lists |
| `targetVersion` | `"19c" \| "21c" \| "23ai"` | `"19c"` | Version-specific keywords + syntax gating (hidden from completion, warned in validation) |
| `keywordCase` | `"upper" \| "lower" \| "preserve"` | `"preserve"` | Insertion case |
| `metadataProvider` | `MetadataProvider` | — | Schema/table/column suggestions. Its `signatures` / `describe` properties, if present, also feed signature help and hover |
| `signatureHelp` | `boolean` | `true` | Parameter hints on `(` `,` |
| `hover` | `boolean` | `true` | Name hover |
| `help` | `boolean` | `true` | `Shift+F1` / `Ctrl/Cmd+Click` help (works even with `hover={false}`) |
| `fontFamily` | `string` | D2Coding Ligature stack | Code font (CSS font-family). Recommended list: `ORACLE_EDITOR_FONTS` (D2Coding Ligature, JetBrains Mono, Fira Code, Cascadia Code, Source Code Pro, IBM Plex Mono). The host page loads the font files; once loaded, the editor re-measures glyph widths |
| `fontLigatures` | `boolean` | `true` | Show ligatures (`=>` `!=` `>=` `\|\|`) |
| `locale` | `"en" \| "ko" \| "ja" \| "zh"` | `"en"` | UI language: action labels (context menu), hover, built-in help descriptions, signature help descriptions, syntax-check messages |
| `signatureProvider` | `SignatureSource` | `metadataProvider.signatures` | Routine overload provider |
| `describeProvider` | `DescribeSource` | `metadataProvider.describe` | Name resolution for hover |
| `serverValidator` | `ServerValidator` | — | `createServerValidator(...)`: EXPLAIN PLAN server-side validation (off when absent) |
| `serverValidateDelay` | `number` | `1200` | Server-side validation debounce (ms) |
| `contextAware` | `boolean` | `false` | ANTLR/c3 worker context-aware completion + validation (applied once on mount) |
| `validateOnType` | `"sql" \| "all" \| false` | `"sql"` | Syntax error markers (with `contextAware`) |
| `identifierCase` | `"upper" \| "lower" \| "preserve"` | `"preserve"` | Insertion case for dictionary names (names that need quoting are always quoted) |
| `executionErrors` | `ExecutionMarker[]` | — | Execution / compile error markers (`OracleQueryError` and `CompileError` can be passed as-is) |
| `formatter` | `Formatter` | built-in | |
| `options` / `height` / `width` / `className` / `onMount` | | | Monaco options, etc. |

> Syntax-highlighting keywords are applied once, at the first registration per Monaco instance. Changes to `languageElements` and `targetVersion` are reflected in completion.

## Layout

```
src/
  OracleEditor.tsx       React component
  index.ts               public API
  core/                  dialect-agnostic (extracted from trino-monaco)
    completionItems.ts   applyCase / dedupeByLabel
    completionRouter.ts  per-model-URI provider routing (completion / signature help / hover)
    editorActions.ts     selectedOrAll / prettifyEditor
    styles.ts            one-time style injection
  oracle/
    language.ts          Monarch tokenizer + language configuration
    keywords.ts          keywords / functions / types / pseudo-columns / packages / version-specific keywords
    scanner.ts           lightweight lexical scanner (strings, comments, hints)
    splitter.ts          statement splitting (SQL / PL/SQL / SQL*Plus)
    variables.ts         substitution variables / DEFINE / bind variables
    editorStatements.ts  statement cache, selection splitting, object-name extraction, Toggle Case
    format.ts            formatter (PL/SQL indentation)
    identifiers.ts       uppercase normalization / quoting decisions / name splitting
    metadata.ts          createOracleMetadataProvider (ALL_* dictionary)
    runner.ts            createOracleQueryRunner (statement/script execution, SQL*Plus commands, error positions)
    explain.ts           EXPLAIN PLAN + DBMS_XPLAN
    signatures.ts        call-site analysis (callAt), built-in function signatures, overload/parameter selection
    signatureHelp.ts     Monaco SignatureHelpProvider + `name =>` completion items
    hover.ts             Monaco HoverProvider + object-info Markdown rendering
    docs.ts              built-in help (functions, reserved words, pseudo-columns, types, packages) + manual URLs
    fonts.ts             recommended code fonts (ORACLE_EDITOR_FONTS)
    i18n/                UI strings (en/ko/ja/zh) + help translations (docs.ko/ja/zh.ts, keyed by `OracleDocEntry.id`)
    serverValidate.ts    createServerValidator (EXPLAIN PLAN, no execution)
    transport/           types (OracleTransport) · gateway · ords · mock · auth
    completion.ts        static completion provider + metadata types
    setup.ts             language/theme/router registration
    themes.ts / options.ts
  grammar/OracleSql.g4   reduced grammar for context-aware completion (SQL + PL/SQL subset)
  generated/             ANTLR output (npm run gen:parser)
  worker/
    completionCore.ts    statement parsing + antlr4-c3 + scope collection (pure logic)
    versionGate.ts       targetVersion keyword filter + new-syntax warnings
    contextProvider.ts   context → Monaco suggestions (+ metadataProvider calls)
    completion.worker.ts / client.ts / protocol.ts
  App.tsx / main.tsx     demo
servers/                 gateways (same API and security model)
  server-node/           Fastify + node-oracledb Thin — servers/server-node/README.md
  server-python/         FastAPI + python-oracledb Thin
  server-java/           Spring Boot 4 + ojdbc11
scripts/                 Node tests (tsx), test-live*.ts (real DB), gen-parser.mjs
```

## License

[MIT](./LICENSE). See [`NOTICE`](./NOTICE) for third-party notices.
