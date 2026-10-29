/**
 * Built-in help for Oracle functions, keywords, pseudo-columns, data types
 * and supplied packages (Shift+F1 / Ctrl+Click / hover).
 *
 * The summaries and examples are written for this editor (not copied from
 * the Oracle manuals); each entry links to the matching page of the official
 * documentation for the editor's `targetVersion`. Every `page` below was
 * checked to exist for 19c, 21c and 23ai (`scripts/check-doc-links.ts`).
 *
 * Function syntax comes from the signature table (`signatures.ts`) unless an
 * entry has its own `syntax` (CAST, EXTRACT, JSON_TABLE … are not plain calls).
 */
import { BUILTIN_SIGNATURES, signatureLabel } from "./signatures";
import type { OracleVersion } from "./keywords";
import { localizeDoc, uiStrings, type OracleLocale } from "./i18n";

export type DocKind =
  | "function"
  | "statement"
  | "clause"
  | "condition"
  | "operator"
  | "pseudo-column"
  | "type"
  | "package"
  | "plsql";

/** One help topic. */
export interface OracleDocEntry {
  /** Stable id for translations: `fn:NVL`, `topic:CONNECT_BY`, `pseudo:ROWNUM`, `type:VARCHAR2`, `pkg:DBMS_LOB`. */
  id?: string;
  /** Heading, e.g. `NVL`, `CONNECT BY`, `CREATE TABLE`. */
  title: string;
  kind: DocKind;
  /** One or two sentences (markdown). */
  summary: string;
  /** Syntax outline. */
  syntax?: string;
  /** A short runnable example. */
  example?: string;
  /** First version that has it (when newer than 19c). */
  since?: "21c" | "23ai";
  /** Manual page: `sqlrf/NVL`, `lnpls/IF-statement`, `arpls/DBMS_OUTPUT`. */
  page?: string;
}

/** Partial entries merged by `docFor()`; functions fill in from the signature table. */
type Doc = Partial<OracleDocEntry> & { summary?: string };

const DOC_BASE = "https://docs.oracle.com/en/database/oracle/oracle-database";
// 23ai docs moved to the 26ai release path; /23/ only redirects there (and loops for some pages).
const DOC_RELEASE: Record<OracleVersion, string> = { "19c": "19", "21c": "21", "23ai": "26" };

/** Link to a manual page for `version` (default 19c). */
export function docUrl(page: string, version: OracleVersion = "19c"): string {
  return `${DOC_BASE}/${DOC_RELEASE[version]}/${page}.html`;
}

// ---------------------------------------------------------------- functions

