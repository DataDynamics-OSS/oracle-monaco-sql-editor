import { useEffect, useMemo, useRef, useState } from "react";
import { OracleEditor, type ExecutionMarker } from "./OracleEditor";
import type { MetadataProvider, OracleMetadataItem } from "./oracle/completion";
import type { OracleVersion } from "./oracle/keywords";
import type { SqlStatement } from "./oracle/splitter";
import { createGatewayTransport, type ConnectAlias, type LoginResponse } from "./oracle/transport/gateway";
import { createOracleMetadataProvider } from "./oracle/metadata";
import { createOracleQueryRunner, OracleQueryError, type StatementResult } from "./oracle/runner";
import { createServerValidator } from "./oracle/serverValidate";
import type { OracleSignature } from "./oracle/signatures";
import { ORACLE_LOCALES, type OracleLocale } from "./oracle/i18n";
import { APP_STRINGS, initialFont, initialLocale, saveFont, saveLocale, type AppStrings } from "./appStrings";
import { DEFAULT_ORACLE_EDITOR_FONT, ORACLE_EDITOR_FONTS } from "./oracle/fonts";

const SAMPLE_HR = `-- Oracle sample: HR schema
SELECT /*+ INDEX(e emp_dept_ix) */ e.employee_id, e.last_name, d.department_name,
       NVL(e.commission_pct, 0) AS comm, q'[It's a q-quote; not a terminator]' AS note
FROM hr.employees e JOIN hr.departments d ON d.department_id = e.department_id
WHERE e.hire_date >= DATE '2020-01-01' AND e.salary > :min_salary
ORDER BY e.last_name
FETCH FIRST 50 ROWS ONLY;

DECLARE
  v_name employees.last_name%TYPE;
BEGIN
  <<lookup>>
  SELECT last_name INTO v_name FROM employees WHERE employee_id = &emp_id;
  DBMS_OUTPUT.PUT_LINE('Name: ' || v_name);
  hr_pkg.raise_salary(p_emp_id => 100, p_pct => 5);
EXCEPTION
  WHEN NO_DATA_FOUND THEN NULL;
END;
/
`;

const SAMPLE_SCOTT = `-- Second editor: SCOTT schema (separate metadata)
SET SERVEROUTPUT ON
EXEC DBMS_OUTPUT.PUT_LINE('hello');

SELECT ename, sal, LEVEL
FROM scott.emp
START WITH mgr IS NULL
CONNECT BY PRIOR empno = mgr;
`;

type Tables = Record<string, { name: string; type: string }[]>;

/** Current demo strings for the module-level sample metadata (set by App on render). */
let strings: AppStrings = APP_STRINGS.en;

const HR_TABLES: Tables = {
  EMPLOYEES: [
    { name: "EMPLOYEE_ID", type: "NUMBER(6)" },
    { name: "LAST_NAME", type: "VARCHAR2(25)" },
    { name: "SALARY", type: "NUMBER(8,2)" },
    { name: "COMMISSION_PCT", type: "NUMBER(2,2)" },
    { name: "HIRE_DATE", type: "DATE" },
    { name: "DEPARTMENT_ID", type: "NUMBER(4)" },
  ],
  DEPARTMENTS: [
    { name: "DEPARTMENT_ID", type: "NUMBER(4)" },
    { name: "DEPARTMENT_NAME", type: "VARCHAR2(30)" },
  ],
};

const SCOTT_TABLES: Tables = {
  EMP: [
    { name: "EMPNO", type: "NUMBER(4)" },
    { name: "ENAME", type: "VARCHAR2(10)" },
    { name: "MGR", type: "NUMBER(4)" },
    { name: "SAL", type: "NUMBER(7,2)" },
  ],
  DEPT: [
    { name: "DEPTNO", type: "NUMBER(2)" },
    { name: "DNAME", type: "VARCHAR2(14)" },
  ],
};

/** Offline sample routine for signature help / named-argument completion. */
const HR_PKG_RAISE: OracleSignature = {
  name: "RAISE_SALARY",
  kind: "procedure",
  owner: "HR",
  package: "HR_PKG",
  parameters: [
    { name: "P_EMP_ID", type: "NUMBER", mode: "IN" },
    { name: "P_PCT", type: "NUMBER", mode: "IN", optional: true },
  ],
};

