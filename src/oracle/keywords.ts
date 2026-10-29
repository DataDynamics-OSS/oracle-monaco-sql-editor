/**
 * Oracle SQL / PL/SQL language elements.
 *
 * Compiled from the public Oracle Database SQL Language Reference and PL/SQL
 * Language Reference (19c, plus later additions gated by `targetVersion`).
 * These are factual language data, shipped statically so the editor works
 * fully offline. Override/extend them via the `languageElements` prop on
 * `<OracleEditor />` (e.g. to inject site-specific functions or packages).
 */

/** SQL reserved words and common SQL keywords. */
export const ORACLE_KEYWORDS: string[] = [
  "ACCESS", "ADD", "ADMIN", "AFTER", "ALL", "ALTER", "ANALYZE", "AND", "ANY",
  "APPLY", "ARCHIVE", "AS", "ASC", "AUDIT", "AUTHID", "BEFORE", "BETWEEN",
  "BFILE", "BINARY", "BLOCK", "BODY", "BOTH", "BULK", "BY", "CACHE", "CASCADE",
  "CASE", "CHECK", "CLUSTER", "COLLECT", "COLUMN", "COLUMNS", "COMMENT",
  "COMMIT", "COMMITTED", "COMPOUND", "COMPRESS", "CONNECT", "CONSTRAINT",
  "CONSTRAINTS", "CONTAINER", "CREATE", "CROSS", "CUBE", "CURRENT", "CURSOR",
  "CYCLE", "DATABASE", "DAY", "DECLARE", "DEFAULT", "DEFERRABLE", "DEFERRED",
  "DEFINER", "DELETE", "DENSE_RANK", "DESC", "DETERMINISTIC", "DIMENSION",
  "DIRECTORY", "DISABLE", "DISTINCT", "DROP", "EACH", "EDITION", "EDITIONABLE",
  "ELSE", "ELSIF", "ENABLE", "END", "ERRORS", "ESCAPE", "EXCEPT", "EXCLUDE",
  "EXCLUSIVE", "EXECUTE", "EXISTS", "EXPLAIN", "EXTERNAL", "FETCH", "FILE",
  "FIRST", "FLASHBACK", "FOLLOWING", "FOR", "FORCE", "FOREIGN", "FROM", "FULL",
  "FUNCTION", "GLOBAL", "GRANT", "GROUP", "GROUPING", "HAVING", "HOUR",
  "IDENTIFIED", "IDENTITY", "IF", "IGNORE", "IMMEDIATE", "IN", "INCLUDE",
  "INCREMENT", "INDEX", "INITIAL", "INITIALLY", "INNER", "INSERT", "INSTEAD",
  "INTERSECT", "INTERVAL", "INTO", "INVISIBLE", "IS", "JOIN", "KEEP", "KEY",
  "LAST", "LATERAL", "LEADING", "LEFT", "LESS", "LEVEL", "LIKE", "LIKE2",
  "LIKE4", "LIKEC", "LIMIT", "LOCAL", "LOCK", "LOCKED", "LOG", "LOGGING",
  "MATCHED", "MATERIALIZED", "MAXVALUE", "MEASURES", "MERGE", "MINUS",
  "MINUTE", "MINVALUE", "MODE", "MODEL", "MODIFY", "MONTH", "NATURAL",
  "NESTED", "NEXT", "NOAUDIT", "NOCACHE", "NOCOMPRESS", "NOCYCLE", "NOLOGGING",
  "NOMAXVALUE", "NOMINVALUE", "NONE", "NONEDITIONABLE", "NOORDER", "NOPARALLEL",
  "NOT", "NOVALIDATE", "NOWAIT", "NULL", "NULLS", "OF", "OFFLINE", "OFFSET",
  "ON", "ONLINE", "ONLY", "OPTION", "OR", "ORDER", "ORGANIZATION", "OUTER",
  "OVER", "OVERFLOW", "PACKAGE", "PARALLEL", "PARTITION", "PATTERN", "PERCENT",
  "PIPELINED", "PIVOT", "PLAN", "PRECEDING", "PRESERVE", "PRIMARY", "PRIOR",
  "PRIVILEGES", "PROCEDURE", "PUBLIC", "PURGE", "RANGE", "READ", "REBUILD",
  "RECYCLEBIN", "REFERENCES", "REFRESH", "RENAME", "REPLACE", "RESOURCE",
  "RESTRICT", "RESULT_CACHE", "RETURN", "RETURNING", "REUSE", "REVOKE",
  "RIGHT", "ROLE", "ROLLBACK", "ROLLUP", "ROW", "ROWS", "SAMPLE", "SAVEPOINT",
  "SCHEMA", "SCN", "SECOND", "SEED", "SEGMENT", "SELECT", "SEQUENCE",
  "SERIALIZABLE", "SESSION", "SET", "SETS", "SHARE", "SIBLINGS", "SIZE", "SKIP",
  "SOME", "START", "STATEMENT_ID", "STORAGE", "SUBPARTITION", "SYNONYM",
  "SYSTEM", "TABLE", "TABLESPACE", "TEMPORARY", "THEN", "TIES", "TIME", "TO",
  "TRAILING", "TRANSACTION", "TRIGGER", "TRUNCATE", "TYPE", "UNBOUNDED",
  "UNDER", "UNIQUE", "UNLIMITED", "UNPIVOT", "UNUSABLE", "UPDATE", "USING",
  "VALIDATE", "VALUES", "VERSIONS", "VIEW", "VIRTUAL", "VISIBLE", "WAIT",
  "WHEN", "WHERE", "WITH", "WITHIN", "WORK", "WRITE", "XMLTYPE", "YEAR", "ZONE",
];