/** Per-function additions to the signature table: examples, manual pages, special syntax. */
const FUNCTIONS: Record<string, Doc> = {
  NVL: { example: "SELECT last_name, NVL(commission_pct, 0) FROM employees;" },
  NVL2: { example: "SELECT NVL2(commission_pct, 'commission', 'salary only') FROM employees;" },
  NULLIF: { example: "SELECT NULLIF(new_salary, old_salary) FROM raises;" },
  COALESCE: { example: "SELECT COALESCE(mobile, office_phone, 'n/a') FROM contacts;" },
  DECODE: { example: "SELECT DECODE(status, 'A', 'Active', 'I', 'Inactive', 'Unknown') FROM accounts;" },
  GREATEST: { example: "SELECT GREATEST(start_date, DATE '2024-01-01') FROM projects;" },
  LEAST: { example: "SELECT LEAST(price, discount_price) FROM products;" },
  LNNVL: { example: "SELECT * FROM employees WHERE LNNVL(commission_pct > 0.2);" },
  SUBSTR: { example: "SELECT SUBSTR('ORACLE', 2, 3) FROM dual;  -- RAC" },
  SUBSTRB: { page: "sqlrf/SUBSTR" },
  INSTR: { example: "SELECT INSTR('a,b,c', ',', 1, 2) FROM dual;  -- 4" },
  INSTRB: { page: "sqlrf/INSTR" },
  LENGTH: { example: "SELECT LENGTH('Oracle') FROM dual;  -- 6" },
  LENGTHB: { page: "sqlrf/LENGTH" },
  UPPER: { example: "SELECT UPPER(last_name) FROM employees;" },
  LOWER: { example: "SELECT LOWER(email) FROM employees;" },
  INITCAP: { example: "SELECT INITCAP('hello world') FROM dual;  -- Hello World" },
  LPAD: { example: "SELECT LPAD(employee_id, 6, '0') FROM employees;" },
  RPAD: { example: "SELECT RPAD(name, 20, '.') FROM products;" },
  LTRIM: { example: "SELECT LTRIM('000123', '0') FROM dual;  -- 123" },
  RTRIM: { example: "SELECT RTRIM('abc   ') FROM dual;" },
  TRIM: {
    summary: "Removes leading and/or trailing characters (blank by default).",
    syntax: "TRIM([[LEADING | TRAILING | BOTH] [trim_char] FROM] source)",
    example: "SELECT TRIM(LEADING '0' FROM '00042') FROM dual;  -- 42",
  },
  REPLACE: { example: "SELECT REPLACE(phone, '-', '') FROM contacts;" },
  TRANSLATE: { example: "SELECT TRANSLATE('2024/01/31', '/', '-') FROM dual;" },
  CONCAT: { example: "SELECT CONCAT(first_name, last_name) FROM employees;" },
  REGEXP_LIKE: { page: "sqlrf/Pattern-matching-Conditions", example: "SELECT * FROM employees WHERE REGEXP_LIKE(email, '^[a-z]+$', 'i');" },
  REGEXP_SUBSTR: { example: "SELECT REGEXP_SUBSTR('a,b,c', '[^,]+', 1, 2) FROM dual;  -- b" },
  REGEXP_REPLACE: { example: "SELECT REGEXP_REPLACE(phone, '[^0-9]', '') FROM contacts;" },
  REGEXP_INSTR: { example: "SELECT REGEXP_INSTR('abc123', '[0-9]') FROM dual;  -- 4" },
  REGEXP_COUNT: { example: "SELECT REGEXP_COUNT('a,b,c', ',') FROM dual;  -- 2" },
  ROUND: {
    page: "sqlrf/ROUND-number",
    summary: "Rounds a number to `integer` decimal places, or a date to a format unit (`'MM'`, `'YYYY'`; see also ROUND (date)).",
    example: "SELECT ROUND(123.456, 1), ROUND(SYSDATE, 'MM') FROM dual;",
  },
  TRUNC: {
    page: "sqlrf/TRUNC-number",
    summary: "Truncates a number to `integer` decimal places, or a date to a format unit (`TRUNC(SYSDATE)` = midnight today).",
    example: "SELECT TRUNC(123.456, 1), TRUNC(SYSDATE, 'MM') FROM dual;",
  },
  MOD: { example: "SELECT MOD(17, 5) FROM dual;  -- 2" },
  ABS: { example: "SELECT ABS(-5) FROM dual;" },
  CEIL: { example: "SELECT CEIL(4.1) FROM dual;  -- 5" },
  FLOOR: { example: "SELECT FLOOR(4.9) FROM dual;  -- 4" },
  POWER: { example: "SELECT POWER(2, 10) FROM dual;  -- 1024" },
  ADD_MONTHS: { example: "SELECT ADD_MONTHS(hire_date, 6) FROM employees;" },
  MONTHS_BETWEEN: { example: "SELECT MONTHS_BETWEEN(SYSDATE, hire_date) FROM employees;" },
  LAST_DAY: { example: "SELECT LAST_DAY(SYSDATE) FROM dual;" },
  NEXT_DAY: { example: "SELECT NEXT_DAY(SYSDATE, 'MONDAY') FROM dual;" },
  EXTRACT: {
    page: "sqlrf/EXTRACT-datetime",
    summary: "A field (YEAR, MONTH, DAY, HOUR, MINUTE, SECOND, TIMEZONE_*) of a datetime or interval.",
    syntax: "EXTRACT({YEAR | MONTH | DAY | HOUR | MINUTE | SECOND | TIMEZONE_HOUR | TIMEZONE_MINUTE | TIMEZONE_REGION | TIMEZONE_ABBR} FROM expr)",
    example: "SELECT EXTRACT(YEAR FROM hire_date) FROM employees;",
  },
  CAST: {
    summary: "Converts a value (or a collection subquery) to another data type.",
    syntax: "CAST({expr | MULTISET (subquery)} AS type_name [DEFAULT return_value ON CONVERSION ERROR] [, fmt [, nlsparam]])",
    example: "SELECT CAST('123' AS NUMBER), CAST(hire_date AS TIMESTAMP) FROM employees;",
  },
  TO_CHAR: {
    page: "sqlrf/TO_CHAR-datetime",
    summary: "Converts a date / timestamp / interval, a number, or character data to text using a format model (see also TO_CHAR (number)).",
    example: "SELECT TO_CHAR(SYSDATE, 'YYYY-MM-DD HH24:MI'), TO_CHAR(1234.5, 'FM9,990.00') FROM dual;",
  },
  TO_DATE: { example: "SELECT TO_DATE('2024-01-31', 'YYYY-MM-DD') FROM dual;" },
  TO_NUMBER: { example: "SELECT TO_NUMBER('1,234.50', '9G999D99') FROM dual;" },
  TO_TIMESTAMP: { example: "SELECT TO_TIMESTAMP('2024-01-31 10:00:00.5', 'YYYY-MM-DD HH24:MI:SS.FF') FROM dual;" },
  TO_TIMESTAMP_TZ: { example: "SELECT TO_TIMESTAMP_TZ('2024-01-31 10:00 +09:00', 'YYYY-MM-DD HH24:MI TZH:TZM') FROM dual;" },
  TO_CLOB: { page: "sqlrf/TO_CLOB-character" },
  TO_NCHAR: { page: "sqlrf/TO_NCHAR-character" },
  TO_BLOB: { page: "sqlrf/TO_BLOB-raw" },
  EMPTY_BLOB: { page: "sqlrf/EMPTY_BLOB-EMPTY_CLOB", example: "INSERT INTO docs (id, body) VALUES (1, EMPTY_BLOB());" },
  EMPTY_CLOB: { page: "sqlrf/EMPTY_BLOB-EMPTY_CLOB", example: "INSERT INTO notes (id, text) VALUES (1, EMPTY_CLOB());" },
  VALIDATE_CONVERSION: { example: "SELECT * FROM staging WHERE VALIDATE_CONVERSION(amount AS NUMBER) = 0;" },
  SYS_CONTEXT: { example: "SELECT SYS_CONTEXT('USERENV', 'CURRENT_SCHEMA') FROM dual;" },
  SYS_GUID: { example: "SELECT RAWTOHEX(SYS_GUID()) FROM dual;" },
  ORA_HASH: { example: "SELECT ORA_HASH(customer_id, 7) AS bucket FROM orders;" },
  SYS_CONNECT_BY_PATH: { example: "SELECT SYS_CONNECT_BY_PATH(last_name, '/') FROM employees START WITH manager_id IS NULL CONNECT BY PRIOR employee_id = manager_id;" },
  CONNECT_BY_ROOT: {
    kind: "operator",
    page: "sqlrf/Hierarchical-Queries",
    summary: "Unary operator of hierarchical queries: the value of a column in the root row of the current row's hierarchy.",
    syntax: "CONNECT_BY_ROOT column",
    example: "SELECT last_name, CONNECT_BY_ROOT last_name AS top_manager FROM employees CONNECT BY PRIOR employee_id = manager_id;",
  },
  COUNT: { example: "SELECT department_id, COUNT(*) FROM employees GROUP BY department_id;" },
  SUM: { example: "SELECT SUM(salary) FROM employees;" },
  AVG: { example: "SELECT AVG(salary) FROM employees;" },
  MIN: { example: "SELECT MIN(hire_date) FROM employees;" },
  MAX: { example: "SELECT MAX(salary) KEEP (DENSE_RANK LAST ORDER BY hire_date) FROM employees;" },
  LISTAGG: {
    syntax: "LISTAGG([ALL | DISTINCT] measure_expr [, delimiter] [ON OVERFLOW {ERROR | TRUNCATE ['…'] [WITH | WITHOUT COUNT]}]) WITHIN GROUP (ORDER BY …) [OVER (PARTITION BY …)]",
    example: "SELECT department_id, LISTAGG(last_name, ', ') WITHIN GROUP (ORDER BY last_name) FROM employees GROUP BY department_id;",
  },
  ROW_NUMBER: { example: "SELECT * FROM (SELECT e.*, ROW_NUMBER() OVER (PARTITION BY department_id ORDER BY salary DESC) rn FROM employees e) WHERE rn = 1;" },
  RANK: { page: "sqlrf/RANK", example: "SELECT last_name, RANK() OVER (ORDER BY salary DESC) FROM employees;" },
  DENSE_RANK: { example: "SELECT last_name, DENSE_RANK() OVER (ORDER BY salary DESC) FROM employees;" },
  LAG: { example: "SELECT hire_date, LAG(hire_date) OVER (ORDER BY hire_date) AS prev FROM employees;" },
  LEAD: { example: "SELECT hire_date, LEAD(hire_date, 1, SYSDATE) OVER (ORDER BY hire_date) FROM employees;" },
  FIRST_VALUE: { example: "SELECT last_name, FIRST_VALUE(last_name) OVER (PARTITION BY department_id ORDER BY salary DESC) FROM employees;" },
  NTILE: { example: "SELECT last_name, NTILE(4) OVER (ORDER BY salary) AS quartile FROM employees;" },
  PERCENTILE_CONT: { example: "SELECT PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY salary) FROM employees;" },
  CURRENT_DATE: { kind: "function", summary: "Current date and time in the session time zone (DATE).", syntax: "CURRENT_DATE", example: "SELECT CURRENT_DATE FROM dual;" },
  CURRENT_TIMESTAMP: { kind: "function", summary: "Current timestamp with time zone, in the session time zone.", syntax: "CURRENT_TIMESTAMP [(precision)]", example: "SELECT CURRENT_TIMESTAMP(3) FROM dual;" },
  LOCALTIMESTAMP: { kind: "function", summary: "Current timestamp (without time zone) in the session time zone.", syntax: "LOCALTIMESTAMP [(precision)]" },
  DBTIMEZONE: { kind: "function", summary: "The database time zone.", syntax: "DBTIMEZONE" },
  SESSIONTIMEZONE: { kind: "function", summary: "The session time zone.", syntax: "SESSIONTIMEZONE" },
  JSON_VALUE: {
    syntax: "JSON_VALUE(expr, path [RETURNING type] [{ERROR | NULL | DEFAULT v} ON ERROR] [{ERROR | NULL | DEFAULT v} ON EMPTY])",
    example: "SELECT JSON_VALUE(doc, '$.customer.name') FROM orders;",
  },
  JSON_QUERY: {
    syntax: "JSON_QUERY(expr, path [RETURNING type] [WITH [CONDITIONAL] WRAPPER] [… ON ERROR] [… ON EMPTY])",
    example: "SELECT JSON_QUERY(doc, '$.items') FROM orders;",
  },
  JSON_EXISTS: { page: "sqlrf/SQL-JSON-Conditions", syntax: "JSON_EXISTS(expr, path [PASSING …] [… ON ERROR])", example: "SELECT * FROM orders WHERE JSON_EXISTS(doc, '$.coupon');" },
  JSON_TABLE: {
    summary: "Projects JSON data as relational rows and columns (in FROM).",
    syntax: "JSON_TABLE(expr, path COLUMNS (name type PATH path, …, NESTED PATH path COLUMNS (…)))",
    example: "SELECT jt.* FROM orders o, JSON_TABLE(o.doc, '$.items[*]' COLUMNS (sku VARCHAR2(20) PATH '$.sku', qty NUMBER PATH '$.qty')) jt;",
  },
  JSON_OBJECT: { summary: "Builds a JSON object from key / value pairs.", syntax: "JSON_OBJECT(KEY 'k' VALUE expr, … [ABSENT | NULL ON NULL] [RETURNING type])", example: "SELECT JSON_OBJECT('id' VALUE employee_id, 'name' VALUE last_name) FROM employees;" },
  JSON_ARRAY: { summary: "Builds a JSON array from its arguments.", syntax: "JSON_ARRAY(expr, … [ABSENT | NULL ON NULL] [RETURNING type])", example: "SELECT JSON_ARRAY(1, 'two', SYSDATE) FROM dual;" },
  JSON_OBJECTAGG: { summary: "Aggregates key / value pairs of a group into one JSON object.", syntax: "JSON_OBJECTAGG(KEY k VALUE v [ABSENT | NULL ON NULL])" },
  JSON_ARRAYAGG: { summary: "Aggregates values of a group into a JSON array.", syntax: "JSON_ARRAYAGG(expr [ORDER BY …] [ABSENT | NULL ON NULL] [RETURNING type])", example: "SELECT JSON_ARRAYAGG(last_name ORDER BY last_name) FROM employees;" },
  JSON_SERIALIZE: { summary: "JSON data (binary or text) as text.", syntax: "JSON_SERIALIZE(expr [RETURNING type] [PRETTY] [ASCII] [TRUNCATE])" },
  XMLTABLE: { summary: "Projects XML data as relational rows and columns (in FROM).", syntax: "XMLTABLE(xquery PASSING xml COLUMNS name type PATH 'xpath', …)" },
  XMLELEMENT: { summary: "Builds an XML element.", syntax: "XMLELEMENT(NAME \"tag\", [XMLATTRIBUTES(…),] value_expr, …)", example: "SELECT XMLELEMENT(\"emp\", last_name) FROM employees;" },
  XMLQUERY: { summary: "Evaluates an XQuery expression.", syntax: "XMLQUERY(xquery PASSING expr RETURNING CONTENT)" },
  XMLCAST: { summary: "Casts an XML value to a SQL scalar type.", syntax: "XMLCAST(value_expr AS datatype)" },
  XMLSERIALIZE: { summary: "XML as text.", syntax: "XMLSERIALIZE({DOCUMENT | CONTENT} value_expr [AS type] [INDENT])" },
};

