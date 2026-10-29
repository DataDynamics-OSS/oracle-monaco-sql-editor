/**
 * A `metadataProvider` backed by the Oracle data dictionary (ALL_* views).
 *
 * Turns the parser-derived caret context into dictionary lookups:
 *
 *   FROM |                -> tables / views / synonyms of the current schema,
 *                            schemas, public synonyms (once 2+ chars typed)
 *   FROM hr.|             -> objects of schema HR
 *   WHERE e.|             -> columns of e's table (synonyms followed)
 *   SELECT | FROM a, b    -> columns of every table in scope
 *   dbms_output.|         -> members of the package
 *   seq.|                 -> NEXTVAL / CURRVAL
 *   BEGIN |               -> procedures / packages; functions while typing
 *   DECLARE v |           -> user-defined types;  emp@|  -> database links
 *
 * Also answers signature help (`signatures`, from ALL_ARGUMENTS with
 * overloads) and hovers (`describe`: tables, columns, routines, sequences,
 * schemas — synonyms followed, comments included).
 *
 * Every lookup uses bind variables and a row limit, results are cached with a
 * TTL, identical lookups in flight are shared, and each completion round
 * aborts the previous round's requests. Call `invalidate()` after DDL.
 */
import type { MetadataProvider, MetadataProviderContext, OracleMetadataItem, OracleObjectKind } from "./completion";
import { sameIdent, splitQualified } from "./identifiers";
import { createQueryCache } from "../core/cache";
import type { OracleTransport } from "./transport/types";
import type { AliasInfo } from "../worker/protocol";
import type { CallSite, OracleParameter, OracleSignature } from "./signatures";
import type { DescribeTarget, OracleColumnInfo, OracleObjectInfo } from "./hover";

export interface OracleMetadataOptions {
  transport: OracleTransport;
  /**
   * Current schema (getter, so `ALTER SESSION SET CURRENT_SCHEMA` can be
   * reflected). Defaults to `transport.session()`, then `SYS_CONTEXT`.
   */
  currentSchema?: () => string | undefined;
  /** Cache TTL in ms. Default 5 minutes; 0 disables caching. */
  cacheTtlMs?: number;
  /** Maximum rows per object list. Default 500. */
  maxItems?: number;
  /** Look up columns of remote tables over database links. Default false (remote round trips). */
  dbLinkMetadata?: boolean;
}

export interface OracleMetadataProvider extends MetadataProvider {
  /** Forget cached dictionary data (call after DDL or a schema switch). */
  invalidate(): void;
  /** Warm the cache with the current schema's tables and views. */
  prefetch(): Promise<void>;
  /** Overloads of the routine called at a call site (signature help, named-argument completion). */
  signatures(call: CallSite): Promise<OracleSignature[]>;
  /** What a (qualified) name refers to (hover). */
  describe(target: DescribeTarget): Promise<OracleObjectInfo | undefined>;
}

type Row = unknown[];

interface Resolved {
  owner: string;
  name: string;
  type: string;
  dbLink?: string;
  /** First synonym followed (`PUBLIC.EMP`). */
  via?: string;
}