/**
 * Offline sample metadata (no gateway). Answers the caret context the way
 * the dictionary-backed provider does:
 *   FROM |        -> schema + tables       FROM hr.|   -> tables of HR
 *   e.|           -> columns of e's table  seq.|       -> NEXTVAL / CURRVAL
 *   SELECT |      -> columns of tables in scope       @| -> db links
 * plus `signatures` (HR_PKG.RAISE_SALARY) and `describe` (hover) for tables / columns.
 */
function offlineMetadata(owner: string, tables: Tables): MetadataProvider {
  const upper = (s: string) => s.replace(/"/g, "").toUpperCase();
  const tableName = (t: string) => upper(t.split("@")[0].split(".").pop() ?? t);
  const columnsOf = (t: string): OracleMetadataItem[] =>
    (tables[tableName(t)] ?? []).map((c) => ({ label: c.name, kind: "column", detail: `${c.type} · ${tableName(t)}`, owner }));
  const tableItems = (): OracleMetadataItem[] =>
    Object.keys(tables).map((t) => ({ label: t, kind: "table", detail: `table · ${owner}`, owner }));

  const provider: MetadataProvider = ({ qualifier = [], aliases = [], expectTable, expectColumn, expectDbLink }) => {
    if (qualifier.length) {
      const last = upper(qualifier[qualifier.length - 1]);
      if (last === `${owner}_SEQ`) {
        return [
          { label: "NEXTVAL", kind: "sequence", detail: "sequence" },
          { label: "CURRVAL", kind: "sequence", detail: "sequence" },
        ];
      }
      if (expectTable && !expectColumn) return last === owner ? tableItems() : [];
      const alias = aliases.find((a) => upper(a.alias) === last);
      if (alias) return columnsOf(alias.table);
      if (tables[last]) return columnsOf(last); // table name used as qualifier (COMMENT ON COLUMN t.|)
      return last === owner ? tableItems() : [];
    }
    if (expectDbLink) return [{ label: "PROD", kind: "dblink", detail: "database link" }];
    const out: OracleMetadataItem[] = [];
    if (expectTable) {
      out.push({ label: owner, kind: "schema", detail: "schema" }, ...tableItems());
      out.push({ label: `${owner}_SEQ`, kind: "sequence", detail: `sequence · ${owner}` });
    }
    if (expectColumn) for (const a of aliases) if (!a.columns) out.push(...columnsOf(a.table));
    return out;
  };

  provider.signatures = ({ parts }) =>
    parts.map(upper).join(".").endsWith("HR_PKG.RAISE_SALARY") && owner === "HR" ? [HR_PKG_RAISE] : [];

  provider.describe = ({ parts, aliases = [] }) => {
    let p = parts.map(upper);
    if (p.length === 1 && p[0] === owner) return { kind: "schema", name: owner };
    if (p[0] === owner) p = p.slice(1); // hr.employees[.column]
    const alias = aliases.find((a) => a.kind === "table" && upper(a.alias) === p[0]);
    const table = alias ? tableName(alias.table) : p[0];
    const rest = p.slice(1);
    const cols = tables[table];
    if (!cols) return undefined;
    if (!rest.length) {
      return {
        kind: "table", name: table, owner, comment: strings.sampleTable,
        ...(alias && upper(alias.alias) !== table ? { alias: alias.alias } : {}),
        columns: cols.map((c) => ({ name: c.name, type: c.type, nullable: !c.name.endsWith("_ID") })),
      };
    }
    const col = cols.find((c) => c.name === rest[0]);
    return col && { kind: "column", name: col.name, dataType: col.type, nullable: !col.name.endsWith("_ID"), parent: `${owner}.${table}` };
  };
  return provider;
}

type Output =
  | { kind: "help"; key: "help" | "notConnected" | "commitDone" | "rollbackDone" }
  | { kind: "result"; result: StatementResult }
  | { kind: "script"; results: StatementResult[]; running: boolean }
  | { kind: "plan"; lines: string[] }
  | { kind: "error"; error: OracleQueryError | Error };

/** Markers for a result: runtime errors and PL/SQL compilation errors. */
function markersOf(results: StatementResult[], error?: unknown): ExecutionMarker[] {
  const out: ExecutionMarker[] = [];
  for (const r of results) {
    if (r.error) out.push(r.error);
    for (const c of r.compileErrors ?? []) out.push(c);
  }
  if (error instanceof OracleQueryError) out.push(error);
  return out;
}

const TABS = [
  { id: "hr", title: "HR", sample: SAMPLE_HR, metadata: offlineMetadata("HR", HR_TABLES) },
  { id: "scott", title: "SCOTT", sample: SAMPLE_SCOTT, metadata: offlineMetadata("SCOTT", SCOTT_TABLES) },
];

export default function App() {
  const [locale, setLocaleState] = useState<OracleLocale>(initialLocale);
  const s = APP_STRINGS[locale];
  strings = s;
  const setLocale = (l: OracleLocale) => {
    setLocaleState(l);
    saveLocale(l);
  };
  useEffect(() => {
    document.documentElement.lang = locale === "zh" ? "zh-CN" : locale;
  }, [locale]);
  const [fontId, setFontId] = useState(() => initialFont(DEFAULT_ORACLE_EDITOR_FONT.id));
  const font = ORACLE_EDITOR_FONTS.find((f) => f.id === fontId) ?? DEFAULT_ORACLE_EDITOR_FONT;
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const [version, setVersion] = useState<OracleVersion>("19c");
  const [tab, setTab] = useState(TABS[0].id);
  const [values, setValues] = useState<Record<string, string>>(
    Object.fromEntries(TABS.map((t) => [t.id, t.sample])),
  );
  const [blankLine, setBlankLine] = useState(false);
  const [validate, setValidate] = useState<"sql" | "all" | false>("sql");

  // ---- connection (oracle-monaco gateway behind the Vite /api proxy)
  const transport = useMemo(() => createGatewayTransport({ baseUrl: "/api" }), []);
  const [aliases, setAliases] = useState<ConnectAlias[] | null>(null);
  const [form, setForm] = useState({ connectAlias: "", user: "", password: "" });
  const [session, setSession] = useState<LoginResponse | null>(null);
  const [connError, setConnError] = useState("");
  const [serverOutput, setServerOutput] = useState(true);
  const [serverCheck, setServerCheck] = useState(true);
  const busyRef = useRef(false);

  useEffect(() => {
    transport
      .aliases()
      .then((a) => {
        setAliases(a);
        setForm((f) => ({ ...f, connectAlias: f.connectAlias || a[0]?.alias || "" }));
      })
      .catch(() => setAliases(null)); // no gateway: offline demo
  }, [transport]);

  const live = useMemo(() => {
    if (!session) return null;
    const metadata = createOracleMetadataProvider({ transport });
    const runner = createOracleQueryRunner({
      transport,
      metadata,
      onBindPrompt: (names) =>
        Object.fromEntries(names.map((n) => [n, window.prompt(strings.bindPrompt(n)) ?? null])),
      onSubstitutionPrompt: (name) => window.prompt(strings.substitutionPrompt(name)) ?? "",
    });
    // EXPLAIN PLAN validation on the same session: pause while a statement runs.
    const validator = createServerValidator({ transport, substitutionVariables: runner.variables, paused: () => busyRef.current });
    return { metadata, runner, validator };
  }, [session, transport]);

  useEffect(() => {
    if (live) live.runner.serverOutput = serverOutput;
  }, [live, serverOutput]);

  const connect = async () => {
    setConnError("");
    try {
      setSession(await transport.login(form));
      setForm((f) => ({ ...f, password: "" }));
    } catch (e) {
      setConnError((e as Error).message);
    }
  };
  const disconnect = async () => {
    await transport.logout().catch(() => {});
    setSession(null);
  };

  // ---- running
  const [output, setOutput] = useState<Output>({ kind: "help", key: "help" });
  const [markers, setMarkers] = useState<Record<string, ExecutionMarker[]>>({});
  const [busy, setBusyState] = useState(false);
  const setBusy = (b: boolean) => {
    busyRef.current = b;
    setBusyState(b);
  };
  const abortRef = useRef<AbortController | null>(null);

  async function guarded(tabId: string, work: (runner: NonNullable<typeof live>["runner"], signal: AbortSignal) => Promise<void>) {
    if (!live) {
      setOutput({ kind: "help", key: "notConnected" });
      return;
    }
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setBusy(true);
    setMarkers((m) => ({ ...m, [tabId]: [] }));
    try {
      await work(live.runner, ctrl.signal);
    } catch (e) {
      setOutput({ kind: "error", error: e as Error });
      setMarkers((m) => ({ ...m, [tabId]: markersOf([], e) }));
    } finally {
      setBusy(false);
    }
  }

  const runStatement = (tabId: string, stmt: SqlStatement) =>
    guarded(tabId, async (runner, signal) => {
      const result = await runner.run(stmt, { signal });
      setOutput({ kind: "result", result });
      setMarkers((m) => ({ ...m, [tabId]: markersOf([result]) }));
    });

  const runScript = (tabId: string, stmts: SqlStatement[]) =>
    guarded(tabId, async (runner, signal) => {
      const results: StatementResult[] = [];
      setOutput({ kind: "script", results, running: true });
      for await (const r of runner.runScript(stmts, { signal })) {
        results.push(r);
        setOutput({ kind: "script", results: [...results], running: true });
      }
      setOutput({ kind: "script", results, running: false });
      setMarkers((m) => ({ ...m, [tabId]: markersOf(results) }));
    });

  const explain = (tabId: string, stmt: SqlStatement) =>
    guarded(tabId, async (runner, signal) => setOutput({ kind: "plan", lines: (await runner.explain(stmt, { signal })).lines }));

  const describeObject = (tabId: string, name: string) =>
    guarded(tabId, async (runner, signal) => setOutput({ kind: "result", result: await runner.describe(name, signal) }));

  const fetchMore = async (result: StatementResult) => {
    if (!live) return;
    await live.runner.fetchMore(result);
    setOutput({ kind: "result", result: { ...result } });
  };

  const bg = theme === "dark" ? "#0b1021" : "#ffffff";
  const fg = theme === "dark" ? "#d4d4d4" : "#1f2933";
  const border = "1px solid #33415555";

  return (
    <div style={{ height: "100vh", display: "flex", flexDirection: "column", fontFamily: UI_FONT, fontSize: 13, background: bg, color: fg }}>
      <header style={{ padding: "8px 16px", display: "flex", gap: 12, alignItems: "center", borderBottom: border, flexWrap: "wrap" }}>
        <strong>Oracle Monaco Editor</strong>
        <label>
          {s.language}{" "}
          <select value={locale} onChange={(e) => setLocale(e.target.value as OracleLocale)} style={inp}>
            {ORACLE_LOCALES.map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}
          </select>
        </label>
        <label>
          {s.font}{" "}
          <select value={font.id} onChange={(e) => { setFontId(e.target.value); saveFont(e.target.value); }} style={inp}>
            {ORACLE_EDITOR_FONTS.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
          </select>
        </label>
        <label><input type="checkbox" checked={theme === "dark"} onChange={(e) => setTheme(e.target.checked ? "dark" : "light")} /> {s.dark}</label>
        <label>
          {s.version}{" "}
          <select value={version} onChange={(e) => setVersion(e.target.value as OracleVersion)} style={inp}>
            <option value="19c">19c</option>
            <option value="21c">21c</option>
            <option value="23ai">23ai</option>
          </select>
        </label>
        <label><input type="checkbox" checked={blankLine} onChange={(e) => setBlankLine(e.target.checked)} /> {s.blankLine}</label>
        <label>
          {s.validate}{" "}
          <select value={String(validate)} onChange={(e) => setValidate(e.target.value === "false" ? false : (e.target.value as "sql" | "all"))} style={inp}>
            <option value="sql">SQL</option>
            <option value="all">SQL + PL/SQL</option>
            <option value="false">{s.validateOff}</option>
          </select>
        </label>
        <span style={{ marginLeft: "auto" }} />
        {session ? (
          <>
            <span>{session.user}@{session.connectAlias} · Oracle {session.version}</span>
            <label><input type="checkbox" checked={serverOutput} onChange={(e) => setServerOutput(e.target.checked)} /> DBMS_OUTPUT</label>
            <label title={s.serverCheckTitle}><input type="checkbox" checked={serverCheck} onChange={(e) => setServerCheck(e.target.checked)} /> {s.serverCheck}</label>
            <button style={btn} onClick={() => transport.commit().then(() => setOutput({ kind: "help", key: "commitDone" }))}>{s.commit}</button>
            <button style={btn} onClick={() => transport.rollback().then(() => setOutput({ kind: "help", key: "rollbackDone" }))}>{s.rollback}</button>
            <button style={btn} onClick={disconnect}>{s.disconnect}</button>
          </>
        ) : aliases ? (
          <form style={{ display: "flex", gap: 6, alignItems: "center" }} onSubmit={(e) => { e.preventDefault(); void connect(); }}>
            <select value={form.connectAlias} onChange={(e) => setForm({ ...form, connectAlias: e.target.value })} style={inp} aria-label={s.database}>
              {aliases.map((a) => <option key={a.alias} value={a.alias}>{a.label ?? a.alias}</option>)}
            </select>
            <input placeholder={s.user} value={form.user} onChange={(e) => setForm({ ...form, user: e.target.value })} style={{ ...inp, width: 90 }} />
            <input placeholder={s.password} type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} style={{ ...inp, width: 110 }} />
            <button style={btn} type="submit">{s.connect}</button>
            {connError && <span style={{ color: "#d33" }}>{connError}</span>}
          </form>
        ) : (
          <span style={{ opacity: 0.6 }}>{s.offline}</span>
        )}
      </header>

      <nav style={{ display: "flex", gap: 2, padding: "4px 16px 0", borderBottom: border }}>
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            style={{ ...tabBtn, fontWeight: tab === t.id ? 600 : 400, borderBottom: tab === t.id ? "2px solid #2f6fdd" : "2px solid transparent" }}
          >
            {t.title}
          </button>
        ))}
      </nav>

      {/* Every tab stays mounted so each keeps its own model and completion provider. */}
      {TABS.map((t) => (
        <div key={t.id} style={{ flex: 1, minHeight: 0, display: tab === t.id ? "block" : "none" }}>
          <OracleEditor
            value={values[t.id]}
            onChange={(v) => setValues((prev) => ({ ...prev, [t.id]: v }))}
            theme={theme}
            targetVersion={version}
            locale={locale}
            fontFamily={font.fontFamily}
            fontLigatures={font.ligatures}
            metadataProvider={live?.metadata ?? t.metadata}
            statementSeparator={{ blankLine }}
            contextAware
            validateOnType={validate}
            executionErrors={markers[t.id]}
            serverValidator={serverCheck ? live?.validator : undefined}
            onRunStatement={(s) => void runStatement(t.id, s)}
            onRunScript={(ss) => void runScript(t.id, ss)}
            onExplainPlan={(s) => void explain(t.id, s)}
            onDescribe={(name) => void describeObject(t.id, name)}
          />
        </div>
      ))}

      <footer style={{ borderTop: border, padding: "8px 16px", height: "36%", overflow: "auto" }}>
        {busy && (
          <div style={{ marginBottom: 6 }}>
            {s.running} <button style={btn} onClick={() => abortRef.current?.abort()}>{s.cancel}</button>
          </div>
        )}
        <OutputView output={output} onFetchMore={fetchMore} s={s} />
      </footer>
    </div>
  );
}