// ---------------------------------------------------------------- keywords

// (topic ids are assigned below the table)

/** Keyword / clause / statement topics. Keys are topic ids. */
const TOPICS: Record<string, OracleDocEntry> = {
  // queries
  SELECT: { title: "SELECT", kind: "statement", page: "sqlrf/SELECT", summary: "Retrieves rows from tables, views, subqueries and table functions.", syntax: "[WITH …] SELECT [hint] [DISTINCT] select_list FROM … [WHERE …] [CONNECT BY …] [GROUP BY …] [HAVING …] [ORDER BY …] [OFFSET n ROWS] [FETCH FIRST n ROWS ONLY]", example: "SELECT department_id, COUNT(*) FROM employees WHERE salary > 5000 GROUP BY department_id ORDER BY 2 DESC;" },
  WITH: { title: "WITH (subquery factoring)", kind: "clause", page: "sqlrf/SELECT", summary: "Names subqueries (common table expressions) that the main query can reference; recursive CTEs need a column list.", syntax: "WITH name [(c1, …)] AS (subquery) [, …] SELECT …", example: "WITH d AS (SELECT department_id, AVG(salary) avg_sal FROM employees GROUP BY department_id)\nSELECT * FROM d WHERE avg_sal > 8000;" },
  WHERE: { title: "WHERE", kind: "clause", page: "sqlrf/SELECT", summary: "Keeps only rows for which the condition is TRUE (not FALSE or UNKNOWN)." },
  GROUP_BY: { title: "GROUP BY", kind: "clause", page: "sqlrf/SELECT", summary: "Groups rows for aggregate functions; `ROLLUP`, `CUBE` and `GROUPING SETS` add subtotals. 23ai also accepts select-list aliases and positions.", syntax: "GROUP BY expr, … | ROLLUP (…) | CUBE (…) | GROUPING SETS (…)" },
  HAVING: { title: "HAVING", kind: "clause", page: "sqlrf/SELECT", summary: "Filters groups after GROUP BY (may use aggregates).", example: "SELECT department_id FROM employees GROUP BY department_id HAVING COUNT(*) > 10;" },
  ORDER_BY: { title: "ORDER BY", kind: "clause", page: "sqlrf/Sorting-Query-Results", summary: "Sorts the result; `NULLS FIRST | LAST`, `ORDER SIBLINGS BY` keeps hierarchy order.", syntax: "ORDER [SIBLINGS] BY expr [ASC | DESC] [NULLS FIRST | NULLS LAST], …" },
  FETCH_FIRST: { title: "OFFSET / FETCH (row limiting)", kind: "clause", page: "sqlrf/SELECT", summary: "Limits the rows returned, after ORDER BY.", syntax: "[OFFSET n {ROW | ROWS}] FETCH {FIRST | NEXT} [n | n PERCENT] {ROW | ROWS} {ONLY | WITH TIES}", example: "SELECT * FROM employees ORDER BY salary DESC FETCH FIRST 10 ROWS ONLY;" },
  FOR_UPDATE: { title: "FOR UPDATE", kind: "clause", page: "sqlrf/SELECT", summary: "Locks the selected rows until the transaction ends.", syntax: "FOR UPDATE [OF column, …] [NOWAIT | WAIT n | SKIP LOCKED]" },
  DISTINCT: { title: "DISTINCT / UNIQUE", kind: "clause", page: "sqlrf/SELECT", summary: "Removes duplicate rows from the result." },
  JOIN: { title: "JOIN", kind: "clause", page: "sqlrf/Joins", summary: "Combines rows of two row sources: `[INNER] JOIN`, `LEFT | RIGHT | FULL [OUTER] JOIN`, `CROSS JOIN`, `NATURAL JOIN`, `CROSS | OUTER APPLY`; the old `(+)` marks the outer side.", syntax: "t1 [INNER | {LEFT | RIGHT | FULL} [OUTER]] JOIN t2 {ON condition | USING (col, …)}", example: "SELECT e.last_name, d.department_name FROM employees e LEFT JOIN departments d ON d.department_id = e.department_id;" },
  SET_OPERATORS: { title: "UNION / INTERSECT / MINUS", kind: "operator", page: "sqlrf/The-UNION-ALL-INTERSECT-MINUS-Operators", summary: "Combines query results: `UNION` (distinct), `UNION ALL`, `INTERSECT`, `MINUS` (`EXCEPT` from 21c).", example: "SELECT employee_id FROM employees MINUS SELECT employee_id FROM job_history;" },
  CONNECT_BY: { title: "CONNECT BY (hierarchical query)", kind: "clause", page: "sqlrf/Hierarchical-Queries", summary: "Walks parent → child relationships: `START WITH` picks the roots, `PRIOR` marks the parent side, `LEVEL` is the depth, `NOCYCLE` tolerates loops.", syntax: "[START WITH condition] CONNECT BY [NOCYCLE] PRIOR parent_key = child_key", example: "SELECT LPAD(' ', 2 * (LEVEL - 1)) || last_name FROM employees\n START WITH manager_id IS NULL CONNECT BY PRIOR employee_id = manager_id;" },
  PIVOT: { title: "PIVOT / UNPIVOT", kind: "clause", page: "sqlrf/SELECT", summary: "PIVOT turns row values into columns (with an aggregate); UNPIVOT turns columns into rows.", syntax: "PIVOT (agg(expr) FOR col IN (v1 AS a1, …))", example: "SELECT * FROM (SELECT job_id, department_id, salary FROM employees)\n PIVOT (SUM(salary) FOR department_id IN (10 AS d10, 20 AS d20));" },
  OVER: { title: "OVER (analytic functions)", kind: "clause", page: "sqlrf/Analytic-Functions", summary: "Computes a function over a window of rows related to the current row without collapsing them.", syntax: "fn(…) OVER ([PARTITION BY …] [ORDER BY … [ROWS | RANGE BETWEEN … AND …]])" },
  CASE: { title: "CASE", kind: "operator", page: "sqlrf/CASE-Expressions", summary: "IF-THEN-ELSE logic in an expression (simple or searched form). In PL/SQL, CASE can also be a statement.", syntax: "CASE [expr] WHEN v_or_cond THEN r … [ELSE r] END", example: "SELECT CASE WHEN salary > 10000 THEN 'high' ELSE 'normal' END FROM employees;" },
  // conditions
  LIKE: { title: "LIKE", kind: "condition", page: "sqlrf/Pattern-matching-Conditions", summary: "Pattern match: `%` any string, `_` one character; `ESCAPE` makes them literal.", syntax: "char [NOT] LIKE pattern [ESCAPE esc]", example: "SELECT * FROM employees WHERE last_name LIKE 'K%';" },
  BETWEEN: { title: "BETWEEN", kind: "condition", page: "sqlrf/BETWEEN-Condition", summary: "Inclusive range test: `a BETWEEN x AND y` is `a >= x AND a <= y`." },
  IN: { title: "IN", kind: "condition", page: "sqlrf/IN-Condition", summary: "Membership in a list or subquery; `NOT IN` returns no rows if the list contains NULL.", syntax: "expr [NOT] IN (v1, v2, … | subquery)" },
  EXISTS: { title: "EXISTS", kind: "condition", page: "sqlrf/EXISTS-Condition", summary: "TRUE when the subquery returns at least one row.", example: "SELECT * FROM departments d WHERE EXISTS (SELECT 1 FROM employees e WHERE e.department_id = d.department_id);" },
  IS_NULL: { title: "IS [NOT] NULL", kind: "condition", page: "sqlrf/Null-Conditions", summary: "The only way to test for NULL (`= NULL` is never TRUE)." },
  NULL: { title: "NULL", kind: "operator", page: "sqlrf/Nulls", summary: "Absence of a value. Comparisons with NULL are UNKNOWN; an empty string `''` is NULL in Oracle." },
  LOGICAL: { title: "AND / OR / NOT", kind: "condition", page: "sqlrf/Logical-Conditions", summary: "Combine conditions with three-valued logic (TRUE, FALSE, UNKNOWN)." },
  // DML
  INSERT: { title: "INSERT", kind: "statement", page: "sqlrf/INSERT", summary: "Adds rows: a VALUES row, a subquery, or several tables with `INSERT ALL | FIRST`.", syntax: "INSERT INTO t [(c1, …)] {VALUES (…) | subquery} [RETURNING … INTO …]", example: "INSERT INTO departments (department_id, department_name) VALUES (300, 'Data');" },
  UPDATE: { title: "UPDATE", kind: "statement", page: "sqlrf/UPDATE", summary: "Changes column values of existing rows.", syntax: "UPDATE t [alias] SET c = expr, … [WHERE …] [RETURNING … INTO …]", example: "UPDATE employees SET salary = salary * 1.1 WHERE department_id = 50;" },
  DELETE: { title: "DELETE", kind: "statement", page: "sqlrf/DELETE", summary: "Removes rows (use TRUNCATE TABLE to empty a table fast, without undo).", syntax: "DELETE [FROM] t [WHERE …] [RETURNING … INTO …]" },
  MERGE: { title: "MERGE", kind: "statement", page: "sqlrf/MERGE", summary: "Upsert: updates matching rows and inserts the others, in one statement.", syntax: "MERGE INTO t USING s ON (cond)\n  WHEN MATCHED THEN UPDATE SET … [DELETE WHERE …]\n  WHEN NOT MATCHED THEN INSERT (…) VALUES (…)", example: "MERGE INTO stock t USING deliveries s ON (t.sku = s.sku)\n WHEN MATCHED THEN UPDATE SET t.qty = t.qty + s.qty\n WHEN NOT MATCHED THEN INSERT (sku, qty) VALUES (s.sku, s.qty);" },
  // transactions / session
  COMMIT: { title: "COMMIT", kind: "statement", page: "sqlrf/COMMIT", summary: "Makes the transaction's changes permanent and visible to other sessions." },
  ROLLBACK: { title: "ROLLBACK", kind: "statement", page: "sqlrf/ROLLBACK", summary: "Undoes the transaction's changes (or those after a savepoint).", syntax: "ROLLBACK [TO SAVEPOINT name]" },
  SAVEPOINT: { title: "SAVEPOINT", kind: "statement", page: "sqlrf/SAVEPOINT", summary: "Marks a point in the transaction to roll back to.", syntax: "SAVEPOINT name" },
  SET_TRANSACTION: { title: "SET TRANSACTION", kind: "statement", page: "sqlrf/SET-TRANSACTION", summary: "Sets the transaction as READ ONLY / READ WRITE or its isolation level." },
  LOCK_TABLE: { title: "LOCK TABLE", kind: "statement", page: "sqlrf/LOCK-TABLE", summary: "Locks a table in a given mode until the transaction ends.", syntax: "LOCK TABLE t IN {ROW SHARE | ROW EXCLUSIVE | SHARE | EXCLUSIVE …} MODE [NOWAIT | WAIT n]" },
  ALTER_SESSION: { title: "ALTER SESSION", kind: "statement", page: "sqlrf/ALTER-SESSION", summary: "Changes session settings (NLS formats, CURRENT_SCHEMA, optimizer parameters …).", example: "ALTER SESSION SET NLS_DATE_FORMAT = 'YYYY-MM-DD HH24:MI:SS';" },
  ALTER_SYSTEM: { title: "ALTER SYSTEM", kind: "statement", page: "sqlrf/ALTER-SYSTEM", summary: "Changes instance-wide settings (privileged)." },
  EXPLAIN_PLAN: { title: "EXPLAIN PLAN", kind: "statement", page: "sqlrf/EXPLAIN-PLAN", summary: "Stores the optimizer's plan in PLAN_TABLE without running the statement (F10 in this editor).", syntax: "EXPLAIN PLAN [SET STATEMENT_ID = 'id'] FOR statement" },
  CALL: { title: "CALL", kind: "statement", page: "sqlrf/CALL", summary: "Calls a stored procedure or function from SQL.", syntax: "CALL [schema.][pkg.]routine(args) [INTO :var]" },
  // DDL
  CREATE_TABLE: { title: "CREATE TABLE", kind: "statement", page: "sqlrf/CREATE-TABLE", summary: "Creates a relational table (also global temporary, partitioned, `AS SELECT`). `IF NOT EXISTS` from 23ai. DDL commits implicitly.", syntax: "CREATE [GLOBAL TEMPORARY] TABLE [IF NOT EXISTS] t (col type [DEFAULT …] [constraint], …) [AS subquery]", example: "CREATE TABLE projects (id NUMBER GENERATED ALWAYS AS IDENTITY PRIMARY KEY, name VARCHAR2(100) NOT NULL);" },
  ALTER_TABLE: { title: "ALTER TABLE", kind: "statement", page: "sqlrf/ALTER-TABLE", summary: "Adds, modifies, drops or renames columns and constraints, moves or partitions a table.", example: "ALTER TABLE projects ADD (owner_id NUMBER);" },
  DROP_TABLE: { title: "DROP TABLE", kind: "statement", page: "sqlrf/DROP-TABLE", summary: "Drops a table (to the recycle bin unless PURGE). `IF EXISTS` from 23ai.", syntax: "DROP TABLE [IF EXISTS] t [CASCADE CONSTRAINTS] [PURGE]" },
  TRUNCATE: { title: "TRUNCATE TABLE", kind: "statement", page: "sqlrf/TRUNCATE-TABLE", summary: "Removes all rows quickly; DDL — commits and cannot be rolled back." },
  CREATE_VIEW: { title: "CREATE VIEW", kind: "statement", page: "sqlrf/CREATE-VIEW", summary: "Creates a stored query.", syntax: "CREATE [OR REPLACE] [FORCE] VIEW v [(c, …)] AS subquery [WITH CHECK OPTION | WITH READ ONLY]" },
  ALTER_VIEW: { title: "ALTER VIEW", kind: "statement", page: "sqlrf/ALTER-VIEW", summary: "Recompiles a view or changes its constraints." },
  DROP_VIEW: { title: "DROP VIEW", kind: "statement", page: "sqlrf/DROP-VIEW", summary: "Drops a view." },
  CREATE_MVIEW: { title: "CREATE MATERIALIZED VIEW", kind: "statement", page: "sqlrf/CREATE-MATERIALIZED-VIEW", summary: "Creates a view whose result is stored and refreshed (ON COMMIT / ON DEMAND, FAST / COMPLETE)." },
  CREATE_INDEX: { title: "CREATE INDEX", kind: "statement", page: "sqlrf/CREATE-INDEX", summary: "Creates a B-tree, bitmap or function-based index.", syntax: "CREATE [UNIQUE | BITMAP] INDEX i ON t (col | expr [ASC | DESC], …)" },
  ALTER_INDEX: { title: "ALTER INDEX", kind: "statement", page: "sqlrf/ALTER-INDEX", summary: "Rebuilds, renames or changes an index (e.g. `REBUILD ONLINE`, `INVISIBLE`)." },
  DROP_INDEX: { title: "DROP INDEX", kind: "statement", page: "sqlrf/DROP-INDEX", summary: "Drops an index." },
  CREATE_SEQUENCE: { title: "CREATE SEQUENCE", kind: "statement", page: "sqlrf/CREATE-SEQUENCE", summary: "Creates a number generator used with `seq.NEXTVAL` / `seq.CURRVAL`.", syntax: "CREATE SEQUENCE s [START WITH n] [INCREMENT BY n] [CACHE n | NOCACHE] [CYCLE | NOCYCLE]" },
  ALTER_SEQUENCE: { title: "ALTER SEQUENCE", kind: "statement", page: "sqlrf/ALTER-SEQUENCE", summary: "Changes increment, limits, caching or restarts a sequence." },
  DROP_SEQUENCE: { title: "DROP SEQUENCE", kind: "statement", page: "sqlrf/DROP-SEQUENCE", summary: "Drops a sequence." },
  CREATE_SYNONYM: { title: "CREATE SYNONYM", kind: "statement", page: "sqlrf/CREATE-SYNONYM", summary: "Creates an alias for an object (private, or PUBLIC for every user), possibly over a database link.", syntax: "CREATE [OR REPLACE] [PUBLIC] SYNONYM s FOR [schema.]object[@dblink]" },
  DROP_SYNONYM: { title: "DROP SYNONYM", kind: "statement", page: "sqlrf/DROP-SYNONYM", summary: "Drops a synonym." },
  CREATE_USER: { title: "CREATE USER", kind: "statement", page: "sqlrf/CREATE-USER", summary: "Creates a database user (schema)." },
  DROP_USER: { title: "DROP USER", kind: "statement", page: "sqlrf/DROP-USER", summary: "Drops a user; `CASCADE` drops its objects." },
  CREATE_DBLINK: { title: "CREATE DATABASE LINK", kind: "statement", page: "sqlrf/CREATE-DATABASE-LINK", summary: "Creates a link to another database, used as `object@link`." },
  CREATE_TYPE_SQL: { title: "CREATE TYPE", kind: "statement", page: "lnpls/CREATE-TYPE-statement", summary: "Creates an object type, VARRAY or nested table type." },
  COMMENT: { title: "COMMENT ON", kind: "statement", page: "sqlrf/COMMENT", summary: "Stores a comment on a table, view or column (shown in hovers here).", syntax: "COMMENT ON {TABLE t | COLUMN t.c} IS 'text'" },
  GRANT: { title: "GRANT", kind: "statement", page: "sqlrf/GRANT", summary: "Grants system or object privileges and roles.", syntax: "GRANT {privilege | role} [ON object] TO {user | role | PUBLIC} [WITH GRANT OPTION]" },
  REVOKE: { title: "REVOKE", kind: "statement", page: "sqlrf/REVOKE", summary: "Revokes privileges or roles." },
  RENAME: { title: "RENAME", kind: "statement", page: "sqlrf/RENAME", summary: "Renames a table, view, sequence or private synonym." },
  PURGE: { title: "PURGE", kind: "statement", page: "sqlrf/PURGE", summary: "Removes objects from the recycle bin." },
  FLASHBACK_TABLE: { title: "FLASHBACK TABLE", kind: "statement", page: "sqlrf/FLASHBACK-TABLE", summary: "Restores a table to an earlier point or from the recycle bin (`TO BEFORE DROP`)." },
  ANALYZE: { title: "ANALYZE", kind: "statement", page: "sqlrf/ANALYZE", summary: "Validates structure or lists chained rows (use DBMS_STATS for optimizer statistics)." },
  // PL/SQL
  BLOCK: { title: "PL/SQL block", kind: "plsql", page: "lnpls/block", summary: "`DECLARE` declarations, `BEGIN` statements, optional `EXCEPTION` handlers, `END`. Run with `/` on its own line.", syntax: "[DECLARE …]\nBEGIN\n  …\n[EXCEPTION WHEN … THEN …]\nEND;\n/" },
  EXCEPTION: { title: "EXCEPTION handler", kind: "plsql", page: "lnpls/exception-handler", summary: "Handles errors raised in the block; `WHEN OTHERS` catches the rest (log, then re-RAISE).", syntax: "EXCEPTION\n  WHEN NO_DATA_FOUND THEN …\n  WHEN OTHERS THEN …" },
  IF: { title: "IF", kind: "plsql", page: "lnpls/IF-statement", summary: "Conditional execution.", syntax: "IF cond THEN …\n[ELSIF cond THEN …]\n[ELSE …]\nEND IF;" },
  LOOP: { title: "LOOP", kind: "plsql", page: "lnpls/basic-LOOP-statement", summary: "Repeats until EXIT / EXIT WHEN.", syntax: "LOOP\n  …\n  EXIT WHEN cond;\nEND LOOP;" },
  FOR_LOOP: { title: "FOR LOOP", kind: "plsql", page: "lnpls/FOR-LOOP-statement", summary: "Iterates over an integer range, or over a cursor / query (cursor FOR loop: `FOR r IN (SELECT …) LOOP`).", syntax: "FOR i IN [REVERSE] lo .. hi LOOP … END LOOP;", example: "FOR r IN (SELECT last_name FROM employees) LOOP\n  DBMS_OUTPUT.PUT_LINE(r.last_name);\nEND LOOP;" },
  WHILE: { title: "WHILE LOOP", kind: "plsql", page: "lnpls/WHILE-LOOP-statement", summary: "Repeats while the condition is TRUE.", syntax: "WHILE cond LOOP … END LOOP;" },
  EXIT: { title: "EXIT", kind: "plsql", page: "lnpls/EXIT-statement", summary: "Leaves the current (or labelled) loop.", syntax: "EXIT [label] [WHEN cond];" },
  CONTINUE: { title: "CONTINUE", kind: "plsql", page: "lnpls/CONTINUE-statement", summary: "Skips to the next loop iteration.", syntax: "CONTINUE [label] [WHEN cond];" },
  RETURN: { title: "RETURN", kind: "plsql", page: "lnpls/RETURN-statement", summary: "Ends a subprogram (functions return a value)." },
  RAISE: { title: "RAISE", kind: "plsql", page: "lnpls/RAISE-statement", summary: "Raises an exception; `RAISE;` in a handler re-raises the current one. For custom messages use `RAISE_APPLICATION_ERROR(-20000…-20999, 'msg')`." },
  GOTO: { title: "GOTO", kind: "plsql", page: "lnpls/GOTO-statement", summary: "Jumps to a `<<label>>`." },
  NULL_STMT: { title: "NULL statement", kind: "plsql", page: "lnpls/NULL-statement", summary: "Does nothing; a placeholder where a statement is required." },
  EXECUTE_IMMEDIATE: { title: "EXECUTE IMMEDIATE", kind: "plsql", page: "lnpls/EXECUTE-IMMEDIATE-statement", summary: "Runs a dynamic SQL statement or block; use binds (`USING`) instead of concatenating values.", syntax: "EXECUTE IMMEDIATE sql_text [INTO …] [USING [IN | OUT] bind, …]", example: "EXECUTE IMMEDIATE 'DELETE FROM t WHERE id = :1' USING v_id;" },
  OPEN: { title: "OPEN", kind: "plsql", page: "lnpls/OPEN-statement", summary: "Opens an explicit cursor (`OPEN c(args)`) or a cursor variable (`OPEN rc FOR query`)." },
  FETCH: { title: "FETCH (PL/SQL)", kind: "plsql", page: "lnpls/FETCH-statement", summary: "Reads the next row(s) of a cursor into variables; `BULK COLLECT INTO … LIMIT n` reads many.", syntax: "FETCH c {INTO v, … | BULK COLLECT INTO coll [LIMIT n]};" },
  CLOSE: { title: "CLOSE", kind: "plsql", page: "lnpls/CLOSE-statement", summary: "Closes a cursor." },
  FORALL: { title: "FORALL", kind: "plsql", page: "lnpls/FORALL-statement", summary: "Runs one DML statement for every element of a collection in a single round trip.", syntax: "FORALL i IN coll.FIRST .. coll.LAST [SAVE EXCEPTIONS]\n  INSERT INTO t VALUES coll(i);" },
  SELECT_INTO: { title: "SELECT INTO", kind: "plsql", page: "lnpls/SELECT-INTO-statement", summary: "Reads exactly one row into variables (NO_DATA_FOUND / TOO_MANY_ROWS otherwise); `BULK COLLECT INTO` reads many into collections.", example: "SELECT last_name INTO v_name FROM employees WHERE employee_id = 100;" },
  CURSOR: { title: "CURSOR", kind: "plsql", page: "lnpls/explicit-cursor-declaration-and-definition", summary: "Declares a named query, optionally with parameters.", syntax: "CURSOR c [(p type, …)] [RETURN rowtype] IS select;" },
  TYPE_ATTR: { title: "%TYPE", kind: "plsql", page: "lnpls/TYPE-attribute", summary: "Declares a variable with the data type of a column or another variable.", example: "v_sal employees.salary%TYPE;" },
  ROWTYPE_ATTR: { title: "%ROWTYPE", kind: "plsql", page: "lnpls/ROWTYPE-attribute", summary: "Declares a record with the columns of a table, view or cursor.", example: "r employees%ROWTYPE;" },
  CONSTANT: { title: "CONSTANT", kind: "plsql", page: "lnpls/constant-declaration", summary: "Declares a value that cannot change (initialiser required).", example: "c_rate CONSTANT NUMBER := 0.1;" },
  PRAGMA: { title: "PRAGMA", kind: "plsql", page: "lnpls/AUTONOMOUS_TRANSACTION-pragma", summary: "Compiler directive: `AUTONOMOUS_TRANSACTION`, `EXCEPTION_INIT`, `SERIALLY_REUSABLE`, `UDF`, `INLINE`." },
  AUTONOMOUS_TRANSACTION: { title: "PRAGMA AUTONOMOUS_TRANSACTION", kind: "plsql", page: "lnpls/AUTONOMOUS_TRANSACTION-pragma", summary: "Runs the subprogram in its own transaction (it must commit or roll back), e.g. for error logging." },
  EXCEPTION_INIT: { title: "PRAGMA EXCEPTION_INIT", kind: "plsql", page: "lnpls/EXCEPTION_INIT-pragma", summary: "Binds a user-declared exception to an ORA error number.", example: "e_locked EXCEPTION;\nPRAGMA EXCEPTION_INIT(e_locked, -54);" },
  PIPE_ROW: { title: "PIPE ROW", kind: "plsql", page: "lnpls/PIPE-ROW-statement", summary: "Returns one row from a PIPELINED table function." },
  RETURNING: { title: "RETURNING INTO", kind: "plsql", page: "lnpls/RETURNING-INTO-clause", summary: "Returns column values of the rows a DML statement changed.", example: "INSERT INTO t (name) VALUES ('x') RETURNING id INTO v_id;" },
  DETERMINISTIC: { title: "DETERMINISTIC", kind: "plsql", page: "lnpls/DETERMINISTIC-clause", summary: "Declares that a function always returns the same result for the same arguments." },
  PIPELINED: { title: "PIPELINED", kind: "plsql", page: "lnpls/PIPELINED-clause", summary: "A table function that returns rows incrementally with PIPE ROW." },
  RESULT_CACHE: { title: "RESULT_CACHE", kind: "plsql", page: "lnpls/RESULT_CACHE-clause", summary: "Caches function results across sessions." },
  CREATE_PROCEDURE: { title: "CREATE PROCEDURE", kind: "statement", page: "lnpls/CREATE-PROCEDURE-statement", summary: "Creates a standalone procedure. Compile errors appear as markers after running it.", syntax: "CREATE [OR REPLACE] PROCEDURE p (arg [IN | OUT | IN OUT] type, …) {IS | AS}\nBEGIN … END;\n/" },
  CREATE_FUNCTION: { title: "CREATE FUNCTION", kind: "statement", page: "lnpls/CREATE-FUNCTION-statement", summary: "Creates a standalone function.", syntax: "CREATE [OR REPLACE] FUNCTION f (arg type, …) RETURN type {IS | AS}\nBEGIN … RETURN …; END;\n/" },
  CREATE_PACKAGE: { title: "CREATE PACKAGE", kind: "statement", page: "lnpls/CREATE-PACKAGE-statement", summary: "Creates a package specification (public declarations)." },
  CREATE_PACKAGE_BODY: { title: "CREATE PACKAGE BODY", kind: "statement", page: "lnpls/CREATE-PACKAGE-BODY-statement", summary: "Creates the implementation of a package." },
  CREATE_TRIGGER: { title: "CREATE TRIGGER", kind: "statement", page: "lnpls/CREATE-TRIGGER-statement", summary: "Creates a trigger on DML, DDL or database events; row triggers see `:NEW` / `:OLD`.", syntax: "CREATE [OR REPLACE] TRIGGER t {BEFORE | AFTER | INSTEAD OF} {INSERT | UPDATE | DELETE} ON tab [FOR EACH ROW] [WHEN (…)]\nBEGIN … END;\n/" },
};