/** PL/SQL-only keywords (block structure, control flow, declarations). */
export const ORACLE_PLSQL_KEYWORDS: string[] = [
  "ACCESSIBLE", "AGGREGATE", "AUTONOMOUS_TRANSACTION", "BEGIN", "BULK_EXCEPTIONS",
  "BULK_ROWCOUNT", "CALL", "CLOSE", "COLLATION", "CONSTANT", "CONTINUE", "CROSSEDITION",
  "EXCEPTION", "EXCEPTION_INIT", "EXCEPTIONS", "EXIT", "FORALL", "FOUND", "GOTO",
  "INDICES", "INLINE", "INSTANTIABLE", "ISOPEN", "LOOP", "MEMBER", "NOCOPY",
  "NOTFOUND", "OPEN", "OTHERS", "OUT", "OVERRIDING", "PARALLEL_ENABLE", "PIPE",
  "PRAGMA", "RAISE", "RECORD", "REF", "RELIES_ON", "RESTRICT_REFERENCES",
  "REVERSE", "ROWCOUNT", "ROWTYPE", "SERIALLY_REUSABLE", "SELF", "STATIC",
  "SUBTYPE", "UDF", "VARRAY", "WHILE",
];

/** Built-in SQL functions (scalar, aggregate, analytic, JSON/XML). */
export const ORACLE_FUNCTIONS: string[] = [
  // numeric
  "ABS", "ACOS", "ASIN", "ATAN", "ATAN2", "BITAND", "CEIL", "COS", "COSH", "EXP",
  "FLOOR", "LN", "LOG", "MOD", "NANVL", "POWER", "REMAINDER", "ROUND", "SIGN",
  "SIN", "SINH", "SQRT", "TAN", "TANH", "TRUNC", "WIDTH_BUCKET",
  // character
  "ASCII", "CHR", "CONCAT", "INITCAP", "INSTR", "INSTRB", "LENGTH", "LENGTHB",
  "LOWER", "LPAD", "LTRIM", "NLS_INITCAP", "NLS_LOWER", "NLS_UPPER", "NLSSORT",
  "REGEXP_COUNT", "REGEXP_INSTR", "REGEXP_LIKE", "REGEXP_REPLACE", "REGEXP_SUBSTR",
  "REPLACE", "RPAD", "RTRIM", "SOUNDEX", "SUBSTR", "SUBSTRB", "TRANSLATE", "TRIM",
  "UPPER",
  // datetime
  "ADD_MONTHS", "CURRENT_DATE", "CURRENT_TIMESTAMP", "DBTIMEZONE", "EXTRACT",
  "FROM_TZ", "LAST_DAY", "LOCALTIMESTAMP", "MONTHS_BETWEEN", "NEW_TIME",
  "NEXT_DAY", "NUMTODSINTERVAL", "NUMTOYMINTERVAL", "SESSIONTIMEZONE",
  "SYS_EXTRACT_UTC", "TO_DSINTERVAL", "TO_YMINTERVAL", "TZ_OFFSET",
  // conversion
  "ASCIISTR", "BIN_TO_NUM", "CAST", "CHARTOROWID", "CONVERT", "HEXTORAW",
  "RAWTOHEX", "ROWIDTOCHAR", "TO_BINARY_DOUBLE", "TO_BINARY_FLOAT", "TO_BLOB",
  "TO_CHAR", "TO_CLOB", "TO_DATE", "TO_LOB", "TO_MULTI_BYTE", "TO_NCHAR",
  "TO_NCLOB", "TO_NUMBER", "TO_SINGLE_BYTE", "TO_TIMESTAMP", "TO_TIMESTAMP_TZ",
  "UNISTR", "VALIDATE_CONVERSION",
  // null / comparison / misc
  "COALESCE", "DECODE", "DUMP", "EMPTY_BLOB", "EMPTY_CLOB", "GREATEST", "LEAST",
  "LNNVL", "NULLIF", "NVL", "NVL2", "ORA_HASH", "STANDARD_HASH", "SYS_CONTEXT",
  "SYS_GUID", "USERENV", "VSIZE",
  // aggregate
  "APPROX_COUNT_DISTINCT", "APPROX_MEDIAN", "APPROX_PERCENTILE", "AVG", "COLLECT",
  "CORR", "COUNT", "COVAR_POP", "COVAR_SAMP", "CUME_DIST", "GROUP_ID",
  "GROUPING_ID", "LISTAGG", "MAX", "MEDIAN", "MIN", "PERCENTILE_CONT",
  "PERCENTILE_DISC", "PERCENT_RANK", "STATS_MODE", "STDDEV", "STDDEV_POP",
  "STDDEV_SAMP", "SUM", "VAR_POP", "VAR_SAMP", "VARIANCE",
  // analytic
  "DENSE_RANK", "FIRST_VALUE", "LAG", "LAST_VALUE", "LEAD", "NTH_VALUE", "NTILE",
  "RANK", "RATIO_TO_REPORT", "ROW_NUMBER",
  // hierarchical
  "SYS_CONNECT_BY_PATH", "CONNECT_BY_ROOT",
  // JSON
  "JSON_ARRAY", "JSON_ARRAYAGG", "JSON_EXISTS", "JSON_MERGEPATCH", "JSON_OBJECT",
  "JSON_OBJECTAGG", "JSON_QUERY", "JSON_SERIALIZE", "JSON_TABLE", "JSON_VALUE",
  // XML
  "EXTRACTVALUE", "XMLAGG", "XMLCAST", "XMLELEMENT", "XMLFOREST", "XMLQUERY",
  "XMLSERIALIZE", "XMLTABLE",
];