function OutputView({ output, onFetchMore, s }: { output: Output; onFetchMore: (r: StatementResult) => void; s: AppStrings }) {
  switch (output.kind) {
    case "help":
      return <div style={{ opacity: 0.75 }}>{s[output.key]}</div>;
    case "error": {
      const e = output.error;
      const where = e instanceof OracleQueryError && e.line ? s.at(e.line, e.column ?? 1) : "";
      return <pre style={{ ...pre, color: "#d33" }}>{e.message}{where}</pre>;
    }
    case "plan":
      return <pre style={pre}>{output.lines.join("\n")}</pre>;
    case "result":
      return <ResultView result={output.result} onFetchMore={onFetchMore} s={s} />;
    case "script":
      return (
        <div>
          {output.results.map((r, i) => (
            <div key={i} style={{ marginBottom: 8 }}>
              <div style={{ opacity: 0.6 }}>{s.lineN(r.statement.startLine)}</div>
              <ResultView result={r} onFetchMore={onFetchMore} s={s} />
            </div>
          ))}
          {output.running && <div style={{ opacity: 0.6 }}>…</div>}
        </div>
      );
  }
}

function ResultView({ result, onFetchMore, s }: { result: StatementResult; onFetchMore: (r: StatementResult) => void; s: AppStrings }) {
  return (
    <div>
      {result.columns && (
        <table style={{ borderCollapse: "collapse", width: "100%" }}>
          <thead>
            <tr>{result.columns.map((c) => <th key={c.name} style={th}>{c.name}<span style={{ opacity: 0.45 }}> {c.type}</span></th>)}</tr>
          </thead>
          <tbody>
            {(result.rows ?? []).map((row, i) => (
              <tr key={i}>{row.map((cell, j) => <td key={j} style={td}>{cell === null ? <i style={{ opacity: 0.4 }}>(null)</i> : String(cell)}</td>)}</tr>
            ))}
          </tbody>
        </table>
      )}
      {result.hasMore && <button style={{ ...btn, marginTop: 4 }} onClick={() => onFetchMore(result)}>{s.fetchMore}</button>}
      {result.message && <div style={{ color: result.error ? "#d33" : undefined }}>{result.message}{result.elapsedMs !== undefined && !result.error ? ` (${result.elapsedMs} ms)` : ""}</div>}
      {result.compileErrors?.map((c, i) => (
        <div key={i} style={{ color: c.severity === "error" ? "#d33" : "#b26b00" }}>{c.line}:{c.column} {c.message}</div>
      ))}
      {result.dbmsOutput && result.dbmsOutput.length > 0 && <pre style={{ ...pre, opacity: 0.85 }}>{result.dbmsOutput.join("\n")}</pre>}
    </div>
  );
}