for (const [key, topic] of Object.entries(TOPICS)) topic.id = `topic:${key}`;

/** Word → topic, given the statement kind and the following words. */
function keywordTopic(word: string, next: string[], plsql: boolean): string | undefined {
  const [n1, n2] = next;
  const objectTopic = (verb: "CREATE" | "ALTER" | "DROP"): string | undefined => {
    let i = 0;
    if (next[i] === "OR" && next[i + 1] === "REPLACE") i += 2;
    while (["EDITIONABLE", "NONEDITIONABLE", "FORCE", "NOFORCE", "GLOBAL", "PRIVATE", "TEMPORARY", "UNIQUE", "BITMAP", "PUBLIC", "SHARED"].includes(next[i])) i++;
    const obj = next[i];
    const two = `${obj} ${next[i + 1] ?? ""}`;
    if (verb === "CREATE") {
      if (two === "MATERIALIZED VIEW") return "CREATE_MVIEW";
      if (two === "PACKAGE BODY") return "CREATE_PACKAGE_BODY";
      if (two === "DATABASE LINK") return "CREATE_DBLINK";
      return ({
        TABLE: "CREATE_TABLE", VIEW: "CREATE_VIEW", INDEX: "CREATE_INDEX", SEQUENCE: "CREATE_SEQUENCE",
        SYNONYM: "CREATE_SYNONYM", USER: "CREATE_USER", TYPE: "CREATE_TYPE_SQL", PROCEDURE: "CREATE_PROCEDURE",
        FUNCTION: "CREATE_FUNCTION", PACKAGE: "CREATE_PACKAGE", TRIGGER: "CREATE_TRIGGER",
      } as Record<string, string>)[obj];
    }
    if (verb === "ALTER") {
      return ({ TABLE: "ALTER_TABLE", INDEX: "ALTER_INDEX", SEQUENCE: "ALTER_SEQUENCE", VIEW: "ALTER_VIEW", SESSION: "ALTER_SESSION", SYSTEM: "ALTER_SYSTEM" } as Record<string, string>)[obj];
    }
    return ({ TABLE: "DROP_TABLE", VIEW: "DROP_VIEW", INDEX: "DROP_INDEX", SEQUENCE: "DROP_SEQUENCE", SYNONYM: "DROP_SYNONYM", USER: "DROP_USER" } as Record<string, string>)[obj];
  };

  switch (word) {
    case "CREATE":
    case "ALTER":
    case "DROP":
      return objectTopic(word);
    case "SELECT": return "SELECT";
    case "INTO": return plsql ? "SELECT_INTO" : "INSERT";
    case "BULK":
    case "COLLECT": return "SELECT_INTO";
    case "WITH": return n1 === "TIME" || n1 === "LOCAL" ? undefined : "WITH";
    case "FROM": return "SELECT";
    case "WHERE": return "WHERE";
    case "GROUP":
    case "ROLLUP":
    case "CUBE":
    case "GROUPING": return "GROUP_BY";
    case "HAVING": return "HAVING";
    case "ORDER":
    case "SIBLINGS":
    case "NULLS": return "ORDER_BY";
    case "ASC":
    case "DESC": return "ORDER_BY";
    case "OFFSET": return "FETCH_FIRST";
    case "FETCH": return plsql && n1 !== "FIRST" && n1 !== "NEXT" ? "FETCH" : "FETCH_FIRST";
    case "DISTINCT":
    case "UNIQUE": return "DISTINCT";
    case "JOIN":
    case "INNER":
    case "LEFT":
    case "RIGHT":
    case "FULL":
    case "OUTER":
    case "CROSS":
    case "USING":
    case "APPLY":
    case "LATERAL": return "JOIN";
    case "NATURAL": return n1 && /^(JOIN|INNER|LEFT|RIGHT|FULL)$/.test(n1) ? "JOIN" : undefined; // else the PL/SQL subtype
    case "ON": return n1 === "COMMIT" ? undefined : "JOIN";
    case "UNION":
    case "INTERSECT":
    case "MINUS":
    case "EXCEPT": return "SET_OPERATORS";
    case "CONNECT":
    case "PRIOR":
    case "START":
    case "NOCYCLE": return "CONNECT_BY";
    case "PIVOT":
    case "UNPIVOT": return "PIVOT";
    case "OVER":
    case "PARTITION": return "OVER";
    case "CASE": return "CASE";
    case "LIKE": return "LIKE";
    case "BETWEEN": return "BETWEEN";
    case "IN": return "IN";
    case "EXISTS": return "EXISTS";
    case "IS": return n1 === "NULL" || (n1 === "NOT" && n2 === "NULL") ? "IS_NULL" : plsql ? "BLOCK" : undefined;
    case "NULL": return plsql && (n1 === ";" || n1 === undefined) ? "NULL_STMT" : "NULL";
    case "AND":
    case "OR":
    case "NOT": return "LOGICAL";
    case "INSERT": return "INSERT";
    case "UPDATE": return "UPDATE";
    case "DELETE": return "DELETE";
    case "MERGE":
    case "MATCHED": return "MERGE";
    case "COMMIT": return "COMMIT";
    case "ROLLBACK": return "ROLLBACK";
    case "SAVEPOINT": return "SAVEPOINT";
    case "LOCK": return n1 === "TABLE" ? "LOCK_TABLE" : undefined;
    case "SET": return n1 === "TRANSACTION" ? "SET_TRANSACTION" : undefined;
    case "EXPLAIN": return "EXPLAIN_PLAN";
    case "CALL": return "CALL";
    case "TRUNCATE": return "TRUNCATE";
    case "COMMENT": return "COMMENT";
    case "GRANT": return "GRANT";
    case "REVOKE": return "REVOKE";
    case "RENAME": return "RENAME";
    case "PURGE": return "PURGE";
    case "FLASHBACK": return "FLASHBACK_TABLE";
    case "ANALYZE": return "ANALYZE";
    case "DECLARE":
    case "BEGIN":
    case "END": return n1 === "IF" ? "IF" : n1 === "LOOP" ? "LOOP" : n1 === "CASE" ? "CASE" : "BLOCK";
    case "EXCEPTION":
    case "OTHERS": return "EXCEPTION";
    case "WHEN": return plsql ? undefined : "CASE";
    case "IF":
      if (plsql) return "IF";
      // 23ai DDL: CREATE … IF NOT EXISTS / DROP … IF EXISTS
      return n1 === "NOT" ? "CREATE_TABLE" : n1 === "EXISTS" ? "DROP_TABLE" : undefined;
    case "ELSIF": return "IF";
    case "THEN": return plsql ? "IF" : "CASE";
    case "ELSE": return plsql ? "IF" : "CASE";
    case "LOOP": return "LOOP";
    case "FOR": return plsql ? "FOR_LOOP" : n1 === "UPDATE" ? "FOR_UPDATE" : undefined;
    case "REVERSE": return "FOR_LOOP";
    case "WHILE": return "WHILE";
    case "EXIT": return "EXIT";
    case "CONTINUE": return "CONTINUE";
    case "RETURN": return plsql ? "RETURN" : undefined;
    case "RETURNING": return "RETURNING";
    case "RAISE": return "RAISE";
    case "GOTO": return "GOTO";
    case "EXECUTE":
    case "IMMEDIATE": return "EXECUTE_IMMEDIATE";
    case "OPEN": return "OPEN";
    case "CLOSE": return "CLOSE";
    case "FORALL": return "FORALL";
    case "CURSOR": return "CURSOR";
    case "ROWTYPE": return "ROWTYPE_ATTR";
    case "CONSTANT": return "CONSTANT";
    case "PRAGMA": return n1 === "AUTONOMOUS_TRANSACTION" ? "AUTONOMOUS_TRANSACTION" : n1 === "EXCEPTION_INIT" ? "EXCEPTION_INIT" : "PRAGMA";
    case "AUTONOMOUS_TRANSACTION": return "AUTONOMOUS_TRANSACTION";
    case "EXCEPTION_INIT": return "EXCEPTION_INIT";
    case "PIPE": return "PIPE_ROW";
    case "DETERMINISTIC": return "DETERMINISTIC";
    case "PIPELINED": return "PIPELINED";
    case "RESULT_CACHE": return "RESULT_CACHE";
    default: return undefined;
  }
}