/** Operators spelled as words (highlighted as operators). */
export const ORACLE_OPERATORS: string[] = [
  "AND", "OR", "NOT", "IN", "LIKE", "LIKE2", "LIKE4", "LIKEC", "BETWEEN", "IS",
  "NULL", "EXISTS", "ALL", "ANY", "SOME", "PRIOR", "MOD", "MULTISET", "MEMBER",
  "SUBMULTISET", "UNION", "INTERSECT", "MINUS",
];

/** Built-in data types (SQL + common PL/SQL types). */
export const ORACLE_TYPES: string[] = [
  "BFILE", "BINARY_DOUBLE", "BINARY_FLOAT", "BINARY_INTEGER", "BLOB", "BOOLEAN",
  "CHAR", "CLOB", "DATE", "DEC", "DECIMAL", "FLOAT", "INT", "INTEGER", "JSON",
  "LONG", "NATURAL", "NATURALN", "NCHAR", "NCLOB", "NUMBER", "NUMERIC",
  "NVARCHAR2", "PLS_INTEGER", "POSITIVE", "POSITIVEN", "RAW", "REAL", "ROWID",
  "SIGNTYPE", "SIMPLE_INTEGER", "SMALLINT", "SYS_REFCURSOR", "TIMESTAMP",
  "UROWID", "VARCHAR", "VARCHAR2", "XMLTYPE",
];

