# Oracle Monaco SQL Editor — 설계 문서

> 상태: **v0.3** (Phase 0–4 구현 완료 · 인증: 사용자별 세션 · 지원 DB: 19c 이상) · 참조 구현: [`DataDynamics-OSS/trino-monaco-sql-editor`](https://github.com/DataDynamics-OSS/trino-monaco-sql-editor) (이하 *trino-monaco*)
>
> 목표: trino-monaco의 아키텍처(Monaco + React 컴포넌트, Monarch 토크나이저, ANTLR + antlr4-c3 워커 기반 문맥 자동완성, 메타데이터 프로바이더, 쿼리 러너)를 그대로 계승하면서, **Oracle SQL / PL/SQL** 의 언어적·운영적 차이를 반영한 `oracle-monaco` 컴포넌트를 설계한다.

---

## 1. 배경과 범위

### 1.1 trino-monaco에서 그대로 가져오는 것

| 영역 | trino-monaco 구현 | Oracle에서의 처리 |
|---|---|---|
| React 래퍼 | `TrinoEditor.tsx` (`@monaco-editor/react`) | **재사용** — props/액션 구조 동일, Oracle 전용 액션 추가 |
| 언어 등록 | `setup.ts` (1회 등록 + completion 재등록) | **재사용** — 언어 ID만 `oracle` |
| 테마/옵션 | `themes.ts`, `options.ts` | **재사용** — 토큰 규칙만 추가 (bind 변수, hint, PL/SQL 라벨) |
| 정적 자동완성 | `completion.ts` | **재사용** + Oracle 메타 kind 확장 |
| 워커 파이프라인 | `worker/*` (Comlink + antlr4ng + antlr4-c3) | **구조 재사용**, core 로직은 Oracle 규칙으로 재작성 |
| 메타데이터 프로바이더 | `metadata.ts` (`SHOW …` + TTL 캐시 + in-flight dedupe + abort) | **캐시/중복제거/abort 패턴 재사용**, 쿼리는 `ALL_*` 딕셔너리 뷰로 교체 |
| 연결/러너 | `connection.ts`, `runner.ts` (Trino REST `nextUri` 폴링) | **재설계** — Oracle은 브라우저에서 직접 접속 불가 → *Transport* 추상화 |
| 포매터 | `format.ts` (경량) | 재사용 + PL/SQL 블록 들여쓰기 대응 |
| 테스트 | `scripts/test-*.ts` (tsx, Node) | 동일 방식 유지 |

### 1.2 Oracle에서 새로 풀어야 하는 문제

1. **연결 방식**: Trino는 HTTP REST(`/v1/statement`)라 브라우저 → (프록시) → Trino 가 가능했지만, Oracle은 TNS(SQL*Net) 프로토콜이다. 브라우저에서 직접 붙을 수 없으므로 **반드시 서버 측 게이트웨이**(ORDS 또는 자체 백엔드)를 경유해야 한다.
2. **문장 구분**: `;`만으로 문장이 끝나지 않는다. PL/SQL 블록(`BEGIN … END;`, `CREATE OR REPLACE PACKAGE …`)은 내부에 `;`를 포함하며, SQL*Plus 관례상 **단독 라인의 `/`** 로 종결된다.
3. **어휘(lexical) 차이**: `q'[...]'` 대체 인용, `N'...'`, 바인드 변수(`:name`, `:1`), 치환 변수(`&var`, `&&var`), 옵티마이저 힌트(`/*+ ... */`), DB link(`@dblink`), `%TYPE`/`%ROWTYPE`, `=>`, `(+)` 외부조인, `<<label>>`.
4. **이름 해석**: 비인용 식별자는 **대문자로 정규화**되어 딕셔너리에 저장된다. `schema.object`, 시노님(private/public), `package.member`, `schema.package.member`, `object@dblink`, 시퀀스 `.NEXTVAL/.CURRVAL` 등 해석 경로가 Trino(`catalog.schema.table`)와 전혀 다르다.
5. **실행 UX**: Oracle 사용자(SQL Developer/Toad 사용자)의 기대치는 "Ctrl+Enter = **커서 위치의 문장 1개 실행**", "F5 = 스크립트 실행", DBMS_OUTPUT 출력, Explain Plan(DBMS_XPLAN) 이다.
6. **에러 위치**: `ORA-xxxxx` 에러는 SQL 내 오프셋(`offset`)을 제공하므로 이를 에디터 마커로 변환해야 한다. PL/SQL 컴파일 에러는 `ALL_ERRORS`에서 조회한다.

### 1.3 Non-goals (v1)

- 완전한 PL/SQL 문법 검증(Oracle 컴파일러 수준) — 서버 컴파일 결과로 대체.
- SQL*Plus 명령 전체(`COLUMN`, `BREAK`, `SPOOL` 등) 지원 — `SET SERVEROUTPUT`, `DEFINE`, `/`, `@`(무시) 정도만.
- 디버거, 세션 브라우저, 결과 그리드 UI(호스트 앱 책임; 데모 수준만 제공).

---

## 2. 전체 아키텍처

```
┌──────────────────────────── Browser ─────────────────────────────┐
│                                                                  │
│  <OracleEditor/> (React)                                         │
│   ├─ setupOracle(monaco)  ─ language / Monarch / themes          │
│   ├─ Actions: Run Statement · Run Script · Explain Plan ·        │
│   │           Prettify · Describe Object                          │
│   ├─ StatementSplitter (main thread, 경량 lexer)                  │
│   │                                                              │
│   ├─ Completion Provider ──Comlink──▶ completion.worker          │
│   │        │                          ├ OracleSqlLexer/Parser    │
│   │        │                          ├ antlr4-c3 core           │
│   │        │                          └ scope/alias/CTE 해석      │
│   │        ▼                                                     │
│   │   MetadataProvider (ALL_* 딕셔너리 + TTL 캐시)                 │
│   │        │                                                     │
│   └─ QueryRunner ─────────┐                                      │
│                           ▼                                      │
│                    OracleTransport (interface)                   │
└───────────────────────────┬──────────────────────────────────────┘
                            │ HTTPS (JSON)
          ┌─────────────────┴───────────────────┐
          ▼                                     ▼
  [A] ORDS REST-Enabled SQL            [B] oracle-monaco gateway
      POST /ords/{schema}/_/sql            (Node + node-oracledb Thin)
          │                                     │  커서 유지 / cancel(break)
          ▼                                     ▼  DBMS_OUTPUT / 오프셋 에러
                       Oracle Database (19c 이상: 19c / 21c / 23ai)
```

핵심 원칙:

- **브라우저 코드는 Oracle 드라이버를 모른다.** `OracleTransport` 인터페이스 하나에만 의존하고, ORDS/자체 게이트웨이/테스트용 mock을 주입한다. (trino-monaco의 `fetch` 주입 패턴의 일반화)
- **파싱은 워커에서, 문장 단위로.** Oracle 스크립트는 길어지기 쉬우므로 전체 문서가 아닌 *커서가 속한 문장*만 파싱한다 (trino-monaco 대비 성능 개선 포인트).
- **메타데이터는 대문자 정규화 규칙을 존중**하고, 삽입 시 사용자 케이스 선호(`identifierCase`)와 인용 필요 여부를 판단한다.

---

## 3. 레포 / 패키지 구조

레포가 분리되어 있으므로 trino-monaco를 **의존성으로 가져오지 않고 복사 후 개조(fork-and-adapt)** 한다. 다만 향후 공통 코어 추출을 쉽게 하기 위해 *방언 무관(dialect-agnostic)* 코드를 `src/core/`에 격리한다.

```
oracle-monaco-sql-editor/
  docs/
    DESIGN.md                 ← 본 문서
  src/
    index.ts                  공개 API
    OracleEditor.tsx          React 컴포넌트
    core/                     ── 방언 무관 (trino-monaco에서 거의 그대로 이식)
      editorActions.ts        selectedOrAll / prettifyEditor / 액션 등록 헬퍼
      completionItems.ts      matchCase, metadataKind, dedupe, sortText
      cache.ts                TTL 캐시 + in-flight dedupe + round abort
      markers.ts              GrammarError → IMarkerData 변환
    oracle/                   ── Oracle 방언
      language.ts             Monarch 토크나이저 + language configuration
      keywords.ts             예약어/키워드/내장함수/타입/의사컬럼/내장 패키지
      themes.ts               oracle-light / oracle-dark
      options.ts              DEFAULT_EDITOR_OPTIONS
      setup.ts                setupOracle()
      completion.ts           정적 completion provider (+ 타입 정의)
      splitter.ts             문장 분리기 (; 와 / 처리, PL/SQL 블록 인식)
      identifiers.ts          대문자 정규화 / 인용 판단 / 이름 분해
      format.ts               포매터 (PL/SQL 블록 들여쓰기)
      metadata.ts             createOracleMetadataProvider (ALL_* 뷰)
      runner.ts               createOracleQueryRunner (문장/스크립트 실행)
      explain.ts              EXPLAIN PLAN + DBMS_XPLAN
      transport/
        types.ts              OracleTransport 인터페이스
        ords.ts               createOrdsTransport  (REST-Enabled SQL)
        gateway.ts            createGatewayTransport (자체 백엔드 HTTP)
        mock.ts               테스트용 in-memory transport
    grammar/
      OracleSql.g4            완성용 축약 문법 (SQL + PL/SQL subset)
    generated/                antlr4ng 생성물 (npm run gen:parser)
    worker/
      protocol.ts             CaretContext 등 공유 타입
      completionCore.ts       파싱 + c3 + 스코프 해석 (순수 로직)
      completion.worker.ts    Comlink.expose
      client.ts               워커 생성/래핑
      contextProvider.ts      문맥 기반 Monaco completion provider
    App.tsx / main.tsx        데모
  servers/                    (선택) 게이트웨이 레퍼런스 구현 — 3개 모두 같은 HTTP API (§8.3, §16.4)
    server-node/              Fastify + node-oracledb Thin (src/gateway.ts)
    server-python/            FastAPI + python-oracledb Thin (oracle_monaco_gateway/)
    server-java/              Spring Boot 4 + ojdbc11 (com.datadynamics.oraclemonaco.gateway)
  scripts/
    gen-parser.mjs
    test-core.ts  test-splitter.ts  test-metadata.ts  test-runner.ts  test-live.ts
```

> **trino-monaco와의 동기화 정책**: `src/core/*`, `worker/client.ts`, `completion.worker.ts`, 테마/옵션 구조는 trino-monaco 변경을 수동으로 cherry-pick 한다. 공통 패키지(`@datadynamics/sql-monaco-core`) 추출은 Phase 4에서 검토했고 **보류**로 결정했다 (§16.3, ADR 10).

---

## 4. 언어 정의 (Monarch 토크나이저)

`oracle/language.ts` — Monaco SQL 정의(MIT) → trino-monaco 각색본을 출발점으로, 다음을 변경한다.

| 항목 | Trino | Oracle |
|---|---|---|
| 언어 ID | `trino` | `oracle` |
| 문자열 | `'...'` | `'...'`, `N'...'`, **`q'X...X'`** (구분자 `[]`, `{}`, `()`, `<>`, 임의 문자), `nq'...'` |
| 인용 식별자 | `"..."` | `"..."` (동일) |
| 주석 | `--`, `/* */` | 동일 + **`/*+ hint */`** → `annotation` 토큰(별도 색상) |
| 바인드 변수 | — | `:name`, `:1` → `variable` 토큰 |
| 치환 변수 | — | `&name`, `&&name` → `variable.substitution` |
| 대괄호 | `[]` 배열 | Oracle에 없음 → brackets에서 제거 (`()`만) |
| 연산자 | | `\|\|`, `=>`, `:=`, `**`, `(+)`, `..`(FOR 범위), `%` (`%TYPE`, `%ROWTYPE`, `%ROWCOUNT` 등 속성) |
| 식별자 문자 | `[\w@#$]` | `[A-Za-z][\w$#]*` + `@dblink` 분리 토큰화 |
| PL/SQL 라벨 | — | `<<label>>` → `tag` |
| 종결자 | `;` | `;` + **라인 단독 `/`** → `delimiter.terminator` |
| 의사 컬럼 | `$path` 등 | `ROWNUM`, `ROWID`, `LEVEL`, `SYSDATE`, `SYSTIMESTAMP`, `USER`, `UID`, `ORA_ROWSCN`, `CONNECT_BY_ISLEAF` … → `predefined` |

`q'` 문자열은 Monarch 상태 스택으로 구현한다: `q'[` 진입 시 닫는 구분자(`]'`)를 `@qstring.$1` 형태의 파라미터화 상태로 넘긴다 (`{ next: '@qstring.$S2' }` 패턴).

### 4.1 키워드 데이터 (`oracle/keywords.ts`)

trino-monaco와 같은 `LanguageElements` 형태에 Oracle 전용 필드를 추가한다.

```ts
export interface OracleLanguageElements {
  keywords: string[];          // SQL + PL/SQL 예약어/키워드 (V$RESERVED_WORDS 기준)
  functions: string[];         // 내장 SQL 함수 (NVL, DECODE, TO_CHAR, LISTAGG, JSON_VALUE …)
  operators: string[];         // AND, OR, NOT, LIKE, BETWEEN, IN, IS, PRIOR, MOD …
  types: string[];             // NUMBER, VARCHAR2, NVARCHAR2, DATE, TIMESTAMP WITH TIME ZONE, CLOB, BLOB, RAW, BOOLEAN(23ai) …
  pseudoColumns: string[];     // ROWNUM, ROWID, LEVEL, SYSDATE …
  builtinPackages: string[];   // DBMS_OUTPUT, DBMS_SQL, DBMS_LOB, DBMS_XPLAN, UTL_FILE …
  plsqlKeywords: string[];     // DECLARE, BEGIN, EXCEPTION, LOOP, PRAGMA, RAISE …
}
```

- 출처: Oracle SQL Language Reference / PL/SQL Language Reference (사실 데이터). `V$RESERVED_WORDS` 덤프로 생성 스크립트(`scripts/gen-keywords.ts`)를 두어 버전별 갱신을 자동화한다.
- **최소 지원 버전은 19c** 이다. 따라서 `FETCH FIRST/OFFSET`, `LISTAGG … ON OVERFLOW`, `JSON_*` 함수, 인라인 `WITH FUNCTION`, `APPROX_*` 등 12c~19c 구문은 항상 활성화하고, 11g/12c 호환 분기(`ROWNUM` 래핑 등)는 두지 않는다.
- `targetVersion: "19c" | "21c" | "23ai"` 옵션으로 23ai 신규 구문(`BOOLEAN`, `IF [NOT] EXISTS`, `SELECT` without `FROM`, `GROUP BY alias`)의 키워드/완성 노출을 제어한다.

---

## 5. 문장 분리기 (`oracle/splitter.ts`) — Oracle 전용 신규 컴포넌트

Run Statement, Run Script, Explain, 문장 단위 파싱, 검증 마커 모두가 의존하는 기반 모듈이다. **메인 스레드에서도 쓰이므로 ANTLR 없이** 경량 상태머신 lexer로 구현한다.

```ts
export interface SqlStatement {
  text: string;            // 종결자 제외한 실행 텍스트
  kind: "sql" | "plsql" | "sqlplus" | "empty";
  startOffset: number;     // 문서 내 절대 오프셋
  endOffset: number;
  startLine: number;       // 1-based (마커/하이라이트용)
  endLine: number;
  terminator: ";" | "/" | "eof";
}

export function splitStatements(text: string): SqlStatement[];
export function statementAt(text: string, offset: number): SqlStatement | undefined;
```

규칙:

1. 문자열(`'`, `q'`), 인용 식별자, 주석 내부의 `;` `/` 는 무시.
2. 문장 첫 키워드 기준으로 PL/SQL 모드 진입:
   `DECLARE`, `BEGIN`, `CREATE [OR REPLACE] [EDITIONABLE|NONEDITIONABLE] {PROCEDURE|FUNCTION|PACKAGE [BODY]|TRIGGER|TYPE [BODY]|LIBRARY}`, `WITH FUNCTION/PROCEDURE`(12c 인라인).
   PL/SQL 모드에서는 `;`로 끝나지 않고 **라인 단독 `/`** 또는 EOF까지가 한 문장.
3. 일반 SQL은 `;` 또는 라인 단독 `/` 에서 종결. 종결자 `;`는 실행 텍스트에서 제거 (Oracle은 SQL 끝의 `;`를 ORA-00933/00911로 거부), PL/SQL 블록의 마지막 `END;`의 `;`는 유지.
4. 빈 줄로 문장 구분하는 SQL Developer 관례는 옵션(`blankLineSeparates`, 기본 `false`)으로 제공.
5. SQL*Plus 명령(`SET SERVEROUTPUT ON`, `DEFINE x = 1`, `PROMPT`, `@file`, `EXEC proc`)은 `kind: "sqlplus"`. `EXEC x` 는 `BEGIN x; END;` 로 변환, `DEFINE`은 치환 변수 테이블 갱신, 나머지는 무시+경고.

치환 변수(`&var`)는 실행 직전에 `resolveSubstitutions(stmt, vars, prompt)` 로 치환하며, 미정의 변수는 호스트 콜백 `onSubstitutionPrompt` 로 값을 묻는다.

---

## 6. 문맥 자동완성 (ANTLR + antlr4-c3 워커)

### 6.1 문법 전략

| 옵션 | 장점 | 단점 | 결정 |
|---|---|---|---|
| grammars-v4 `PlSqlParser.g4` 전체 사용 | 커버리지 최대 | 수천 개 규칙 → c3 후보 수집이 느림(수백 ms), 생성 파서 수 MB, 라이선스 검토 필요 | ✗ |
| **축약 문법 직접 작성** (trino-monaco 방식) | 빠름, 선호 규칙을 원하는 위치에 정확히 배치 | 커버리지 수동 확장 | **✓ 채택** |

`grammar/OracleSql.g4` 는 trino-monaco의 `TrinoSql.g4` 구조(문장 → 쿼리 → 관계 → 표현식, `caseInsensitive = true`)를 따르되, 다음 범위를 커버한다.

- **Query**: `SELECT` (힌트, `DISTINCT/UNIQUE`), `WITH` (CTE, 인라인 `FUNCTION`), 집합연산(`UNION [ALL]`, `INTERSECT`, `MINUS`), 서브쿼리/인라인 뷰, `JOIN … ON/USING`, `(+)`, `CONNECT BY / START WITH / PRIOR`, `PIVOT/UNPIVOT`, `MODEL`(키워드 수준), `ORDER [SIBLINGS] BY`, `OFFSET … FETCH FIRST/NEXT`, `FOR UPDATE [OF] [NOWAIT|SKIP LOCKED]`, `AS OF` 플래시백, `SAMPLE`, `LATERAL`, `CROSS/OUTER APPLY`, `table@dblink`.
- **DML**: `INSERT` (단일/`INSERT ALL/FIRST`), `UPDATE`, `DELETE`, `MERGE`, `RETURNING … INTO`.
- **DDL/기타**: `CREATE/ALTER/DROP {TABLE|VIEW|INDEX|SEQUENCE|SYNONYM|MATERIALIZED VIEW}`, `TRUNCATE`, `COMMENT ON`, `GRANT/REVOKE`, `COMMIT/ROLLBACK/SAVEPOINT`, `EXPLAIN PLAN [SET STATEMENT_ID] FOR`, `ALTER SESSION SET`.
- **PL/SQL (부분)**: 익명 블록, `CREATE PROCEDURE/FUNCTION/PACKAGE [BODY]/TRIGGER` 헤더와 본문, 선언부(`x NUMBER := 1;`, `%TYPE`, `%ROWTYPE`, `CURSOR c IS`), 문장(대입, `IF/ELSIF`, `CASE`, `LOOP/WHILE/FOR … IN`, `FOR r IN (SELECT …)`, `EXIT WHEN`, `RETURN`, `RAISE`, 프로시저 호출, `EXECUTE IMMEDIATE`, `OPEN/FETCH/CLOSE`, 내장 SQL `SELECT … INTO`), `EXCEPTION WHEN … THEN`.
- **표현식**: 함수 호출(위치/이름 인자 `=>`), `CASE`, `CAST`, `DECODE`, 분석함수 `OVER (PARTITION BY … ORDER BY … ROWS …)`, `KEEP (DENSE_RANK …)`, `WITHIN GROUP`, `INTERVAL` / `DATE '…'` / `TIMESTAMP '…'` 리터럴, 바인드 변수, `seq.NEXTVAL`, `pkg.func(...)`.

### 6.2 선호 규칙 (preferred rules)

trino-monaco의 `tableRef` / `columnRef` / `functionName` 3종을 Oracle 이름 공간에 맞게 확장한다. 새 객체 이름(CREATE 대상, 컬럼 정의, 변수 선언)은 일반 `identifier`를 사용해 **기존 객체 제안을 막는다** (trino-monaco와 동일한 원칙).

| 규칙 | 등장 위치 예 | 제안 대상 |
|---|---|---|
| `tableRef` | `FROM`, `JOIN`, `INSERT INTO`, `UPDATE`, `DELETE FROM`, `MERGE INTO/USING`, `TRUNCATE TABLE`, `DROP TABLE`, `COMMENT ON TABLE` | 스키마, 테이블, 뷰, MV, 시노님 |
| `columnRef` | SELECT 목록, `WHERE`, `GROUP/ORDER BY`, `SET`, `ON`, `INSERT (cols)`, `%TYPE` 앞 | 컬럼, 별칭, PL/SQL 변수/파라미터 |
| `functionName` | 표현식 위치 | 내장 함수, 스키마 함수, 패키지 함수 |
| `procedureRef` *(신규)* | PL/SQL 문장 위치, `EXEC`, `CALL` | 프로시저, 패키지 프로시저 |
| `packageRef` *(신규)* | `pkg.` 앞 | 패키지(사용자 + 내장 `DBMS_*`) |
| `sequenceRef` *(신규)* | `.NEXTVAL/.CURRVAL` 앞 | 시퀀스 |
| `typeName` *(신규)* | 변수/컬럼 선언, `CAST AS` | 내장 타입 + 사용자 정의 타입(`ALL_TYPES`) |
| `dblinkRef` *(신규)* | `@` 뒤 | DB 링크 (`ALL_DB_LINKS`) |

### 6.3 CaretContext (프로토콜 확장)

```ts
export interface OracleCaretContext {
  keywords: string[];
  expectTable: boolean;
  expectColumn: boolean;
  expectFunction: boolean;
  expectProcedure: boolean;
  expectPackageMember: boolean;   // `pkg.|` 또는 `schema.pkg.|`
  expectSequence: boolean;
  expectType: boolean;
  expectDbLink: boolean;
  qualifier: string[];            // 원문 그대로 (`hr.` → ["hr"], `"Mixed".` → ["Mixed"] with quoted flag)
  qualifierQuoted: boolean[];     // 정규화 판단용
  partialWord: string;
  dbLink?: string;                // `emp@prod.|` 형태
  aliases: AliasInfo[];           // 테이블 별칭 + CTE + 인라인 뷰
  ctes: { name: string; columns?: string[] }[];   // WITH 절 이름(+명시적 컬럼 목록)
  plsqlScope?: {                  // PL/SQL 블록 내부일 때
    variables: { name: string; type?: string }[];
    parameters: { name: string; type?: string; mode?: "IN" | "OUT" | "IN OUT" }[];
    cursors: string[];
    loopRecords: { name: string; source: string }[];   // FOR r IN (SELECT …) / FOR r IN cur
  };
  statementKind: "sql" | "plsql";
}
```

### 6.4 completionCore 처리 흐름

```
getCaretContext(text, position)
  1. splitter.statementAt(text, offset)       ← 문장 단위로 잘라 파싱 비용 축소
  2. 문장 텍스트 + 상대 caret 오프셋으로 lex/parse (OracleSqlParser.root)
  3. caretTokenIndex 계산 (trino-monaco 로직 재사용, ID_TYPES에 바인드 변수 제외)
  4. CodeCompletionCore.collectCandidates → keywords + preferred rules
  5. analyzePrefix → partialWord, qualifier, dbLink (`IDENT @ IDENT .` 패턴 포함)
  6. collectScope(tree) → aliases(테이블 별칭/인라인 뷰), ctes, plsqlScope
     - 스코프는 caret을 포함하는 querySpecification 기준 + 상위 쿼리(상관 서브쿼리) 순으로 수집
  7. OracleCaretContext 반환
```

성능 목표: 문장 2,000 토큰 기준 `getCaretContext` p95 < 30ms (워커). 워커에 *마지막 문장 파싱 결과 캐시*(텍스트 해시 키)를 두어 연속 입력 시 재사용한다.

### 6.5 Monaco 제안 조합 (`contextProvider.ts`)

trino-monaco의 정렬 체계(`0-` 별칭 → `1-` 메타 → `2-` 함수 → `3-` 키워드)를 확장:

| sortText | 항목 |
|---|---|
| `0-` | 별칭, CTE 이름, PL/SQL 지역 변수/파라미터/레코드 |
| `1-` | 메타데이터(컬럼/테이블/시노님/패키지 멤버/시퀀스) |
| `2-` | 내장 함수(+ 스니펫 `NVL(${1:expr}, ${2:default})`), 내장 패키지 |
| `3-` | 문법상 유효한 키워드 |
| `4-` | 타입 |

추가 동작:
- **식별자 케이스**: `identifierCase: "upper" | "lower" | "preserve"` (기본 `preserve` → 사용자가 입력 중인 케이스를 따름, trino-monaco의 `matchCase`와 동일). 딕셔너리 이름이 비정규 이름(소문자 포함, 특수문자, 예약어)이면 **자동으로 `"..."` 인용**하여 삽입.
- **함수/프로시저 시그니처**: `ALL_ARGUMENTS` 기반 `SignatureHelpProvider` 등록 (`(` `,` 트리거) — 이름 인자 `=>` 스니펫 제공.
- **Hover**: 테이블/컬럼/패키지 멤버 위에 `HoverProvider` — 컬럼 타입, NULL 여부, 코멘트(`ALL_COL_COMMENTS`).

### 6.6 문법 검증 마커

- 클라이언트(워커) 검증: 축약 문법이므로 **오탐 위험**이 있다. 기본은 SQL 문장만 검증하고 PL/SQL 블록은 검증하지 않는다 (`validateOnType: "sql" | "all" | false`, 기본 `"sql"`).
- 서버 검증(옵션, `serverValidate`): 실행 없이 의미 검증이 필요하면 SELECT/DML에 한해 `EXPLAIN PLAN FOR <stmt>` 를 게이트웨이에서 실행해 `ORA-00942`, `ORA-00904` 등을 오프셋과 함께 마커로 표시. **DDL은 파싱 시점에 실행되므로 절대 서버 검증하지 않는다.**
- PL/SQL 컴파일 에러: `CREATE OR REPLACE …` 실행 후 `ALL_ERRORS`(LINE, POSITION, TEXT)를 조회하여 해당 문장의 시작 라인 기준으로 마커 매핑.

### 6.7 Phase 2 구현 메모 (설계 대비 변경점)

- **`sequenceRef` 선호 규칙은 두지 않았다.** `seq.NEXTVAL` 은 문법상 `x.y` 컬럼 참조와 구분되지 않으므로, `seq.` 위치는 qualifier 로 메타데이터 프로바이더에 넘기고 프로바이더가 시퀀스이면 `NEXTVAL`/`CURRVAL` 을 돌려준다 (7.2 표와 동일한 결과).
- **`packageRef`·`expectPackageMember` 는 별도 플래그 없이 qualifier 로 처리**한다 (`dbms_output.` → `qualifier: ["dbms_output"]` + `expectFunction`/`expectProcedure`).
- **`plsqlScope` 는 평탄한 `plsql: PlsqlSymbol[]`** 로 바꾸고, 레코드(커서 FOR 루프, `%ROWTYPE`, 트리거 `:NEW`/`:OLD`)는 `aliases` 에 `kind: "record"` 로 넣어 `r.` 이 별칭과 같은 경로로 해석되게 했다.
- **스코프는 문장 전체에서 수집**한다 (쿼리 블록별 가시성은 구분하지 않음). 같은 별칭이 여러 블록에 있으면 먼저 나온 것을 쓴다.
- 미완성 문장(`SELECT | FROM emp e`)은 오류 복구로 FROM 절이 사라질 수 있어, 커서 위치에 임시 식별자를 넣어 다시 파싱한 결과의 스코프를 사용한다.
- `nonReserved` (식별자로 쓸 수 있는 키워드)도 선호 규칙으로 등록해, 이름이 올 수 있는 모든 위치에 비예약 키워드가 쏟아지지 않게 했다.
- 렉서는 `q'[…]'`, `q'{…}'`, `q'(…)'`, `q'<…>'` 만 지원한다. `q'!…!'` 같은 임의 구분자는 ANTLR 렉서로 표현할 수 없어 검증 시 오류로 표시될 수 있다 (토크나이저·splitter·포매터는 지원).

---

## 7. 메타데이터 프로바이더 (`oracle/metadata.ts`)

### 7.1 인터페이스

trino-monaco의 `MetadataProvider` 시그니처를 유지하되 kind와 context를 확장한다.

```ts
export type OracleObjectKind =
  | "schema" | "table" | "view" | "materialized_view" | "synonym"
  | "column" | "sequence" | "package" | "procedure" | "function"
  | "type" | "dblink" | "variable";

export interface OracleMetadataItem {
  label: string;
  kind: OracleObjectKind;
  detail?: string;          // "VARCHAR2(100) · HR.EMPLOYEES"
  documentation?: string;   // 코멘트 (markdown)
  insertText?: string;      // 인용/케이스 처리된 삽입 텍스트
  owner?: string;
}

export type MetadataProvider = (
  ctx: OracleMetadataContext,   // OracleCaretContext + text/position/word
) => OracleMetadataItem[] | Promise<OracleMetadataItem[]>;
```

### 7.2 문맥 → 딕셔너리 쿼리 매핑

모든 쿼리는 **바인드 변수**를 사용한다(SQL 인젝션 방지 + 커서 공유). `currentSchema`는 `SYS_CONTEXT('USERENV','CURRENT_SCHEMA')` 를 연결 시 1회 조회하거나 호스트가 getter로 제공한다 (`ALTER SESSION SET CURRENT_SCHEMA` 반영 — trino-monaco의 catalog getter와 같은 패턴).

| Caret | 해석 | 쿼리 (요약) |
|---|---|---|
| `FROM \|` | 현재 스키마 객체 + 시노님 + 스키마 목록 | `ALL_OBJECTS WHERE OWNER=:cur AND OBJECT_TYPE IN ('TABLE','VIEW','MATERIALIZED VIEW','SYNONYM')` + `ALL_SYNONYMS WHERE OWNER='PUBLIC'`(prefix 필터) + `ALL_USERS` |
| `FROM hr.\|` | 스키마 `HR` 의 객체 | `ALL_OBJECTS WHERE OWNER=:owner …` |
| `FROM emp@prod.\|` | DB 링크 원격 객체 | `ALL_OBJECTS@prod` (옵션 `allowDbLinkMetadata`, 기본 off — 원격 비용) |
| `WHERE e.\|` (e → `hr.employees`) | 별칭 → 테이블 → 컬럼 | `ALL_TAB_COLUMNS WHERE OWNER=:o AND TABLE_NAME=:t ORDER BY COLUMN_ID` |
| `SELECT \| FROM a, b` | 스코프 내 모든 테이블 컬럼 | 위 쿼리를 테이블별 병렬 실행 (`safe()` 로 부분 실패 허용) |
| `WHERE x.\|` (x = CTE/인라인 뷰) | 메타 조회 없음 | CTE의 명시 컬럼 / 인라인 뷰 SELECT 목록(워커가 추출) |
| `dbms_output.\|` / `my_pkg.\|` | 패키지 멤버 | `ALL_PROCEDURES WHERE OWNER=:o AND OBJECT_NAME=:pkg` (+ `ALL_ARGUMENTS` 는 signature help 시 지연 조회) |
| `my_seq.\|` | 시퀀스 의사컬럼 | 정적: `NEXTVAL`, `CURRVAL` |
| `v_emp employees.\|` (`%TYPE` 앞) | 컬럼 | `ALL_TAB_COLUMNS` |
| 타입 위치 | 사용자 타입 | `ALL_TYPES WHERE OWNER IN (:cur, 'SYS')` (prefix 필터) |
| `@\|` | DB 링크 | `ALL_DB_LINKS` |

### 7.3 이름 해석 (`oracle/identifiers.ts`)

Oracle의 실제 해석 순서를 근사한다:

1. 한 단어 `x`: ① 현재 스키마 객체 → ② private 시노님 → ③ public 시노님.
2. 두 단어 `a.b`: ① `a` 가 스코프 별칭/CTE → 컬럼 ② `a` 가 스키마 → 객체 ③ `a` 가 현재 스키마의 패키지/테이블 → 멤버/컬럼.
3. 시노님은 `ALL_SYNONYMS (TABLE_OWNER, TABLE_NAME, DB_LINK)` 로 대상까지 1단계 추적(체인은 최대 3단계).
4. 비인용 식별자는 `toUpperCase()`, 인용 식별자는 그대로 비교.

```ts
export function normalizeIdent(raw: string): string;          // "Foo" → Foo, foo → FOO
export function needsQuoting(dictName: string, reserved: Set<string>): boolean;
export function renderIdent(dictName: string, typed: string, mode: IdentifierCase): string;
export function splitQualified(text: string): { parts: string[]; quoted: boolean[]; dbLink?: string };
```

### 7.4 캐시 정책

- trino-monaco의 `query()` (TTL 캐시 + in-flight dedupe + 라운드별 `AbortController`)를 `core/cache.ts` 로 추출해 재사용.
- 캐시 키 = `sql + JSON(binds)`.
- 객체 목록(`ALL_OBJECTS`)은 수만 건일 수 있으므로 **prefix 필터 + `FETCH FIRST :limit ROWS ONLY`** (기본 500) 로 제한하고, prefix 길이 0일 때는 현재 스키마만 조회.
- 선택적 **프리페치**: 연결 직후 현재 스키마의 테이블/뷰 이름만 백그라운드 로드(`prefetchCurrentSchema: true`).
- `invalidate(owner?, objectName?)` 공개 — DDL 실행 성공 시 러너가 자동 호출.

---

## 8. 연결 계층 — `OracleTransport`

### 8.1 인터페이스

브라우저/Node 공통. trino-monaco의 `TrinoConnectionOptions` + `statementPages` 를 대체한다.

```ts
export interface OracleTransport {
  /** 단일 문장 실행. SELECT면 첫 페이지까지, DML/DDL/PLSQL이면 완료까지. */
  execute(req: ExecuteRequest, signal?: AbortSignal): Promise<ExecuteResponse>;
  /** 열린 커서의 다음 페이지 (게이트웨이 전용; ORDS는 offset 재실행으로 에뮬레이션). */
  fetch?(cursorId: string, maxRows: number, signal?: AbortSignal): Promise<FetchResponse>;
  /** 커서 닫기. */
  close?(cursorId: string): Promise<void>;
  /** 실행 중 호출 취소 (게이트웨이: connection.break()). */
  cancel?(executionId: string): Promise<void>;
  /** 트랜잭션 제어 (세션 유지형 transport에서만). */
  commit?(): Promise<void>;
  rollback?(): Promise<void>;
  /** 세션 정보 (current schema, NLS, DB 버전). */
  session?(): Promise<OracleSessionInfo>;
}

export interface ExecuteRequest {
  sql: string;
  binds?: Record<string, BindValue> | BindValue[];
  kind?: "query" | "dml" | "ddl" | "plsql";   // splitter 결과 힌트
  maxRows?: number;                          // 페이지 크기 (기본 500)
  captureDbmsOutput?: boolean;
  executionId?: string;                      // cancel 대상 식별자 (클라이언트 생성 UUID)
}

export interface ExecuteResponse {
  columns?: OracleColumn[];          // { name, type, precision, scale, nullable }
  rows?: unknown[][];
  cursorId?: string;                 // 남은 행이 있으면
  rowsAffected?: number;
  outBinds?: Record<string, unknown>;
  dbmsOutput?: string[];
  warning?: OracleErrorInfo;         // 예: ORA-24344 컴파일 경고 성공
  elapsedMs?: number;
}

export interface OracleErrorInfo {
  code: string;            // "ORA-00942"
  message: string;
  offset?: number;         // 문장 내 0-based 문자 오프셋
}
```

### 8.2 구현체 A — ORDS REST-Enabled SQL (`transport/ords.ts`)

- `POST {baseUrl}/ords/{schemaAlias}/_/sql`, `Content-Type: application/json`, 본문 `{ statementText, binds, limit, offset }`.
- 응답 `items[]` 의 `resultSet.items`, `response`(DBMS_OUTPUT 포함), `errorCode/errorDetails` 를 `ExecuteResponse` 로 매핑.
- 장점: 별도 서버 개발 불필요. 단점: **무상태(stateless)** — 각 요청이 별개 세션이라 트랜잭션 유지·서버 측 커서·실제 취소가 불가. 페이지네이션은 `offset/limit` 재실행으로 에뮬레이션.
- 인증: Basic(스키마 계정) 또는 OAuth2 client credentials Bearer.

### 8.3 구현체 B — 자체 게이트웨이 (`transport/gateway.ts` + `servers/`) — **권장**

- 서버: Node + `node-oracledb` **Thin 모드** (Instant Client 불필요), Fastify. 같은 API·보안 모델의 Python(FastAPI + python-oracledb Thin)·Java(Spring Boot + ojdbc11 Thin) 구현도 제공한다 (§16.4). 클라이언트(`createGatewayTransport`)는 셋 중 무엇이든 그대로 쓴다.
- **사용자별 세션 (확정)**: 각 최종 사용자가 **자신의 Oracle 계정**으로 로그인하고, 게이트웨이 세션 1개 ↔ 전용 Oracle 커넥션 1개를 고정한다 → 트랜잭션·`ALTER SESSION`·패키지 상태 유지, DB 권한·감사(audit)가 사용자 단위로 그대로 적용된다.
  - 커넥션은 공유 풀이 아닌 `oracledb.getConnection({ user, password, connectString })` 독립 커넥션(또는 접속 대상별 `homogeneous: false` 이기종 풀)으로 생성한다.
  - 로그인 직후 `SELECT version_full FROM product_component_version` 로 버전을 확인하여 **19c 미만이면 접속 거부**(`ORACLE_VERSION_UNSUPPORTED`)하고, 버전·`CURRENT_SCHEMA`·NLS 설정을 세션 정보로 캐시한다.
  - idle timeout(기본 30분) 또는 로그아웃 시 미커밋 트랜잭션은 **rollback 후** 커넥션을 닫는다. 브라우저 탭마다 별도 세션을 허용할지(`maxSessionsPerUser`, 기본 3)는 서버 설정.
- 엔드포인트:

| Method | Path | 설명 |
|---|---|---|
| `POST` | `/api/sessions` | 로그인 `{ connectAlias, user, password }` → 버전 검증 후 세션 생성, `httpOnly; Secure; SameSite=Strict` 쿠키로 sessionId 발급 |
| `DELETE` | `/api/sessions/:id` | 로그아웃 (rollback + close) |
| `POST` | `/api/sessions/:id/execute` | `ExecuteRequest` → `ExecuteResponse` (`resultSet: true`, `fetchArraySize`) |
| `POST` | `/api/sessions/:id/cursors/:cid/fetch` | 다음 페이지 |
| `DELETE` | `/api/sessions/:id/cursors/:cid` | 커서 닫기 |
| `POST` | `/api/sessions/:id/cancel` | `connection.break()` |
| `POST` | `/api/sessions/:id/commit` · `/rollback` | 트랜잭션 |
| `GET` | `/api/sessions/:id` | 세션 정보 |

- DBMS_OUTPUT: 실행 전 `DBMS_OUTPUT.ENABLE(NULL)`, 실행 후 `DBMS_OUTPUT.GET_LINES(:lines, :n)` 루프.
- 에러: node-oracledb 에러의 `errorNum`, `offset` 을 `OracleErrorInfo` 로 그대로 전달.
- 보안:
  - 비밀번호는 로그인 요청 1회만 HTTPS로 전달되고 **브라우저 저장소(localStorage 등)·게이트웨이 디스크/로그에 남기지 않는다.** 이후 요청은 세션 쿠키만 사용. 비밀번호는 커넥션 생성 후 메모리에서 폐기(재접속 필요 시 재로그인).
  - 접속 대상 DB는 클라이언트가 임의 connect string을 보내지 못하도록 서버 설정의 `connectAlias` 화이트리스트로만 선택.
  - 로그인 실패 rate limit, 계정 잠금(ORA-28000)·비밀번호 만료(ORA-28001/28002) 메시지를 클라이언트에 구분 전달.
  - `callTimeout`, 최대 행 수, DDL 허용 여부(`allowDdl`) 정책은 서버에서 강제. DB 권한 자체는 사용자 계정 권한을 따른다.

### 8.4 구현체 C — Mock (`transport/mock.ts`)

`(sql, binds) => ExecuteResponse` 핸들러 맵. `test-metadata.ts`, `test-runner.ts`, 데모 오프라인 모드에서 사용 (trino-monaco의 mocked fetch 테스트를 대체).

---

## 9. 실행 계층 (`oracle/runner.ts`, `oracle/explain.ts`)

```ts
export interface OracleQueryRunner {
  /** 문장 1개 실행 (+ 스트리밍 페이지) */
  run(stmt: string | SqlStatement, opts?: RunOptions): Promise<StatementResult>;
  /** 스크립트 전체를 순차 실행 (문장별 결과/에러 수집, stopOnError 옵션) */
  runScript(script: string, opts?: RunScriptOptions): AsyncGenerator<StatementResult>;
  /** 다음 페이지 */
  fetchMore(result: StatementResult, maxRows?: number): Promise<unknown[][]>;
}

export interface RunOptions {
  signal?: AbortSignal;                      // abort → transport.cancel
  binds?: Record<string, BindValue>;
  onPage?: (page: { columns: OracleColumn[]; rows: unknown[][] }) => void;
  onBindPrompt?: (names: string[]) => Promise<Record<string, BindValue>>;
  onSubstitutionPrompt?: (name: string) => Promise<string>;
}

export class OracleQueryError extends Error {
  code: string;          // ORA-xxxxx
  offset?: number;       // 문장 내 오프셋
  statement?: SqlStatement;  // 문서 위치 복원용
}
```

동작:
- **바인드 변수 감지**: 실행 전 토크나이저로 `:name` 수집(문자열/주석/`:=`/`::`/PL/SQL 내부 블록 제외) → 값 미지정 시 `onBindPrompt`.
- **에러 → 마커**: `OracleQueryError.offset` + `statement.startOffset` → `model.getPositionAt()` 로 정확한 위치 마커(owner `oracle-exec`). 다음 실행 시 클리어.
- **DDL 후처리**: 성공 시 메타데이터 캐시 invalidate, PL/SQL 객체면 `ALL_ERRORS` 조회 → 컴파일 에러 마커.
- **Explain Plan**: `EXPLAIN PLAN SET STATEMENT_ID = :id FOR <stmt>` → `SELECT plan_table_output FROM TABLE(DBMS_XPLAN.DISPLAY('PLAN_TABLE', :id, 'TYPICAL'))` → 텍스트 반환 + `PLAN_TABLE` 행 정리. 옵션으로 `DBMS_XPLAN.DISPLAY_CURSOR`(실제 실행 계획, `GATHER_PLAN_STATISTICS` 힌트) 지원.

---

## 10. React 컴포넌트 (`OracleEditor.tsx`)

### 10.1 Props

trino-monaco `TrinoEditorProps` 와 호환되는 상위집합.

| Prop | Type | Default | 비고 |
|---|---|---|---|
| `value` / `defaultValue` / `onChange` | | | 동일 |
| `onRunStatement` | `(stmt: SqlStatement, editor) => void` | — | **Ctrl/Cmd+Enter** — 커서 위치 문장 (선택 영역 있으면 선택 영역) |
| `onRunScript` | `(stmts: SqlStatement[], editor) => void` | — | **F5** — 전체(또는 선택 영역) 스크립트 |
| `onExplainPlan` | `(stmt: SqlStatement, editor) => void` | — | **F10** / 컨텍스트 메뉴 |
| `onRunQuery` | `(sql, editor) => void` | — | trino-monaco 호환 alias (= onRunStatement의 text) |
| `onDescribe` | `(objectName, editor) => void` | — | **Shift+F4** — 커서 아래 객체 DESC |
| `theme` | `"light" \| "dark"` | `"light"` | |
| `readOnly` | `boolean` | `false` | |
| `languageElements` | `Partial<OracleLanguageElements>` | 내장 | |
| `metadataProvider` | `MetadataProvider` | — | |
| `formatter` | `Formatter` | 내장 | |
| `contextAware` | `boolean` | `false` | ANTLR/c3 워커 |
| `validateOnType` | `"sql" \| "all" \| false` | `"sql"` | |
| `targetVersion` | `"19c" \| "21c" \| "23ai"` | `"19c"` | 키워드/문법 게이팅 |
| `identifierCase` | `"upper" \| "lower" \| "preserve"` | `"preserve"` | 완성 삽입 케이스 |
| `keywordCase` | `"upper" \| "lower" \| "preserve"` | `"preserve"` | |
| `highlightCurrentStatement` | `boolean` | `true` | 커서 문장 배경 데코레이션 |
| `statementSeparator` | `{ blankLine?: boolean }` | `{}` | splitter 옵션 |
| `markers` | `OracleQueryError[]` | — | 호스트가 실행 에러를 넘기면 마커 표시 |
| `options` / `height` / `width` / `className` / `onMount` | | | 동일 |

### 10.2 액션 / 키바인딩

| 액션 ID | 라벨 | 키 | 비고 |
|---|---|---|---|
| `oracle.run-statement` | Run Statement | `Ctrl/Cmd+Enter` | splitter.statementAt |
| `oracle.run-script` | Run Script | `F5` | |
| `oracle.explain-plan` | Explain Plan | `F10` | |
| `oracle.describe` | Describe | `Shift+F4` | |
| `oracle.prettify` | Prettify | `Shift+Alt+F` | trino-monaco와 동일 |
| `oracle.toggle-case` | Toggle Case | `Ctrl+'` | 선택 영역 대/소문자 (SQL Developer 관례) |

`highlightCurrentStatement`: 커서 이동 시 `statementAt` 결과 라인 범위에 `deltaDecorations`(옅은 배경 + gutter 바). 디바운스 50ms.

### 10.3 생명주기

trino-monaco의 패턴을 그대로 따른다: `handlers` ref로 최신 콜백 유지, `stableMetadata` 델리게이터로 completion provider를 한 번만 등록, 언마운트 시 워커/프로바이더/리스너 dispose. 추가로 SignatureHelp/Hover provider와 statement 하이라이트 리스너를 같은 dispose 목록에 넣는다.

> trino-monaco 개선 사항 반영: `setupTrino` 의 모듈 전역 `completionDisposable` 은 **여러 에디터 인스턴스가 서로 다른 metadataProvider를 쓸 때 마지막 것만 남는 문제**가 있다. Oracle 버전은 completion provider를 *모델 URI → 인스턴스 핸들러* 맵으로 라우팅하는 단일 provider로 등록해 멀티 에디터(탭) 환경을 지원한다.

---

## 11. 포매터 (`oracle/format.ts`)

- 기본: trino-monaco 경량 포매터를 확장 — 절 키워드 줄바꿈에 `CONNECT BY`, `START WITH`, `MINUS`, `PIVOT`, `FETCH FIRST`, `MERGE INTO`, `WHEN MATCHED` 추가, `q'…'` 문자열 보존.
- PL/SQL: `BEGIN/DECLARE/IS/AS … END`, `IF/LOOP/CASE` 블록 깊이 기반 들여쓰기만 수행 (안전 우선, 토큰 재배치 없음).
- 교체 가능: `formatter` prop (예: 서버 측 SQLcl `format` 또는 `sql-formatter` 의 `plsql` 방언 위임).

---

## 12. 공개 API (`src/index.ts`)

```ts
export { OracleEditor, default } from "./OracleEditor";
export { setupOracle } from "./oracle/setup";
export { ORACLE_LANGUAGE_ID, oracleLanguage, oracleLanguageConf } from "./oracle/language";
export { ORACLE_LIGHT_THEME, ORACLE_DARK_THEME } from "./oracle/themes";
export { DEFAULT_EDITOR_OPTIONS } from "./oracle/options";
export { DEFAULT_LANGUAGE_ELEMENTS, ORACLE_KEYWORDS, ORACLE_FUNCTIONS, ORACLE_TYPES,
         ORACLE_PSEUDO_COLUMNS, ORACLE_BUILTIN_PACKAGES, resolveLanguageElements } from "./oracle/keywords";
export { splitStatements, statementAt } from "./oracle/splitter";
export { formatOracleSql } from "./oracle/format";
export { createOracleCompletionProvider } from "./oracle/completion";
export { createOracleMetadataProvider } from "./oracle/metadata";
export { createOracleQueryRunner, OracleQueryError } from "./oracle/runner";
export { explainPlan } from "./oracle/explain";
export { createOrdsTransport } from "./oracle/transport/ords";
export { createGatewayTransport } from "./oracle/transport/gateway";
export { createMockTransport } from "./oracle/transport/mock";
export { createCompletionWorker } from "./worker/client";
export { createContextAwareCompletionProvider } from "./worker/contextProvider";
// + 모든 타입
```

사용 예:

```tsx
import { OracleEditor, createGatewayTransport, createOracleMetadataProvider,
         createOracleQueryRunner } from "oracle-monaco";

const transport = createGatewayTransport({ baseUrl: "/api", sessionId });
const metadata  = createOracleMetadataProvider({ transport, currentSchema: () => session.schema });
const runner    = createOracleQueryRunner({ transport });

<OracleEditor
  contextAware
  targetVersion="19c"
  metadataProvider={metadata}
  onRunStatement={async (stmt) => {
    try { render(await runner.run(stmt, { onPage: appendRows })); }
    catch (e) { if (e instanceof OracleQueryError) setMarkers([e]); }
  }}
  onRunScript={async (stmts) => { for await (const r of runner.runScript(stmts)) log(r); }}
  onExplainPlan={async (stmt) => showPlan(await explainPlan(transport, stmt))}
/>;
```

---

## 13. 빌드 / 의존성

trino-monaco와 동일한 툴체인을 유지한다.

- 런타임: `@monaco-editor/react`, `monaco-editor`, `antlr4ng`, `antlr4-c3`, `comlink`
- 개발: `vite` (+ `vite-plugin-dts`), `typescript`, `tsx`, `antlr4ng-cli`
- 게이트웨이: `servers/server-node/package.json` — `fastify`, `oracledb` (Thin) · `servers/server-python/pyproject.toml` — `fastapi`, `uvicorn`, `oracledb` (Thin) · `servers/server-java/pom.xml` — Spring Boot 4 `spring-boot-starter-webmvc`, `ojdbc11`
- 라이브러리 빌드: `vite build` → `dist/oracle-monaco.js` (ES), 워커는 `worker: { format: "es" }`
- 데모: `vite --mode demo`, `/api` 프록시 → 게이트웨이(`VITE_ORACLE_GATEWAY`)
- 패키지명: `@datadynamics/oracle-monaco` (MIT, `package.json` 은 `private: true` 로 npm 배포 없음)

---

## 14. 테스트 전략

| 스크립트 | 대상 | 예시 |
|---|---|---|
| `test:splitter` | 문장 분리 | `;` in `q'[a;b]'`, PL/SQL 블록 + `/`, `CREATE PACKAGE BODY` 내 다중 `END;`, 23ai `WITH FUNCTION`, SQL*Plus 명령 |
| `test:core` | caret 문맥 (trino-monaco `test-core.ts` 형식, `\|` 캐럿 표기) | `SELECT * FROM \|` → table, `FROM hr.\|` → qualifier `["hr"]`, `WHERE e.\|` → alias, `emp@prod.\|`, `dbms_output.\|` → package member, `seq.\|`, `v employees.salary%\|`, `FOR r IN (SELECT * FROM t) LOOP r.\|`, `CONNECT BY PRIOR \|`, `MERGE INTO t USING s ON (\|)` |
| `test:identifiers` | 정규화/인용 | `foo`→`FOO`, `"Foo"`→`Foo`, 예약어 컬럼 `"DATE"` 인용 삽입 |
| `test:metadata` | 딕셔너리 쿼리 라우팅, 캐시, abort, 시노님 해석 | mock transport |
| `test:runner` | 페이지네이션, cancel, ORA 오프셋 → 위치, DBMS_OUTPUT, 바인드 프롬프트 | mock transport |
| `test:docs` | 내장 도움말 | 함수·패키지·타입 전수 커버리지, 문맥별 예약어 토픽, 버전별 링크, 호버 통합 |
| `test:gateway` · `pytest` · `mvn test` | 게이트웨이 3종 (가짜 드라이버, DB 불필요) | 로그인·쿠키 인증·rate limit·19c 거부, 커서 페이징, ORA 오류 → 422 + offset, 끊긴 연결 → `SESSION_LOST`, DDL 차단, idle sweep — 같은 시나리오를 언어별로 이식 |
| `test:live` | 실 DB E2E (opt-in, 게이트웨이 3종 공통) | `ORACLE_GATEWAY_URL`, 또는 `gvenzl/oracle-free` 컨테이너 |
| 성능 벤치 | `getCaretContext` p95 | 2,000 토큰 문장, 500줄 패키지 바디 |

CI: `typecheck` + `test`(Node) 필수, `test:live` 는 Oracle Free 컨테이너가 있는 러너에서 nightly.

---

## 15. 단계별 로드맵

| Phase | 범위 | 산출물 |
|---|---|---|
| **0. Scaffold** ✅ | trino-monaco 복사 → 이름 변경, `core/` 분리, 빌드/데모 동작 | Monarch(Oracle, `q'`/바인드/힌트/`/` 포함) + 정적 완성 + 테마 + 에디터별 completion 라우팅 + scanner 기반 포매터 |
| **1. Language** ✅ | 토크나이저(`q'`, 바인드, 힌트, `/`), 키워드 데이터, **splitter**(+ SQL*Plus 명령, 치환/바인드 변수), PL/SQL 들여쓰기 포매터, 문장 단위 액션(Run Statement/Script, Explain, Describe, Toggle Case), 현재 문장 하이라이트 | `test:splitter` |
| **2. Context completion** ✅ | `OracleSql.g4` (SQL + PL/SQL 서브셋) → c3 → alias/CTE/인라인 뷰/PL/SQL 스코프 → 워커 provider + 검증 마커 | `test:core` 91건, `test:grammar` 69건 |
| **3. Connectivity** ✅ | Transport 인터페이스, mock, gateway 서버, ORDS 어댑터, 메타데이터 프로바이더, 러너, Explain, 에러 마커 | `test:runner` 36, `test:metadata` 31, gateway 38, `test:live` 39 + `test:live:ords` 14 (Oracle 23ai Free / ORDS 26.3 에서 검증) |
| **4. Polish** ✅ | SignatureHelp/Hover, 이름 인자 완성, 서버 검증(EXPLAIN PLAN), 시노님/DB 링크 해석 확장, 23ai 게이팅, 멀티 에디터 라우팅(completion·signature·hover), 공통 코어 추출 검토 | `test:signature` 117, `test:core` 109 (게이팅 포함), 데모 브라우저 스모크 |

---

## 16. 주요 결정 사항 요약 (ADR)

| # | 결정 | 근거 |
|---|---|---|
| 1 | trino-monaco를 의존성이 아닌 **복사·개조**로 시작, `core/` 격리 | 레포 분리 요구, 방언 차이가 커서 공통 추상화를 먼저 만들면 과설계 |
| 2 | **축약 문법 직접 작성**, grammars-v4 PL/SQL 미사용 | c3 성능, 번들 크기, 선호 규칙 제어 |
| 3 | **문장 단위 파싱** | Oracle 스크립트 길이, PL/SQL 패키지 바디 대응 |
| 4 | 연결은 **Transport 추상화**, 권장 구현은 **node-oracledb Thin 게이트웨이** | 브라우저 직접 접속 불가, 세션/트랜잭션/취소/DBMS_OUTPUT 필요 |
| 5 | Ctrl+Enter = **커서 문장 실행** (Trino는 전체 실행) | Oracle 툴 사용자 기대치 |
| 6 | 서버 검증은 SELECT/DML의 `EXPLAIN PLAN` 한정 | DDL은 파싱 시 실행됨 |
| 7 | 메타 조회는 항상 바인드 변수 + 행 수 제한 | 보안 + 대형 딕셔너리 |
| 8 | 인증은 **사용자별 Oracle 계정 세션** (게이트웨이 세션 ↔ 전용 커넥션 1:1) | DB 권한·감사를 사용자 단위로 유지, 트랜잭션/세션 상태 보존 |
| 9 | 최소 지원 버전 **Oracle 19c** (로그인 시 검증) | 19c가 현 LTS. `FETCH FIRST`·JSON 함수 등 12c+ 구문 전제, 하위 호환 분기 제거 |
| 10 | 공통 코어 패키지 추출 **보류**, `src/core/` 는 방언·Oracle 의존 없이 유지 | 공유 코드가 225줄뿐이고 trino-monaco 는 아직 모델 라우터·signature/hover 를 쓰지 않음. 두 레포 간 릴리스 결합 비용이 이득보다 큼 (§16.3) |
| 11 | 버전 게이팅은 **단일 문법 + 사후 검사** | 버전별 문법/파서를 따로 생성하면 번들·유지보수 비용이 배가. c3 후보 필터 + 파스 트리 검사로 충분 |
| 12 | 게이트웨이는 **Node · Python · Java 3종**, 같은 HTTP API·보안 모델·환경변수 | 운영 환경의 스택(Node / Python / Java 서비스)에 맞춰 배포. 각 구현은 드라이버 계층을 인터페이스로 분리해 가짜 드라이버로 같은 테스트 시나리오를 돌린다 (§16.4) |

## 16.1 Phase 3 구현 메모 (설계 대비 변경점)

- Transport의 `fetch` → **`fetchRows`** (전역 `fetch` 와 혼동 방지), `close` → `closeCursor`. `ExecuteRequest.kind` → `category` (`query|dml|ddl|plsql|tcl|other`). **`stateless`** 플래그 추가 (ORDS).
- 게이트웨이 인증: 세션 id 는 URL 에 있지만 **동일 값의 httpOnly 쿠키가 있어야** 인정. CLI·테스트용 `X-Session-Id` 헤더는 `allowHeaderAuth` 로만 허용.
- 게이트웨이 값 형식: NUMBER 는 정밀도 보존을 위해 **문자열**, DATE/TIMESTAMP 는 `YYYY-MM-DD HH24:MI:SS[.FFF]` (Thin 드라이버의 `fetchAsString` DATE 는 NLS 형식이 아니라 JS `Date.toString()` 이 되어 직접 포맷), RAW/BLOB 은 hex. ORDS 결과도 같은 형식으로 정규화.
- DBMS_OUTPUT: 게이트웨이는 `GET_LINES` 배열 바인드(반환 개수 `n` 으로 자름), ORDS 는 `SET SERVEROUTPUT ON` 을 앞에 붙이고 응답의 `dbmsOutput` 필드 사용.
- PL/SQL 컴파일 오류: 드라이버 경고(NJS-700/ORA-24344)에 의존하지 않고 **PL/SQL 단위 CREATE 후 항상 `ALL_ERRORS` 조회** (ORDS 는 경고를 주지 않음). 트리거는 오류 줄 번호가 PL/SQL 블록 기준이라 블록 시작 위치로 환산.
- Explain: node-oracledb 는 미바인드 플레이스홀더를 거부(NJS-098)하므로 **각 바인드에 NULL** 을 넣는다 (계획에는 영향 없음). PLAN_TABLE 은 세션 전용이라 ORDS 에서는 EXPLAIN 과 DISPLAY 를 **한 요청**으로 보낸다.
- 서버 검증(`serverValidate`, 6.6)과 SignatureHelp/Hover(6.5)는 Phase 4 로 이동.
- ORDS 어댑터 제약: 트랜잭션 유지 불가(요청마다 커밋), 페이징은 offset 재실행(일관 스냅샷 아님), 취소는 HTTP 중단뿐.

## 16.2 Phase 4 구현 메모 (설계 대비 변경점)

- **SignatureHelp (6.5)**: 호출 위치 분석은 워커가 아니라 메인 스레드의 스캐너 기반 `callAt()` 으로 한다 (문자열·주석 안의 `(` `,` 무시, `;` 를 넘지 않음, `IN (`·`VALUES (`·`INSERT INTO t (`·`CREATE TABLE t (`·`CAST(x AS VARCHAR2(` 는 호출이 아님). 파서를 거치지 않아 미완성 문장에서도 안정적이고 워커 없이(`contextAware=false`) 동작한다.
  - 내장 SQL 함수 85개는 정적 표(`BUILTIN_SIGNATURES`)로 제공, `DECODE`(search/result 쌍)·`COALESCE` 등 반복 인자는 `repeat` 범위로 표현.
  - 사용자 루틴은 메타데이터 프로바이더의 `signatures(call)` — `ALL_ARGUMENTS (DATA_LEVEL = 0)` 를 오버로드별로 묶는다. POSITION 0 = 반환 타입, `IN/OUT` → `IN OUT`, `DEFAULTED='Y'` → 선택 인자, 레코드/객체 타입은 `TYPE_OWNER.TYPE_NAME.TYPE_SUBNAME`. 18c+ 에서 파라미터 없는 패키지 프로시저는 `ALL_ARGUMENTS` 행이 없으므로 `ALL_PROCEDURES` 로 존재를 확인한다.
  - 해석 경로: `f` → 현재 스키마/시노님의 FUNCTION·PROCEDURE, `a.f` → `a` 가 패키지(시노님 경유 포함, 예: `dbms_output` → `SYS.DBMS_OUTPUT`)면 멤버, 아니면 스키마 `a` 의 독립 루틴, `s.p.f` → 스키마 `s` 패키지 `p`. DB 링크 경유 호출은 조회하지 않는다.
  - 활성 오버로드: 이미 쓴 이름 인자를 모두 가진 것 중 인자 수를 수용하는 첫 오버로드. 이름 인자(`p => |`) 위치면 해당 파라미터를 강조.
- **이름 인자 완성**: 인자 시작 위치(빈 인자 또는 부분 단어)에서 `p_name =>` 항목을 `0-` 정렬로 추가. 위치 인자가 소비한 앞쪽 파라미터와 이미 이름으로 넘긴 파라미터는 제외. 내장 함수는 위치 표기만 가능하므로 제공하지 않는다. 정적/문맥 completion provider 모두 지원.
- **Hover (6.5)**: `MetadataProvider` 에 선택 속성 `describe(target)` 추가 (`createOracleMetadataProvider` 가 구현). 커서가 있는 **부분까지의 접두 이름**을 넘긴다 (`hr.emp.sal` 에서 `emp` 위면 `["hr","emp"]`). 별칭은 워커의 `aliases` 로 테이블에 매핑되며, 테이블 코멘트(`ALL_TAB_COMMENTS`), 컬럼(타입·NOT NULL·`ALL_COL_COMMENTS`), 상태(`INVALID` 강조), 시노님 경유(`via`), 패키지 멤버, 시퀀스 설정(`ALL_SEQUENCES`) 을 Markdown 으로 렌더링한다. PL/SQL 변수·CTE·인라인 뷰·레코드, 내장 함수(뒤에 `(` 가 있을 때만)와 의사 컬럼은 메타데이터 없이 응답.
- **시노님 / DB 링크**: `resolve()` 가 첫 시노님을 `via` 로 기록 (호버 표시). 시노님 → 원격 객체(`DB_LINK`) 는 `dbLinkMetadata: true` 일 때 `ALL_TAB_COLUMNS@link` 로 컬럼까지 조회, `name@link` 호버도 같은 경로. 링크 이름은 정규식으로 검증 후에만 SQL 에 삽입.
- **서버 검증 (6.6)**: 에디터 prop 이 `serverValidate: boolean` 이 아니라 **`serverValidator` 함수**다 — 에디터는 transport 를 모르므로 `createServerValidator({ transport, substitutionVariables, paused })` 를 호스트가 만든다.
  - 대상: `kind === "sql"` 이고 첫 단어가 SELECT/WITH/INSERT/UPDATE/DELETE/MERGE 인 문장만. DDL·PL/SQL·`ALTER SESSION`·SQL*Plus 명령은 전송하지 않는다 (테스트로 고정).
  - 결과 3상태: 이슈 / `null`(통과) / `undefined`(검사 안 함: 대상 아님, 미정의 `&var`, `paused`, 환경 오류 ORA-01039·02402~02404·01013·03113·03114·03135, 비 ORA 코드). `undefined` 는 캐시하지 않는다.
  - ORA 오프셋은 `EXPLAIN PLAN SET STATEMENT_ID = '…' FOR ` 접두 길이만큼 빼고, 치환 변수가 있으면 원문 오프셋으로 환산한다.
  - 에디터: 문장 텍스트 → 결과 LRU 캐시(500), 입력 정지 후(`serverValidateDelay`, 기본 1200ms) 미검사 문장만 순차 검증, 편집 시 진행 중 라운드 abort. 같은 줄에 클라이언트 문법 오류가 있는 문장은 건너뛴다. 마커 owner `oracle-server`.
  - 주의: EXPLAIN PLAN 은 세션 전용 PLAN_TABLE(GTT) 에 행을 넣으므로 게이트웨이 세션에서 트랜잭션을 시작한다 (직후 DELETE, 사용자 데이터에는 영향 없음). 같은 커넥션이라 긴 실행 중에는 줄을 선다 → `paused` 또는 검증 전용 세션.
- **23ai 게이팅**: 문법은 하나(23ai 구문 포함)로 유지하고 워커에서 걸러낸다 (`worker/versionGate.ts`).
  - 완성: `ORACLE_VERSIONED_KEYWORDS` 의 상위 버전 키워드 제거. `IF` 는 c3 후보의 후속 토큰이 `NOT`/`EXISTS` 일 때만 제거(PL/SQL `IF` 문은 유지).
  - 검증: 구문 오류가 없는 문장에 한해 `IF [NOT] EXISTS`, `FROM` 없는 `SELECT`(서브쿼리 포함), SQL 문장의 `BOOLEAN` 타입·`TRUE`/`FALSE` 리터럴을 **경고**로 표시 (`GrammarError.severity = "warning"`). PL/SQL 의 BOOLEAN 은 원래 유효하므로 제외. `GROUP BY` 별칭/위치 같은 의미 수준 23ai 기능은 감지하지 않는다.
  - `getCaretContext(text, pos, { version })`, `validateGrammar(text, mode, version)` — 버전 미지정이면 이전과 동일(필터 없음).
- **멀티 에디터 라우팅**: `core/completionRouter.ts` 를 제네릭 `createModelRouter<P>` 로 일반화하고 completion / signature help / hover 라우터를 언어당 1회 등록. `setupOracle()` 은 `OracleRouters`(= completion 라우터 + `.signatureHelp` + `.hover`)를 반환해 기존 반환 타입과 호환된다. 각 `<OracleEditor>` 는 자기 모델 URI 에 세 provider 를 붙이고, `signatureHelp={false}` / `hover={false}` 면 빈 provider 를 붙여 폴백도 막는다.

- **내장 도움말 (`oracle/docs.ts`)**: `Shift+F1` 액션과 `Ctrl/Cmd+Click` 은 `editor.action.showHover` 를 띄운다. 별도 패널 없이 기존 hover provider 를 재사용하고, `hover={false}` 여도 2초 안의 도움말 요청에는 응답한다.
  - 조회 순서: `%` 뒤(`%TYPE`/`%ROWTYPE`) → `(` 가 따르면 함수 → 의사 컬럼 → 패키지 → 예약어 토픽 → 타입 → 괄호 없는 함수(`CURRENT_DATE` 등). `OR REPLACE` 의 `REPLACE` 는 함수가 아니므로 빈 결과.
  - 예약어는 뒤 단어 4개 + PL/SQL 여부로 토픽을 고른다 (`CREATE [OR REPLACE] [EDITIONABLE] PACKAGE BODY`, `FETCH c INTO` vs `FETCH FIRST`, `FOR i IN` vs `FOR UPDATE`, `NULL;` vs `NULL`, `IF` vs 23ai `IF NOT EXISTS`, `NATURAL JOIN` vs `NATURAL` 서브타입).
  - 함수 구문은 `signatures.ts` 표에서 생성하고 예제·특수 구문(`CAST`, `TRIM`, `EXTRACT`, `JSON_*`)만 덮어쓴다.
  - 링크: `docs.oracle.com/en/database/oracle/oracle-database/{19|21|26}/{sqlrf|lnpls|arpls}/{page}.html` 형식이며, 버전은 `targetVersion` 을 따른다 (23ai 는 `/26/` 경로를 쓴다. `/23/` 은 `/26/` 으로 리다이렉트만 하고 일부 페이지에서는 루프가 생긴다). `npm run check:doc-links` 로 전 페이지 × 3 버전을 확인할 수 있다. 네트워크가 필요하고 docs.oracle.com 이 403 으로 스로틀하므로 `npm test` 에는 포함하지 않는다.
  - 키워드는 딕셔너리(`describe`)를 조회하지 않는다. 테이블/컬럼 이름과 겹치지 않는 예약어에만 도움말을 우선 적용한다.

- **다국어 (`oracle/i18n/`)**: `locale` prop 으로 en / ko / ja / zh 를 고른다.
  - 번역 대상: 액션 라벨, 호버·객체 정보, 도움말의 제목·설명, 내장 함수 시그니처 설명, 워커가 내는 구문·버전 메시지.
  - 구문 메시지는 워커가 영어로 만들고, 메인 스레드의 `localizeMessage` 가 패턴을 맞춰 번역한다. 그래서 워커 프로토콜은 바뀌지 않는다.
  - 도움말 번역은 `OracleDocEntry.id`(`fn:NVL`, `topic:CONNECT_BY` …)를 키로 쓰고, 빠진 항목은 영어로 대체한다. `test:docs` 가 세 언어 모두 전 항목을 번역했는지, 백틱 코드 구간이 그대로인지 확인한다.
  - 번역하지 않는 것: SQL·구문·예제, ORA 오류, SQL*Plus 형식 피드백, Monaco 기본 메뉴(잘라내기 등). 매뉴얼 링크는 영어판으로 연결한다.
  - `locale` 이 바뀌면 액션을 다시 등록해 라벨을 갱신하고, 문장도 다시 검증한다.

## 16.3 공통 코어 추출 검토 (Phase 4 결론: 보류)

| 항목 | 현황 |
|---|---|
| `src/core/` 규모 | 5파일 225줄: `cache.ts`(TTL+in-flight+abort), `completionItems.ts`(applyCase/dedupe), `completionRouter.ts`(모델별 라우터), `editorActions.ts`(prettify), `styles.ts` |
| 의존성 | `monaco-editor` **타입**만 import. `oracle/`·`worker/` 의존 없음 (Phase 4 에서 확인) |
| trino-monaco 차이 | trino-monaco 는 전역 `completionDisposable`(마지막 에디터만 남는 문제) 그대로이고 signature/hover 가 없다. 즉 공유 가능한 코드 중 절반 이상이 아직 한쪽에서만 쓰인다 |
| 방언 결합 코드 | 워커 파이프라인(`completionCore`)·contextProvider·splitter·metadata 는 문법/딕셔너리에 강결합 → 추출 대상 아님 |

결정: 지금은 패키지로 추출하지 않는다.

- 이득: 225줄 중복 제거 정도. 비용: trino-monaco 와 oracle-monaco 두 레포 간 공통 패키지 버전·릴리스 결합, 레포 간 코드 이동 시 조율 비용.
- 대신 (1) `core/` 는 계속 방언 무관·Oracle 무의존으로 유지하고, (2) `completionRouter.ts`(모델별 라우팅)를 trino-monaco 에 업스트림 PR 후보로 둔다 — 그쪽의 알려진 멀티 에디터 버그를 고친다.
- 재검토 조건: trino-monaco 가 모델 라우터를 채택해 **두 레포가 동일 코드를 쓰게 되고**, 해당 API 가 2 릴리스 이상 변경 없이 유지될 때. 그때 후보는 `cache`, `completionItems`, `completionRouter`, `editorActions` + 워커 클라이언트 래퍼.

## 16.4 게이트웨이 다중 언어 구현 (Python / Java)

`servers/` 아래 세 구현은 엔드포인트, 요청/응답 JSON, 오류 형식 `{ error: { code, message, offset? } }`, 세션 쿠키(`omsid`, httpOnly·SameSite=Strict·Secure), 환경변수(`CONNECT_ALIASES`, `GATEWAY_*`, `SECURE_COOKIE`, `ALLOW_DDL`, `IDLE_TIMEOUT_MIN`, `CALL_TIMEOUT_SEC`, `MAX_SESSIONS_PER_USER`, `ALLOW_HEADER_AUTH`)가 같다. 모두 Thin 드라이버라 Oracle Client 가 필요 없다.

| | server-node | server-python | server-java |
|---|---|---|---|
| 스택 | Fastify + node-oracledb | FastAPI + uvicorn + python-oracledb (async) | Spring Boot 4 (Spring MVC, virtual threads) + ojdbc11 |
| 드라이버 분리 | `driver.ts` (node-oracledb 슬라이스) | `driver.py` (`Driver`/`Connection` 프로토콜 + `OracledbDriver`) | `Driver` 인터페이스 + `JdbcDriver` (`Driver` Bean 교체 가능) |
| 세션 직렬화 | 드라이버 내부 큐 | 세션별 `asyncio.Lock` | 세션별 `ReentrantLock` |
| 취소 | `connection.break()` | `connection.cancel()` | 실행 중 `Statement.cancel()` |
| call timeout | `callTimeout` | `call_timeout` | `setQueryTimeout` (초 단위 올림) |
| 바인드 | 드라이버가 이름 바인드 처리 | 드라이버가 이름 바인드 처리 | 이름 → JDBC 위치 변환: SQL 은 출현마다, PL/SQL 블록은 고유 이름마다. 바인드가 없으면 일반 `Statement` (트리거 `:NEW`/`:OLD` 보존), JDBC escape 처리 끔 |
| DBMS_OUTPUT | `GET_LINES` 배열 바인드 | `GET_LINES` + `arrayvar` | `GET_LINES` + `SYS.DBMSOUTPUT_LINESARRAY` |
| 연결 끊김 판정 | ORA-01012/03113/03114/03135/00028, DPI-1080, NJS-003/500/501/503 | 같은 ORA + DPY-1001/4011 | 같은 ORA + ORA-17002/17008/17410/17447, `SQLRecoverableException` |

언어별 차이 (클라이언트 영향 없음):

- NUMBER **OUT 바인드**: Node 는 JS 숫자, Python·Java 는 결과 셀과 같은 정확한 문자열.
- `TIMESTAMP WITH LOCAL TIME ZONE`: Node·Java 는 ISO instant, Python 은 세션 시간대 벽시계 문자열 (python-oracledb 가 시간대를 주지 않음). `TIMESTAMP WITH TIME ZONE` 은 셋 다 ISO instant (Python 은 NLS 텍스트로 받아 변환).
- 잘못된 요청 본문: Python 은 Pydantic 검증 오류를 **400** 으로 바꾼다 (422 는 SQL 오류 전용).
- Python 은 `GATEWAY_DOCS=true` 일 때만 `{prefix}/docs` 에 OpenAPI/Swagger UI 를 연다 (기본 꺼짐).
- Java 의 `IDLE_TIMEOUT_MIN`·`CALL_TIMEOUT_SEC` 는 정수 (Spring `Duration` 으로 변환). 모든 설정은 `gateway.*` Spring 프로퍼티로도 지정 가능.

## 17. 오픈 이슈

- 결과 그리드 컴포넌트를 본 패키지에 포함할지(현재는 호스트 책임).
- 서버 검증 전용 세션: 게이트웨이에 "검증용 보조 커넥션"(같은 사용자, 읽기 전용 용도) 을 둘지. 현재는 `paused` 로 실행 중 보류만 한다.
- 원격(DB 링크) 루틴의 시그니처(`ALL_ARGUMENTS@link`) 는 미지원.
- 라이선스/NOTICE: trino-monaco(MIT, DataDynamics-OSS) 및 Monaco SQL 정의(MIT) 저작권 고지를 `NOTICE` 에 유지.