// ---------------------------------------------------------------- pseudo-columns, types, packages

const PSEUDO: Record<string, Doc> = {
  ROWNUM: { page: "sqlrf/ROWNUM-Pseudocolumn", summary: "Order in which a row was selected (1, 2, …), assigned before ORDER BY; prefer `FETCH FIRST n ROWS ONLY` for top-N.", example: "SELECT * FROM employees WHERE ROWNUM <= 10;" },
  ROWID: { page: "sqlrf/ROWID-Pseudocolumn", summary: "Physical address of a row: the fastest way to reach a single row." },
  LEVEL: { page: "sqlrf/Hierarchical-Query-Pseudocolumns", summary: "Depth of the row in a hierarchical query (root = 1)." },
  CONNECT_BY_ISLEAF: { page: "sqlrf/Hierarchical-Query-Pseudocolumns", summary: "1 when the row has no children in the hierarchy, else 0." },
  CONNECT_BY_ISCYCLE: { page: "sqlrf/Hierarchical-Query-Pseudocolumns", summary: "1 when the row's child is also its ancestor (needs `NOCYCLE`)." },
  NEXTVAL: { page: "sqlrf/Sequence-Pseudocolumns", summary: "`seq.NEXTVAL` increments the sequence and returns the new value." },
  CURRVAL: { page: "sqlrf/Sequence-Pseudocolumns", summary: "`seq.CURRVAL` returns the value NEXTVAL last returned in this session." },
  ORA_ROWSCN: { page: "sqlrf/ORA_ROWSCN-Pseudocolumn", summary: "System change number of the most recent change to the row (block level unless ROWDEPENDENCIES)." },
  COLUMN_VALUE: { page: "sqlrf/COLUMN_VALUE-Pseudocolumn", summary: "The value of a scalar collection element in `TABLE(collection)`." },
  OBJECT_ID: { page: "sqlrf/OBJECT_ID-Pseudocolumn", summary: "Object identifier of a row of an object table." },
  OBJECT_VALUE: { page: "sqlrf/OBJECT_VALUE-Pseudocolumn", summary: "The object instance of a row of an object table or view." },
  SYSDATE: { page: "sqlrf/SYSDATE", summary: "Current date and time of the database server's OS (DATE, no time zone).", example: "SELECT SYSDATE - 7 FROM dual;" },
  SYSTIMESTAMP: { page: "sqlrf/SYSTIMESTAMP", summary: "Current timestamp with time zone of the database server." },
  USER: { page: "sqlrf/USER", summary: "Name of the session user." },
  UID: { page: "sqlrf/UID", summary: "Numeric id of the session user." },
  SQLCODE: { page: "lnpls/SQLCODE-function", summary: "PL/SQL: number of the most recent exception (0 = none, 100 = NO_DATA_FOUND)." },
  SQLERRM: { page: "lnpls/SQLERRM-function", summary: "PL/SQL: message of the most recent exception (prefer `DBMS_UTILITY.FORMAT_ERROR_STACK`)." },
};
for (const v of ["VERSIONS_STARTSCN", "VERSIONS_STARTTIME", "VERSIONS_ENDSCN", "VERSIONS_ENDTIME", "VERSIONS_XID", "VERSIONS_OPERATION"]) {
  PSEUDO[v] = { page: "sqlrf/Version-Query-Pseudocolumns", summary: "Flashback version query column (`… VERSIONS BETWEEN SCN | TIMESTAMP … AND …`)." };
}