/** Pseudo-columns and argument-less built-ins (highlighted as predefined). */
export const ORACLE_PSEUDO_COLUMNS: string[] = [
  "COLUMN_VALUE", "CONNECT_BY_ISCYCLE", "CONNECT_BY_ISLEAF", "CURRVAL", "LEVEL",
  "NEXTVAL", "OBJECT_ID", "OBJECT_VALUE", "ORA_ROWSCN", "ROWID", "ROWNUM",
  "SQLCODE", "SQLERRM", "SYSDATE", "SYSTIMESTAMP", "UID", "USER",
  "VERSIONS_ENDSCN", "VERSIONS_ENDTIME", "VERSIONS_OPERATION",
  "VERSIONS_STARTSCN", "VERSIONS_STARTTIME", "VERSIONS_XID",
];

/** Commonly used Oracle-supplied PL/SQL packages. */
export const ORACLE_BUILTIN_PACKAGES: string[] = [
  "DBMS_APPLICATION_INFO", "DBMS_ASSERT", "DBMS_CRYPTO", "DBMS_DATAPUMP",
  "DBMS_DEBUG", "DBMS_ERRLOG", "DBMS_JOB", "DBMS_LOB", "DBMS_LOCK",
  "DBMS_METADATA", "DBMS_MVIEW", "DBMS_OUTPUT", "DBMS_PIPE", "DBMS_RANDOM",
  "DBMS_REDEFINITION", "DBMS_RLS", "DBMS_SCHEDULER", "DBMS_SESSION", "DBMS_SQL",
  "DBMS_STATS", "DBMS_UTILITY", "DBMS_XPLAN", "UTL_FILE", "UTL_HTTP",
  "UTL_I18N", "UTL_MAIL", "UTL_RAW", "UTL_SMTP", "UTL_URL",
];

/**
 * Oracle reserved words (V$RESERVED_WORDS with RESERVED = 'Y', plus the SQL
 * Language Reference list). A dictionary name equal to one of these must be
 * double-quoted when inserted.
 */
export const ORACLE_RESERVED_WORDS: string[] = [
  "ACCESS", "ADD", "ALL", "ALTER", "AND", "ANY", "AS", "ASC", "AUDIT", "BETWEEN",
  "BY", "CHAR", "CHECK", "CLUSTER", "COLUMN", "COLUMN_VALUE", "COMMENT", "COMPRESS",
  "CONNECT", "CREATE", "CURRENT", "DATE", "DECIMAL", "DEFAULT", "DELETE", "DESC",
  "DISTINCT", "DROP", "ELSE", "EXCLUSIVE", "EXISTS", "FILE", "FLOAT", "FOR", "FROM",
  "GRANT", "GROUP", "HAVING", "IDENTIFIED", "IMMEDIATE", "IN", "INCREMENT", "INDEX",
  "INITIAL", "INSERT", "INTEGER", "INTERSECT", "INTO", "IS", "LEVEL", "LIKE", "LOCK",
  "LONG", "MAXEXTENTS", "MINUS", "MLSLABEL", "MODE", "MODIFY", "NESTED_TABLE_ID",
  "NOAUDIT", "NOCOMPRESS", "NOT", "NOWAIT", "NULL", "NUMBER", "OF", "OFFLINE", "ON",
  "ONLINE", "OPTION", "OR", "ORDER", "PCTFREE", "PRIOR", "PUBLIC", "RAW", "RENAME",
  "RESOURCE", "REVOKE", "ROW", "ROWID", "ROWNUM", "ROWS", "SELECT", "SESSION", "SET",
  "SHARE", "SIZE", "SMALLINT", "START", "SUCCESSFUL", "SYNONYM", "SYSDATE", "TABLE",
  "THEN", "TO", "TRIGGER", "UID", "UNION", "UNIQUE", "UPDATE", "USER", "VALIDATE",
  "VALUES", "VARCHAR", "VARCHAR2", "VIEW", "WHENEVER", "WHERE", "WITH",
];