/**
 * Demo UI font: Roboto Condensed for Latin text, then fonts with Hangul / kana /
 * Hanzi (Roboto has none) so mixed-language labels look the same on every OS.
 * Everything in the page chrome is 13px; form controls inherit it (`font: inherit`).
 */
const UI_FONT =
  "'Roboto Condensed', 'Noto Sans KR', 'Malgun Gothic', 'Apple SD Gothic Neo', 'Noto Sans JP', 'Hiragino Sans', 'Yu Gothic', 'Noto Sans SC', 'PingFang SC', 'Microsoft YaHei', system-ui, sans-serif";

const inp: React.CSSProperties = { background: "transparent", color: "inherit", border: "1px solid #33415588", borderRadius: 4, padding: "2px 4px", font: "inherit" };
const btn: React.CSSProperties = { background: "#233979", color: "#fff", border: "none", borderRadius: 4, padding: "3px 10px", font: "inherit", cursor: "pointer" };
const tabBtn: React.CSSProperties = { background: "transparent", color: "inherit", border: "none", padding: "6px 14px", font: "inherit", cursor: "pointer" };
const pre: React.CSSProperties = { margin: 0, fontSize: 12, whiteSpace: "pre-wrap", fontFamily: "'JetBrains Mono', Menlo, Consolas, monospace" };
const th: React.CSSProperties = { textAlign: "left", borderBottom: "1px solid #33415588", padding: "3px 8px", position: "sticky", top: 0, background: "#8881", whiteSpace: "nowrap" };
const td: React.CSSProperties = { borderBottom: "1px solid #33415522", padding: "3px 8px", whiteSpace: "nowrap" };