const SQL_TYPES = "sqlrf/Data-Types";
const PLSQL_TYPES = "lnpls/plsql-data-types";
const TYPES: Record<string, Doc> = {
  NUMBER: { page: SQL_TYPES, summary: "Exact decimal number: `NUMBER(p, s)` with up to 38 digits; `NUMBER` alone is floating decimal.", syntax: "NUMBER[(precision [, scale])]" },
  VARCHAR2: { page: SQL_TYPES, summary: "Variable-length text; length in BYTE or CHAR (`VARCHAR2(100 CHAR)`), up to 4000 bytes (32767 with MAX_STRING_SIZE = EXTENDED). Empty string is NULL.", syntax: "VARCHAR2(size [BYTE | CHAR])" },
  VARCHAR: { page: SQL_TYPES, summary: "Synonym of VARCHAR2 (use VARCHAR2)." },
  NVARCHAR2: { page: SQL_TYPES, summary: "Variable-length text in the national character set.", syntax: "NVARCHAR2(size)" },
  CHAR: { page: SQL_TYPES, summary: "Fixed-length, blank-padded text.", syntax: "CHAR[(size [BYTE | CHAR])]" },
  NCHAR: { page: SQL_TYPES, summary: "Fixed-length text in the national character set." },
  DATE: { page: SQL_TYPES, summary: "Date and time to the second (no fractional seconds, no time zone). Literal: `DATE '2024-01-31'`." },
  TIMESTAMP: { page: SQL_TYPES, summary: "Date and time with fractional seconds; `WITH [LOCAL] TIME ZONE` variants. Literal: `TIMESTAMP '2024-01-31 10:00:00'`.", syntax: "TIMESTAMP[(fractional_precision)] [WITH [LOCAL] TIME ZONE]" },
  INTERVAL: { page: SQL_TYPES, summary: "A period: `INTERVAL YEAR TO MONTH` or `INTERVAL DAY TO SECOND`. Literal: `INTERVAL '7' DAY`." },
  CLOB: { page: SQL_TYPES, summary: "Character large object (up to (4 GB - 1) × block size)." },
  NCLOB: { page: SQL_TYPES, summary: "Character large object in the national character set." },
  BLOB: { page: SQL_TYPES, summary: "Binary large object." },
  BFILE: { page: SQL_TYPES, summary: "Locator of a read-only binary file outside the database (in a DIRECTORY)." },
  RAW: { page: SQL_TYPES, summary: "Variable-length binary data (up to 2000 bytes, 32767 extended).", syntax: "RAW(size)" },
  LONG: { page: SQL_TYPES, summary: "Legacy long text (deprecated: use CLOB)." },
  ROWID: { page: SQL_TYPES, summary: "Physical row address." },
  UROWID: { page: SQL_TYPES, summary: "Universal row id (index-organized and foreign tables too)." },
  FLOAT: { page: SQL_TYPES, summary: "NUMBER subtype with binary precision.", syntax: "FLOAT[(binary_precision)]" },
  BINARY_FLOAT: { page: SQL_TYPES, summary: "32-bit IEEE 754 floating point." },
  BINARY_DOUBLE: { page: SQL_TYPES, summary: "64-bit IEEE 754 floating point." },
  INTEGER: { page: SQL_TYPES, summary: "ANSI type, stored as NUMBER(38)." },
  INT: { page: SQL_TYPES, summary: "ANSI type, stored as NUMBER(38)." },
  SMALLINT: { page: SQL_TYPES, summary: "ANSI type, stored as NUMBER(38)." },
  DECIMAL: { page: SQL_TYPES, summary: "ANSI type, stored as NUMBER(p, s)." },
  DEC: { page: SQL_TYPES, summary: "ANSI type, stored as NUMBER(p, s)." },
  NUMERIC: { page: SQL_TYPES, summary: "ANSI type, stored as NUMBER(p, s)." },
  REAL: { page: SQL_TYPES, summary: "ANSI type, stored as FLOAT(63)." },
  JSON: { page: SQL_TYPES, summary: "Native binary JSON (OSON) column type.", since: "21c" },
  XMLTYPE: { page: SQL_TYPES, summary: "XML document type." },
  BOOLEAN: { page: PLSQL_TYPES, summary: "TRUE / FALSE / NULL. Always available in PL/SQL; as a SQL column type from 23ai." },
  PLS_INTEGER: { page: PLSQL_TYPES, summary: "PL/SQL signed 32-bit integer (fast machine arithmetic, overflow raises an error)." },
  BINARY_INTEGER: { page: PLSQL_TYPES, summary: "PL/SQL: identical to PLS_INTEGER." },
  SIMPLE_INTEGER: { page: PLSQL_TYPES, summary: "PL/SQL: PLS_INTEGER NOT NULL that wraps on overflow (fastest in native compilation)." },
  NATURAL: { page: PLSQL_TYPES, summary: "PL/SQL subtype of PLS_INTEGER: 0 or more." },
  NATURALN: { page: PLSQL_TYPES, summary: "PL/SQL subtype: NATURAL NOT NULL." },
  POSITIVE: { page: PLSQL_TYPES, summary: "PL/SQL subtype of PLS_INTEGER: 1 or more." },
  POSITIVEN: { page: PLSQL_TYPES, summary: "PL/SQL subtype: POSITIVE NOT NULL." },
  SIGNTYPE: { page: PLSQL_TYPES, summary: "PL/SQL subtype of PLS_INTEGER: -1, 0 or 1." },
  SYS_REFCURSOR: { page: PLSQL_TYPES, summary: "Weakly typed cursor variable type (open with `OPEN rc FOR query`)." },
};