const RELATION_TYPES = ["TABLE", "VIEW", "MATERIALIZED VIEW", "SYNONYM"];
const KIND: Record<string, OracleObjectKind> = {
  TABLE: "table",
  VIEW: "view",
  "MATERIALIZED VIEW": "materialized_view",
  SYNONYM: "synonym",
  SEQUENCE: "sequence",
  PACKAGE: "package",
  PROCEDURE: "procedure",
  FUNCTION: "function",
  TYPE: "type",
};
const DB_LINK = /^[A-Za-z][\w$#]*(?:\.[A-Za-z][\w$#]*)*$/;

const typeList = (types: string[]) => types.map((t) => `'${t}'`).join(", ");

/** LIKE pattern for a typed prefix: dictionary case, wildcards escaped. */
function likePrefix(word: string): string {
  const quoted = word.startsWith('"');
  const raw = quoted ? word.slice(1).replace(/"$/, "") : word.toUpperCase();
  return raw.replace(/[\\%_]/g, (c) => `\\${c}`) + "%";
}

/** Dictionary form of one qualifier part. */
function dictName(part: string, quoted: boolean | undefined): string {
  return quoted ? part : part.toUpperCase();
}

/** `VARCHAR2(25 CHAR)`, `NUMBER(8,2)`, `DATE` … from ALL_TAB_COLUMNS fields. */
function columnType(row: Row): string {
  const [, type, length, precision, scale, , charLength, charUsed] = row as [
    string, string, number | string, number | string | null, number | string | null, string, number | string, string,
  ];
  if (/CHAR/.test(type) && !/LOB/.test(type)) return `${type}(${charLength}${charUsed === "C" ? " CHAR" : ""})`;
  if (type === "RAW") return `RAW(${length})`;
  if (type === "NUMBER" && precision !== null && precision !== undefined) {
    return scale && Number(scale) !== 0 ? `NUMBER(${precision},${scale})` : `NUMBER(${precision})`;
  }
  if (type === "FLOAT" && precision !== null) return `FLOAT(${precision})`;
  return type;
}

export function createOracleMetadataProvider(options: OracleMetadataOptions): OracleMetadataProvider {
  const { transport } = options;
  const max = Math.max(1, Math.floor(options.maxItems ?? 500));
  const cache = createQueryCache(options.cacheTtlMs ?? 5 * 60_000);
  let sessionSchema: Promise<string> | null = null;
  let controller: AbortController | null = null;

  function query(sql: string, binds: Record<string, string>, signal: AbortSignal): Promise<Row[]> {
    return cache.get(
      `${sql}\u0000${JSON.stringify(binds)}`,
      (s) => transport.execute({ sql, binds, category: "query", maxRows: max }, s).then((r) => r.rows ?? []),
      signal,
    );
  }

  /** Resolve a list query to [] on failure, so one bad lookup can't break the rest. */
  const safe = <T>(p: Promise<T[]>): Promise<T[]> => p.catch(() => []);

  async function currentSchema(signal: AbortSignal): Promise<string> {
    const fromOption = options.currentSchema?.();
    if (fromOption) return fromOption;
    if (!sessionSchema) {
      sessionSchema = (
        transport.session
          ? transport.session().then((s) => s.currentSchema)
          : transport
              .execute({ sql: "SELECT SYS_CONTEXT('USERENV', 'CURRENT_SCHEMA') FROM dual", category: "query" }, signal)
              .then((r) => String(r.rows?.[0]?.[0] ?? ""))
      ).catch((e) => {
        sessionSchema = null;
        throw e;
      });
    }
    return sessionSchema;
  }

  // ---------------------------------------------------------------- lookups

  async function objects(owner: string, types: string[], word: string, signal: AbortSignal): Promise<OracleMetadataItem[]> {
    const rows = await query(
      `SELECT object_name, object_type FROM all_objects
        WHERE owner = :owner AND object_type IN (${typeList(types)})
          AND object_name LIKE :p ESCAPE '\\' AND object_name NOT LIKE 'BIN$%'
        ORDER BY object_name FETCH FIRST ${max} ROWS ONLY`,
      { owner, p: likePrefix(word) },
      signal,
    );
    return rows.map(([name, type]) => ({
      label: String(name),
      kind: KIND[String(type)] ?? "table",
      detail: `${String(type).toLowerCase()} · ${owner}`,
      owner,
    }));
  }

  async function schemas(word: string, signal: AbortSignal): Promise<OracleMetadataItem[]> {
    // Oracle-maintained accounts (SYS, AUDSYS, …) only once the user types a prefix.
    const rows = await query(
      `SELECT username FROM all_users
        WHERE username LIKE :p ESCAPE '\\' ${word ? "" : "AND oracle_maintained = 'N'"}
        ORDER BY username FETCH FIRST ${max} ROWS ONLY`,
      { p: likePrefix(word) },
      signal,
    );
    return rows.map(([u]) => ({ label: String(u), kind: "schema" as const, detail: "schema" }));
  }

  async function publicSynonyms(word: string, signal: AbortSignal): Promise<OracleMetadataItem[]> {
    if (word.replace(/"/g, "").length < 2) return []; // thousands of them
    const rows = await query(
      `SELECT synonym_name, table_owner, table_name FROM all_synonyms
        WHERE owner = 'PUBLIC' AND synonym_name LIKE :p ESCAPE '\\'
        ORDER BY synonym_name FETCH FIRST ${max} ROWS ONLY`,
      { p: likePrefix(word) },
      signal,
    );
    return rows.map(([name, owner, target]) => ({
      label: String(name),
      kind: "synonym" as const,
      detail: `public synonym → ${owner}.${target}`,
    }));
  }

  async function userExists(name: string, signal: AbortSignal): Promise<boolean> {
    const rows = await query("SELECT 1 FROM all_users WHERE username = :u", { u: name }, signal);
    return rows.length > 0;
  }

  /** Follow synonyms (private, then public) to the underlying object. */
  async function resolve(owner: string | undefined, name: string, signal: AbortSignal, depth = 0): Promise<Resolved | undefined> {
    if (depth > 4) return undefined;
    const owners = owner ? [owner] : [await currentSchema(signal), "PUBLIC"];
    for (const o of owners) {
      const types = (
        await query(
          `SELECT object_type FROM all_objects
            WHERE owner = :owner AND object_name = :name
              AND object_type IN ('TABLE', 'VIEW', 'MATERIALIZED VIEW', 'SYNONYM', 'SEQUENCE', 'PACKAGE', 'TYPE', 'PROCEDURE', 'FUNCTION')`,
          { owner: o, name },
          signal,
        )
      ).map(([t]) => String(t));
      const direct = types.find((t) => t !== "SYNONYM");
      if (direct) return { owner: o, name, type: direct };
      if (types.includes("SYNONYM")) {
        const [syn] = await query(
          "SELECT table_owner, table_name, db_link FROM all_synonyms WHERE owner = :owner AND synonym_name = :name",
          { owner: o, name },
          signal,
        );
        if (!syn) return undefined;
        const [tOwner, tName, link] = syn.map((v) => (v === null || v === undefined ? undefined : String(v)));
        const via = `${o}.${name}`;
        if (link) return { owner: tOwner ?? "", name: tName ?? name, type: "REMOTE", dbLink: link, via };
        const target = await resolve(tOwner, tName ?? name, signal, depth + 1);
        return target && { ...target, via: target.via ?? via };
      }
    }
    return undefined;
  }

  async function columnInfos(target: Resolved, signal: AbortSignal): Promise<OracleColumnInfo[]> {
    let rows: Row[];
    if (target.dbLink) {
      if (!options.dbLinkMetadata || !DB_LINK.test(target.dbLink)) return [];
      rows = await query(
        `SELECT column_name, data_type, data_length, data_precision, data_scale, nullable, char_length, char_used, NULL
           FROM ${target.owner ? "all" : "user"}_tab_columns@${target.dbLink}
          WHERE ${target.owner ? "owner = :owner AND " : ""}table_name = :name ORDER BY column_id`,
        target.owner ? { owner: target.owner, name: target.name } : { name: target.name },
        signal,
      );
    } else {
      rows = await query(
        `SELECT c.column_name, c.data_type, c.data_length, c.data_precision, c.data_scale,
                c.nullable, c.char_length, c.char_used, m.comments
           FROM all_tab_columns c
           LEFT JOIN all_col_comments m
             ON m.owner = c.owner AND m.table_name = c.table_name AND m.column_name = c.column_name
          WHERE c.owner = :owner AND c.table_name = :name
          ORDER BY c.column_id`,
        { owner: target.owner, name: target.name },
        signal,
      );
    }
    return rows.map((row) => ({
      name: String(row[0]),
      type: columnType(row),
      nullable: row[5] !== "N",
      ...(row[8] ? { comment: String(row[8]) } : {}),
    }));
  }

  async function columns(target: Resolved, signal: AbortSignal): Promise<OracleMetadataItem[]> {
    return (await columnInfos(target, signal)).map((c) => ({
      label: c.name,
      kind: "column" as const,
      detail: `${c.type}${c.nullable ? "" : " NOT NULL"} · ${target.name}`,
      ...(c.comment ? { documentation: c.comment } : {}),
      owner: target.owner,
    }));
  }

  async function packageMembers(target: Resolved, word: string, signal: AbortSignal): Promise<OracleMetadataItem[]> {
    const rows = await query(
      `SELECT p.procedure_name,
              CASE WHEN EXISTS (SELECT 1 FROM all_arguments a
                                 WHERE a.owner = p.owner AND a.package_name = p.object_name
                                   AND a.object_name = p.procedure_name AND a.position = 0)
                   THEN 'FUNCTION' ELSE 'PROCEDURE' END
         FROM all_procedures p
        WHERE p.owner = :owner AND p.object_name = :name
          AND p.procedure_name IS NOT NULL AND p.procedure_name LIKE :p ESCAPE '\\'
        GROUP BY p.owner, p.object_name, p.procedure_name
        ORDER BY p.procedure_name FETCH FIRST ${max} ROWS ONLY`,
      { owner: target.owner, name: target.name, p: likePrefix(word) },
      signal,
    );
    return rows.map(([name, kind]) => ({
      label: String(name),
      kind: kind === "FUNCTION" ? ("function" as const) : ("procedure" as const),
      detail: `${String(kind).toLowerCase()} · ${target.owner}.${target.name}`,
      owner: target.owner,
    }));
  }

  const sequencePseudo = (target: Resolved): OracleMetadataItem[] =>
    ["NEXTVAL", "CURRVAL"].map((label) => ({ label, kind: "sequence" as const, detail: `sequence · ${target.name}` }));

  /** Members of a resolved object: columns, package members or sequence pseudo-columns. */
  async function membersOf(target: Resolved | undefined, word: string, signal: AbortSignal): Promise<OracleMetadataItem[]> {
    if (!target) return [];
    switch (target.type) {
      case "TABLE":
      case "VIEW":
      case "MATERIALIZED VIEW":
      case "REMOTE":
        return columns(target, signal);
      case "PACKAGE":
        return packageMembers(target, word, signal);
      case "SEQUENCE":
        return sequencePseudo(target);
      default:
        return [];
    }
  }

  /** Columns of a table written in the statement (`hr.emp`, `"Mixed"`, `emp@link`). */
  async function columnsOfText(text: string, dbLink: string | undefined, signal: AbortSignal): Promise<OracleMetadataItem[]> {
    const { parts } = splitQualified(text);
    const link = dbLink?.toUpperCase();
    if (!parts.length) return [];
    if (link) {
      return columns({ owner: parts.length > 1 ? parts[0] : "", name: parts[parts.length - 1], type: "REMOTE", dbLink: link }, signal);
    }
    const target = await resolve(parts.length > 1 ? parts[0] : undefined, parts[parts.length - 1], signal);
    return target ? membersOf(target, "", signal) : [];
  }

  // ---------------------------------------------------------------- signatures

  const IN_OUT: Record<string, OracleParameter["mode"]> = { IN: "IN", OUT: "OUT", "IN/OUT": "IN OUT" };

  /** Overloads of a standalone routine (`pkg` undefined) or package member, from ALL_ARGUMENTS. */
  async function routineSignatures(owner: string, pkg: string | undefined, name: string, signal: AbortSignal): Promise<OracleSignature[]> {
    const rows = await query(
      `SELECT overload, position, argument_name, data_type, in_out, defaulted, pls_type, type_owner, type_name, type_subname
         FROM all_arguments
        WHERE owner = :owner AND object_name = :name AND ${pkg ? "package_name = :pkg" : "package_name IS NULL"}
          AND data_level = 0
        ORDER BY TO_NUMBER(overload) NULLS FIRST, sequence`,
      pkg ? { owner, name, pkg } : { owner, name },
      signal,
    );
    const byOverload = new Map<string, OracleSignature>();
    for (const [overload, position, argName, dataType, inOut, defaulted, plsType, typeOwner, typeName, typeSub] of rows) {
      const key = String(overload ?? "");
      let sig = byOverload.get(key);
      if (!sig) {
        sig = { name, kind: "procedure", owner, ...(pkg ? { package: pkg } : {}), parameters: [] };
        byOverload.set(key, sig);
      }
      const type = typeName
        ? [typeOwner, typeName, typeSub].filter((x) => x !== null && x !== undefined && x !== "").join(".")
        : String(plsType ?? dataType ?? "");
      if (Number(position) === 0 && (argName === null || argName === undefined)) {
        sig.kind = "function";
        sig.returnType = type;
        continue;
      }
      if (argName === null || argName === undefined) continue; // the placeholder row of a parameterless procedure
      sig.parameters.push({
        name: String(argName),
        ...(type ? { type } : {}),
        mode: IN_OUT[String(inOut)] ?? "IN",
        ...(defaulted === "Y" ? { optional: true } : {}),
      });
    }
    if (!byOverload.size && pkg) {
      // 18c+ lists no ALL_ARGUMENTS row for a parameterless procedure.
      const member = (await packageMembers({ owner, name: pkg, type: "PACKAGE" }, name, signal))
        .find((m) => m.label === name);
      if (member) return [{ name, kind: member.kind === "function" ? "function" : "procedure", owner, package: pkg, parameters: [] }];
    }
    return [...byOverload.values()];
  }

  const ROUTINE = new Set(["PROCEDURE", "FUNCTION"]);

  async function signaturesFor(call: CallSite, signal: AbortSignal): Promise<OracleSignature[]> {
    if (call.dbLink) return [];
    const p = call.parts.map((x, i) => dictName(x, call.quoted[i]));
    if (p.length === 1) {
      const r = await resolve(undefined, p[0], signal);
      return r && ROUTINE.has(r.type) ? routineSignatures(r.owner, undefined, r.name, signal) : [];
    }
    if (p.length === 2) {
      const r = await resolve(undefined, p[0], signal);
      if (r?.type === "PACKAGE") return routineSignatures(r.owner, r.name, p[1], signal);
      const inSchema = await resolve(p[0], p[1], signal);
      return inSchema && ROUTINE.has(inSchema.type) ? routineSignatures(inSchema.owner, undefined, inSchema.name, signal) : [];
    }
    if (p.length === 3) {
      const r = await resolve(p[0], p[1], signal);
      return r?.type === "PACKAGE" ? routineSignatures(r.owner, r.name, p[2], signal) : [];
    }
    return [];
  }

  // ---------------------------------------------------------------- describe

  async function objectStatus(r: Resolved, signal: AbortSignal): Promise<string | undefined> {
    const [row] = await query(
      "SELECT status FROM all_objects WHERE owner = :owner AND object_name = :name AND object_type = :type",
      { owner: r.owner, name: r.name, type: r.type },
      signal,
    );
    return row ? String(row[0]) : undefined;
  }

  /** Hover facts for a resolved object. */
  async function objectInfo(r: Resolved, signal: AbortSignal): Promise<OracleObjectInfo> {
    const base: OracleObjectInfo = {
      kind: r.type === "REMOTE" ? "table" : KIND[r.type] ?? "table",
      name: r.name,
      ...(r.owner ? { owner: r.owner } : {}),
      ...(r.type !== "REMOTE" ? { objectType: r.type } : {}),
      ...(r.via ? { synonym: r.via } : {}),
      ...(r.dbLink ? { dbLink: r.dbLink } : {}),
    };
    if (r.type === "REMOTE") return { ...base, columns: await safe(columnInfos(r, signal)) };
    const status = await objectStatus(r, signal).catch(() => undefined);
    if (status) base.status = status;
    switch (r.type) {
      case "TABLE":
      case "VIEW":
      case "MATERIALIZED VIEW": {
        const [cols, comment] = await Promise.all([
          safe(columnInfos(r, signal)),
          query("SELECT comments FROM all_tab_comments WHERE owner = :owner AND table_name = :name", { owner: r.owner, name: r.name }, signal)
            .then((rows) => (rows[0]?.[0] ? String(rows[0][0]) : undefined))
            .catch(() => undefined),
        ]);
        return { ...base, columns: cols, ...(comment ? { comment } : {}) };
      }
      case "PACKAGE":
        return { ...base, members: (await safe(packageMembers(r, "", signal))).map((m) => m.label) };
      case "PROCEDURE":
      case "FUNCTION":
        return { ...base, signatures: await safe(routineSignatures(r.owner, undefined, r.name, signal)) };
      case "SEQUENCE": {
        const [row] = await query(
          `SELECT min_value, max_value, increment_by, cycle_flag, cache_size, last_number
             FROM all_sequences WHERE sequence_owner = :owner AND sequence_name = :name`,
          { owner: r.owner, name: r.name },
          signal,
        ).catch(() => []);
        if (!row) return base;
        const labels = ["min", "max", "increment by", "cycle", "cache", "last number"];
        return { ...base, properties: labels.map((l, i) => [l, String(row[i] ?? "")] as [string, string]) };
      }
      default:
        return base;
    }
  }

  /** A member of a resolved object: column, package routine, sequence pseudo-column. */
  async function memberInfo(parent: Resolved, member: string, signal: AbortSignal): Promise<OracleObjectInfo | undefined> {
    switch (parent.type) {
      case "TABLE":
      case "VIEW":
      case "MATERIALIZED VIEW":
      case "REMOTE": {
        const col = (await columnInfos(parent, signal)).find((c) => c.name === member);
        if (!col) return undefined;
        return {
          kind: "column",
          name: col.name,
          dataType: col.type,
          nullable: col.nullable,
          parent: `${parent.owner ? `${parent.owner}.` : ""}${parent.name}${parent.dbLink ? `@${parent.dbLink}` : ""}`,
          ...(col.comment ? { comment: col.comment } : {}),
        };
      }
      case "PACKAGE": {
        const sigs = await routineSignatures(parent.owner, parent.name, member, signal);
        if (!sigs.length) return undefined;
        return { kind: sigs[0].kind, name: member, owner: `${parent.owner}.${parent.name}`, signatures: sigs };
      }
      case "SEQUENCE":
        return member === "NEXTVAL" || member === "CURRVAL"
          ? { kind: "sequence", name: member, parent: `${parent.owner}.${parent.name}`, comment: member === "NEXTVAL" ? "Next value of the sequence." : "Value last returned by NEXTVAL in this session." }
          : undefined;
      default:
        return undefined;
    }
  }

  /** Resolve a table written in the statement (alias target) to a dictionary object. */
  async function resolveText(text: string, dbLink: string | undefined, signal: AbortSignal): Promise<Resolved | undefined> {
    const { parts } = splitQualified(text);
    if (!parts.length) return undefined;
    const link = dbLink?.toUpperCase();
    if (link) return { owner: parts.length > 1 ? parts[0] : "", name: parts[parts.length - 1], type: "REMOTE", dbLink: link };
    return resolve(parts.length > 1 ? parts[0] : undefined, parts[parts.length - 1], signal);
  }

  async function describeTarget(t: DescribeTarget, signal: AbortSignal): Promise<OracleObjectInfo | undefined> {
    const p = t.parts.map((x, i) => dictName(x, t.quoted[i]));
    if (!p.length) return undefined;
    const alias = (t.aliases ?? []).find((a) => a.kind === "table" && sameIdent(a.alias, t.parts[0]));

    if (t.dbLink) {
      const link = t.dbLink.toUpperCase();
      if (!DB_LINK.test(link) || p.length > 2) return undefined;
      return objectInfo({ owner: p.length > 1 ? p[0] : "", name: p[p.length - 1], type: "REMOTE", dbLink: link }, signal);
    }
    if (p.length === 1) {
      if (alias) {
        const target = await resolveText(alias.table, alias.dbLink, signal);
        if (target) {
          const info = await objectInfo(target, signal);
          return sameIdent(alias.alias, alias.table) ? info : { ...info, alias: alias.alias };
        }
      }
      const r = await resolve(undefined, p[0], signal);
      if (r) return objectInfo(r, signal);
      if (await userExists(p[0], signal)) return { kind: "schema", name: p[0] };
      return undefined;
    }
    if (p.length === 2) {
      if (alias) {
        const target = await resolveText(alias.table, alias.dbLink, signal);
        return target && memberInfo(target, p[1], signal);
      }
      const parent = await resolve(undefined, p[0], signal);
      if (parent) return memberInfo(parent, p[1], signal);
      const inSchema = await resolve(p[0], p[1], signal);
      return inSchema && objectInfo(inSchema, signal);
    }
    if (p.length === 3) {
      const parent = await resolve(p[0], p[1], signal);
      return parent && memberInfo(parent, p[2], signal);
    }
    return undefined;
  }

  // ---------------------------------------------------------------- routing

  async function qualified(ctx: MetadataProviderContext, signal: AbortSignal): Promise<OracleMetadataItem[]> {
    const q = ctx.qualifier ?? [];
    const quoted = ctx.qualifierQuoted ?? [];
    const word = ctx.word ?? "";
    const last = q[q.length - 1];

    if (q.length === 1) {
      const alias: AliasInfo | undefined = (ctx.aliases ?? []).find((a) => sameIdent(a.alias, last));
      const wantsMembers = ctx.expectColumn || ctx.expectVariable || ctx.expectProcedure || ctx.expectFunction;
      if (alias && (wantsMembers || !ctx.expectTable)) {
        return alias.columns ? [] : columnsOfText(alias.table, alias.dbLink, signal);
      }

      const name = dictName(last, quoted[0]);
      if (ctx.expectTable && !ctx.expectColumn) {
        return (await userExists(name, signal)) ? objects(name, RELATION_TYPES, word, signal) : [];
      }
      const target = await resolve(undefined, name, signal);
      if (target) return membersOf(target, word, signal);
      if (await userExists(name, signal)) {
        const types = new Set<string>(["TABLE", "VIEW", "MATERIALIZED VIEW", "SYNONYM", "SEQUENCE", "PACKAGE", "FUNCTION"]);
        if (ctx.expectProcedure) types.add("PROCEDURE");
        if (ctx.expectType) types.add("TYPE");
        return objects(name, [...types], word, signal);
      }
      return [];
    }

    if (q.length === 2) {
      const target = await resolve(dictName(q[0], quoted[0]), dictName(q[1], quoted[1]), signal);
      return membersOf(target, word, signal);
    }
    return [];
  }

  async function unqualified(ctx: MetadataProviderContext, signal: AbortSignal): Promise<OracleMetadataItem[]> {
    const word = ctx.word ?? "";
    const tasks: Promise<OracleMetadataItem[]>[] = [];
    const schema = () => currentSchema(signal);

    if (ctx.expectTable) {
      tasks.push(safe(schema().then((o) => objects(o, RELATION_TYPES, word, signal))));
      tasks.push(safe(schemas(word, signal)));
      tasks.push(safe(publicSynonyms(word, signal)));
    }
    if (ctx.expectColumn) {
      for (const a of ctx.aliases ?? []) {
        if (a.columns || a.table.startsWith("(")) continue; // known locally / derived
        tasks.push(safe(columnsOfText(a.table, a.dbLink, signal)));
      }
    }
    const callable = new Set<string>();
    if (ctx.expectProcedure) ["PROCEDURE", "PACKAGE"].forEach((t) => callable.add(t));
    // Functions are valid in every expression: only list them once the user types.
    if (ctx.expectFunction && word) ["FUNCTION", "PACKAGE"].forEach((t) => callable.add(t));
    if (callable.size) tasks.push(safe(schema().then((o) => objects(o, [...callable], word, signal))));
    if (ctx.expectType) tasks.push(safe(schema().then((o) => objects(o, ["TYPE"], word, signal))));
    if (ctx.expectDbLink) {
      tasks.push(
        safe(
          schema().then((o) =>
            query(
              `SELECT db_link FROM all_db_links WHERE owner IN (:owner, 'PUBLIC') AND db_link LIKE :p ESCAPE '\\'
                ORDER BY db_link FETCH FIRST ${max} ROWS ONLY`,
              { owner: o, p: likePrefix(word) },
              signal,
            ).then((rows) => rows.map(([l]) => ({ label: String(l), kind: "dblink" as const, detail: "database link" }))),
          ),
        ),
      );
    }
    return (await Promise.all(tasks)).flat();
  }

  const provider = (async (ctx: MetadataProviderContext) => {
    controller?.abort();
    const round = new AbortController();
    controller = round;
    try {
      return (ctx.qualifier?.length ? await qualified(ctx, round.signal) : await unqualified(ctx, round.signal));
    } catch {
      return [];
    }
  }) as OracleMetadataProvider;

  provider.invalidate = () => {
    cache.clear();
    sessionSchema = null;
  };

  // Signature help and hover run outside completion rounds: their own controllers.
  let signatureRound: AbortController | null = null;
  provider.signatures = async (call) => {
    signatureRound?.abort();
    const round = (signatureRound = new AbortController());
    return signaturesFor(call, round.signal).catch(() => []);
  };

  let describeRound: AbortController | null = null;
  provider.describe = async (target) => {
    describeRound?.abort();
    const round = (describeRound = new AbortController());
    return describeTarget(target, round.signal).catch(() => undefined);
  };

  provider.prefetch = async () => {
    const signal = new AbortController().signal;
    await objects(await currentSchema(signal), RELATION_TYPES, "", signal).catch(() => []);
  };

  return provider;
}