/**
 * Keywords introduced after 19c, keyed by the first version that accepts them.
 * Filtered out unless `targetVersion` is at least that version.
 */
export const ORACLE_VERSIONED_KEYWORDS: Record<"21c" | "23ai", string[]> = {
  "21c": ["QUALIFY", "SQL_MACRO"],
  "23ai": ["BOOLEAN", "DOMAIN", "LOCKFREE", "ANNOTATIONS", "VECTOR", "GRAPH_TABLE"],
};

export type OracleVersion = "19c" | "21c" | "23ai";

export interface OracleLanguageElements {
  /** SQL keywords. */
  keywords: string[];
  /** PL/SQL-only keywords. */
  plsqlKeywords: string[];
  /** Built-in SQL functions. */
  functions: string[];
  /** Word operators. */
  operators: string[];
  /** Built-in data types. */
  types: string[];
  /** Pseudo-columns (ROWNUM, SYSDATE, …). */
  pseudoColumns: string[];
  /** Oracle-supplied packages (DBMS_*, UTL_*). */
  builtinPackages: string[];
}

export const DEFAULT_LANGUAGE_ELEMENTS: OracleLanguageElements = {
  keywords: ORACLE_KEYWORDS,
  plsqlKeywords: ORACLE_PLSQL_KEYWORDS,
  functions: ORACLE_FUNCTIONS,
  operators: ORACLE_OPERATORS,
  types: ORACLE_TYPES,
  pseudoColumns: ORACLE_PSEUDO_COLUMNS,
  builtinPackages: ORACLE_BUILTIN_PACKAGES,
};

const VERSION_ORDER: OracleVersion[] = ["19c", "21c", "23ai"];

/** Keywords newer than 19c that `version` accepts. */
export function versionedKeywords(version: OracleVersion = "19c"): string[] {
  const max = VERSION_ORDER.indexOf(version);
  const out: string[] = [];
  if (max >= 1) out.push(...ORACLE_VERSIONED_KEYWORDS["21c"]);
  if (max >= 2) out.push(...ORACLE_VERSIONED_KEYWORDS["23ai"]);
  return out;
}

/**
 * Merge a partial override over the built-in language elements and add the
 * keywords enabled by `version` (19c by default, the minimum supported).
 */
export function resolveLanguageElements(
  partial?: Partial<OracleLanguageElements>,
  version: OracleVersion = "19c",
): OracleLanguageElements {
  const d = DEFAULT_LANGUAGE_ELEMENTS;
  const keywords = partial?.keywords ?? d.keywords;
  const extra = versionedKeywords(version).filter((k) => !keywords.includes(k));
  return {
    keywords: extra.length ? [...keywords, ...extra] : keywords,
    plsqlKeywords: partial?.plsqlKeywords ?? d.plsqlKeywords,
    functions: partial?.functions ?? d.functions,
    operators: partial?.operators ?? d.operators,
    types: partial?.types ?? d.types,
    pseudoColumns: partial?.pseudoColumns ?? d.pseudoColumns,
    builtinPackages: partial?.builtinPackages ?? d.builtinPackages,
  };
}