const PACKAGES: Record<string, string> = {
  DBMS_APPLICATION_INFO: "Sets MODULE / ACTION / CLIENT_INFO for monitoring (V$SESSION).",
  DBMS_ASSERT: "Validates and quotes identifiers and literals for dynamic SQL (SQL injection defence).",
  DBMS_CRYPTO: "Encryption, decryption, hashing and MACs.",
  DBMS_DATAPUMP: "Data Pump export / import from PL/SQL.",
  DBMS_DEBUG: "PL/SQL debugger API.",
  DBMS_ERRLOG: "Creates DML error logging tables (`LOG ERRORS INTO`).",
  DBMS_JOB: "Legacy job queue (use DBMS_SCHEDULER).",
  DBMS_LOB: "Reads, writes, compares and loads LOBs (`GETLENGTH`, `SUBSTR`, `APPEND`, …).",
  DBMS_LOCK: "User locks (`REQUEST`, `RELEASE`); `SLEEP` (prefer DBMS_SESSION.SLEEP).",
  DBMS_METADATA: "DDL of existing objects: `DBMS_METADATA.GET_DDL('TABLE', 'EMP')`.",
  DBMS_MVIEW: "Refreshes materialized views (`REFRESH`).",
  DBMS_OUTPUT: "Text output from PL/SQL (`PUT_LINE`), shown when SERVEROUTPUT is on.",
  DBMS_PIPE: "Messages between sessions of the same instance.",
  DBMS_RANDOM: "Random numbers and strings (`VALUE`, `STRING`); not for cryptography.",
  DBMS_REDEFINITION: "Online table redefinition.",
  DBMS_RLS: "Virtual Private Database policies (row-level security).",
  DBMS_SCHEDULER: "Jobs, programs, schedules and windows.",
  DBMS_SESSION: "Session settings: roles, contexts, `SLEEP`, package state reset.",
  DBMS_SQL: "Dynamic SQL with an unknown number of columns or binds.",
  DBMS_STATS: "Optimizer statistics: `GATHER_TABLE_STATS`, `GATHER_SCHEMA_STATS`, …",
  DBMS_UTILITY: "Utilities: `FORMAT_ERROR_STACK`, `FORMAT_ERROR_BACKTRACE`, `COMPILE_SCHEMA`, `GET_TIME`.",
  DBMS_XPLAN: "Formats execution plans: `DISPLAY`, `DISPLAY_CURSOR`.",
  UTL_FILE: "Reads and writes server-side files in a DIRECTORY.",
  UTL_HTTP: "HTTP(S) requests from the database (needs a network ACL).",
  UTL_I18N: "Globalization helpers: character-set conversion, escaping.",
  UTL_MAIL: "Sends e-mail (simple API over SMTP).",
  UTL_RAW: "RAW manipulation: casts, concatenation, bit operations.",
  UTL_SMTP: "Low-level SMTP client.",
  UTL_URL: "URL escaping and unescaping.",
};

// ---------------------------------------------------------------- lookup

export interface DocContext {
  /** Words after the hovered word (upper-case, for multi-word keywords). */
  next?: string[];
  /** Inside a PL/SQL block. */
  plsql?: boolean;
  /** The word is followed by `(`. */
  call?: boolean;
  /** Preceded by `%` (`%TYPE`, `%ROWTYPE`). */
  afterPercent?: boolean;
}

/** Help for a built-in function, if it is one. */
export function functionDoc(name: string): OracleDocEntry | undefined {
  const upper = name.toUpperCase();
  const extra = FUNCTIONS[upper];
  const sig = BUILTIN_SIGNATURES.get(upper)?.[0];
  if (!sig && !extra) return undefined;
  return {
    id: `fn:${upper}`,
    title: upper,
    kind: extra?.kind ?? "function",
    summary: extra?.summary ?? sig?.documentation ?? "",
    syntax: extra?.syntax ?? (sig ? signatureLabel(sig).label : undefined),
    ...(extra?.example ? { example: extra.example } : {}),
    page: extra?.page ?? `sqlrf/${upper}`,
  };
}

/**
 * Help for a word: a built-in function, keyword / clause / statement,
 * pseudo-column, data type or Oracle-supplied package.
 */
export function docFor(word: string, context: DocContext = {}): OracleDocEntry | undefined {
  const upper = word.toUpperCase();
  const next = (context.next ?? []).map((w) => w.toUpperCase());
  if (context.afterPercent) return upper === "TYPE" ? TOPICS.TYPE_ATTR : upper === "ROWTYPE" ? TOPICS.ROWTYPE_ATTR : undefined;

  const fn = functionDoc(upper);
  if (fn && context.call) return fn;
  const pseudo = PSEUDO[upper];
  if (pseudo) return { id: `pseudo:${upper}`, title: upper, kind: "pseudo-column", summary: pseudo.summary ?? "", ...pseudo } as OracleDocEntry;
  const pkg = PACKAGES[upper];
  if (pkg) return { id: `pkg:${upper}`, title: upper, kind: "package", summary: pkg, page: `arpls/${upper}` };

  const topic = keywordTopic(upper, next, !!context.plsql);
  if (topic && TOPICS[topic]) return TOPICS[topic];

  const type = TYPES[upper];
  if (type) return { id: `type:${upper}`, title: upper, kind: "type", summary: type.summary ?? "", ...type } as OracleDocEntry;
  // Without `(` only the functions written without parentheses (`OR REPLACE` is not REPLACE()).
  return fn && NO_PAREN.has(upper) ? fn : undefined;
}

/** Built-ins used without parentheses. */
const NO_PAREN = new Set(["CURRENT_DATE", "CURRENT_TIMESTAMP", "LOCALTIMESTAMP", "DBTIMEZONE", "SESSIONTIMEZONE", "CONNECT_BY_ROOT"]);

/** Every help entry (for translation coverage and link checking). */
export function allDocEntries(): OracleDocEntry[] {
  const names = new Set([...BUILTIN_SIGNATURES.keys(), ...Object.keys(FUNCTIONS)]);
  return [
    ...[...names].map((n) => functionDoc(n)!),
    ...Object.values(TOPICS),
    ...Object.keys(PSEUDO).map((n) => docFor(n)!),
    ...Object.keys(TYPES).map((n) => ({ id: `type:${n}`, title: n, kind: "type", summary: "", ...TYPES[n] }) as OracleDocEntry),
    ...Object.keys(PACKAGES).map((n) => docFor(n)!),
  ];
}

/** Every manual page referenced (for link checking). */
export function allDocPages(): string[] {
  const pages = new Set<string>();
  for (const name of BUILTIN_SIGNATURES.keys()) pages.add(functionDoc(name)!.page!);
  for (const name of Object.keys(FUNCTIONS)) pages.add(functionDoc(name)!.page!);
  for (const t of Object.values(TOPICS)) if (t.page) pages.add(t.page);
  for (const d of [...Object.values(PSEUDO), ...Object.values(TYPES)]) if (d.page) pages.add(d.page);
  for (const p of Object.keys(PACKAGES)) pages.add(`arpls/${p}`);
  return [...pages].sort();
}

/** Markdown for a help topic in `locale`, linked to the manual for `version`. */
export function renderDoc(entry: OracleDocEntry, version: OracleVersion = "19c", locale?: OracleLocale): string {
  const t = uiStrings(locale);
  const e = localizeDoc(entry, locale);
  const out: string[] = [`**${e.title}** — ${t.docKind[e.kind]}${e.since ? ` (${e.since}+)` : ""}`];
  if (e.syntax) out.push("```oracle\n" + e.syntax + "\n```");
  if (e.summary) out.push(e.summary);
  if (e.example) out.push(t.example + "\n```oracle\n" + e.example + "\n```");
  if (e.page) out.push(`[${t.documentation(version)}](${docUrl(e.page, version)})`);
  return out.join("\n\n");
}
