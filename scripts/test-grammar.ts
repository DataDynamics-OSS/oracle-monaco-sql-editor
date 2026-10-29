/* Grammar regression suite: valid Oracle statements must parse cleanly, invalid ones must not.
   Run: npx tsx scripts/test-grammar.ts */
import { validateGrammar } from "../src/worker/completionCore.js";
import { assert, done, section } from "./harness.js";

const corpus = [
`SELECT /*+ INDEX(e emp_dept_ix) */ e.employee_id, e.last_name, d.department_name,
       NVL(e.commission_pct, 0) AS comm, q'[It's a q-quote; not a terminator]' AS note
FROM hr.employees e JOIN hr.departments d ON d.department_id = e.department_id
WHERE e.hire_date >= DATE '2020-01-01' AND e.salary > :min_salary
ORDER BY e.last_name
FETCH FIRST 50 ROWS ONLY`,
`DECLARE
  v_name employees.last_name%TYPE;
BEGIN
  <<lookup>>
  SELECT last_name INTO v_name FROM employees WHERE employee_id = &emp_id;
  DBMS_OUTPUT.PUT_LINE('Name: ' || v_name);
EXCEPTION
  WHEN NO_DATA_FOUND THEN NULL;
END;`,
`SELECT ename, sal, LEVEL FROM scott.emp START WITH mgr IS NULL CONNECT BY PRIOR empno = mgr`,
`SELECT deptno, LISTAGG(ename, ',') WITHIN GROUP (ORDER BY ename) names FROM emp GROUP BY deptno`,
`SELECT deptno, SUM(sal) OVER (PARTITION BY deptno ORDER BY hiredate ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) running FROM emp`,
`SELECT MAX(sal) KEEP (DENSE_RANK FIRST ORDER BY hiredate) FROM emp`,
`SELECT * FROM emp WHERE deptno IN (SELECT deptno FROM dept WHERE loc = 'DALLAS') AND sal BETWEEN 1000 AND 2000 AND ename LIKE 'S%' ESCAPE '\\'`,
`SELECT CASE WHEN sal > 1000 THEN 'high' ELSE 'low' END grade, DECODE(deptno, 10, 'A', 'B') d FROM emp`,
`SELECT TO_CHAR(SYSDATE, 'YYYY-MM-DD'), EXTRACT(YEAR FROM hiredate), TRIM(LEADING '0' FROM '007'), INTERVAL '1' DAY FROM dual`,
`SELECT e.*, ROWNUM rn FROM emp e WHERE ROWNUM <= 10`,
`SELECT a.x FROM t1 a, t2 b WHERE a.id = b.id(+)`,
`SELECT * FROM emp AS OF TIMESTAMP SYSTIMESTAMP - INTERVAL '10' MINUTE`,
`WITH dept_costs AS (SELECT dname, SUM(sal) dept_total FROM emp e, dept d WHERE e.deptno = d.deptno GROUP BY dname) SELECT * FROM dept_costs WHERE dept_total > 1000 ORDER BY dname`,
`SELECT deptno, job, SUM(sal) FROM emp GROUP BY ROLLUP (deptno, job) HAVING SUM(sal) > 1000`,
`SELECT * FROM emp ORDER BY sal DESC NULLS LAST OFFSET 5 ROWS FETCH NEXT 10 ROWS ONLY`,
`SELECT * FROM emp FOR UPDATE OF sal NOWAIT`,
`SELECT empno FROM emp UNION ALL SELECT empno FROM emp_hist MINUS SELECT empno FROM emp_del`,
`SELECT seq_emp.NEXTVAL FROM dual`,
`SELECT * FROM TABLE(my_pkg.get_rows(10)) t`,
`SELECT COUNT(*), COUNT(DISTINCT deptno) FROM emp`,
`INSERT INTO emp (empno, ename, sal) VALUES (seq.NEXTVAL, 'KIM', 1000) RETURNING empno INTO :new_id`,
`INSERT INTO emp_copy SELECT * FROM emp WHERE deptno = 10`,
`INSERT ALL INTO t1 (a) VALUES (x) INTO t2 (b) VALUES (y) SELECT x, y FROM src`,
`UPDATE emp e SET e.sal = e.sal * 1.1, e.comm = NULL WHERE e.deptno = 20`,
`UPDATE emp SET (sal, comm) = (SELECT sal, comm FROM emp_new WHERE empno = 1) WHERE empno = 1`,
`DELETE emp WHERE empno = 7369`,
`MERGE INTO emp t USING emp_stage s ON (t.empno = s.empno) WHEN MATCHED THEN UPDATE SET t.sal = s.sal WHEN NOT MATCHED THEN INSERT (empno, sal) VALUES (s.empno, s.sal)`,
`CREATE TABLE emp2 (id NUMBER(10) PRIMARY KEY, name VARCHAR2(100 CHAR) NOT NULL, created TIMESTAMP WITH TIME ZONE DEFAULT SYSTIMESTAMP, dept_id NUMBER CONSTRAINT fk_dept REFERENCES dept (deptno))`,
`CREATE TABLE emp3 AS SELECT * FROM emp`,
`CREATE OR REPLACE VIEW v_emp AS SELECT empno, ename FROM emp WITH READ ONLY`,
`CREATE UNIQUE INDEX ix_emp ON emp (ename, deptno DESC)`,
`CREATE SEQUENCE seq_emp START WITH 1 INCREMENT BY 1 NOCACHE NOCYCLE`,
`CREATE OR REPLACE PUBLIC SYNONYM emp FOR scott.emp`,
`ALTER TABLE emp ADD (bonus NUMBER(8,2) DEFAULT 0)`,
`ALTER TABLE emp MODIFY ename VARCHAR2(50)`,
`ALTER TABLE emp RENAME COLUMN ename TO emp_name`,
`DROP TABLE emp2 CASCADE CONSTRAINTS PURGE`,
`TRUNCATE TABLE emp_stage`,
`COMMENT ON COLUMN emp.sal IS 'monthly salary'`,
`GRANT SELECT, INSERT ON emp TO app_user`,
`GRANT CREATE SESSION TO app_user`,
`EXPLAIN PLAN SET STATEMENT_ID = 'x' FOR SELECT * FROM emp`,
`ALTER SESSION SET NLS_DATE_FORMAT = 'YYYY-MM-DD'`,
`COMMIT`, `ROLLBACK TO SAVEPOINT sp1`,
`SELECT JSON_VALUE(doc, '$.name') FROM docs`,
`SELECT * FROM emp e WHERE NOT EXISTS (SELECT 1 FROM dept d WHERE d.deptno = e.deptno)`,
`SELECT sal ** 2, MOD(sal, 3), -sal FROM emp`,
`SELECT * FROM emp WHERE (deptno, job) IN (SELECT deptno, job FROM emp WHERE sal > 1000)`,
`SELECT * FROM emp WHERE sal > ANY (1000, 2000)`,
`SELECT CAST(sal AS VARCHAR2(20)) FROM emp`,
`SELECT * FROM emp WHERE hiredate > TIMESTAMP '2020-01-01 00:00:00'`,
`CREATE OR REPLACE PROCEDURE raise_sal (p_empno IN emp.empno%TYPE, p_pct IN NUMBER DEFAULT 10) IS
  CURSOR c IS SELECT * FROM emp WHERE empno = p_empno FOR UPDATE;
  TYPE t_tab IS TABLE OF emp%ROWTYPE INDEX BY PLS_INTEGER;
  v_tab t_tab;
  e_none EXCEPTION;
  PRAGMA EXCEPTION_INIT(e_none, -20001);
BEGIN
  FOR r IN c LOOP
    UPDATE emp SET sal = sal * (1 + p_pct / 100) WHERE CURRENT OF c;
  END LOOP;
  IF SQL%ROWCOUNT = 0 THEN RAISE e_none; ELSIF p_pct > 50 THEN NULL; ELSE NULL; END IF;
  OPEN c; FETCH c BULK COLLECT INTO v_tab LIMIT 100; CLOSE c;
  FORALL i IN 1..v_tab.COUNT SAVE EXCEPTIONS DELETE FROM emp_log WHERE empno = v_tab(i).empno;
  EXECUTE IMMEDIATE 'TRUNCATE TABLE emp_stage';
  EXECUTE IMMEDIATE 'SELECT COUNT(*) FROM emp WHERE deptno = :d' INTO v_cnt USING p_empno;
  CASE p_pct WHEN 10 THEN NULL; WHEN 20 THEN NULL; ELSE NULL; END CASE;
  WHILE v_cnt > 0 LOOP v_cnt := v_cnt - 1; EXIT WHEN v_cnt = 5; END LOOP;
  COMMIT;
EXCEPTION
  WHEN e_none OR NO_DATA_FOUND THEN ROLLBACK;
  WHEN OTHERS THEN RAISE;
END raise_sal;`,
`CREATE OR REPLACE FUNCTION get_sal (p_id NUMBER) RETURN NUMBER DETERMINISTIC IS
  v NUMBER;
BEGIN
  SELECT sal INTO v FROM emp WHERE empno = p_id;
  RETURN v;
END;`,
`CREATE OR REPLACE PACKAGE emp_pkg AS
  g_count NUMBER := 0;
  PROCEDURE hire (p_name VARCHAR2);
  FUNCTION total RETURN NUMBER;
END emp_pkg;`,
`CREATE OR REPLACE PACKAGE BODY emp_pkg AS
  PROCEDURE hire (p_name VARCHAR2) IS BEGIN INSERT INTO emp (ename) VALUES (p_name); g_count := g_count + 1; END hire;
  FUNCTION total RETURN NUMBER IS BEGIN RETURN g_count; END total;
END emp_pkg;`,
`CREATE OR REPLACE TRIGGER trg_emp BEFORE INSERT OR UPDATE OF sal ON emp FOR EACH ROW
WHEN (new.sal > 0)
BEGIN
  IF INSERTING THEN :new.empno := seq_emp.NEXTVAL; END IF;
  :new.updated := SYSDATE;
END;`,
`CREATE OR REPLACE TYPE t_point AS OBJECT (x NUMBER, y NUMBER, MEMBER FUNCTION dist RETURN NUMBER) NOT FINAL;`,
`BEGIN dbms_output.put_line(q'{it's}'); my_pkg.do_it(p_a => 1, p_b => 'x'); END;`,
`DECLARE TYPE r_t IS RECORD (a NUMBER, b VARCHAR2(10)); v r_t; BEGIN v.a := 1; END;`,
];

const PLSQL = /^(DECLARE|BEGIN|CREATE OR REPLACE (PROCEDURE|FUNCTION|PACKAGE|TRIGGER|TYPE))/;

section(`valid statements (${corpus.length})`);
for (const sql of corpus) {
  const errs = validateGrammar(PLSQL.test(sql) ? `${sql}\n/` : sql, "all");
  const label = sql.replace(/\s+/g, " ").slice(0, 70);
  assert(label, errs.length === 0, errs[0] && `${errs[0].message} @${errs[0].line}:${errs[0].column}`);
}

section("invalid statements are flagged");
const invalid = [
  "SELECT FROM emp",
  "SELECT * FROM emp e AS x",            // Oracle table aliases take no AS
  "SELECT * FROM emp WHERE",
  "INSERT INTO emp VALUES",
  "UPDATE emp SET WHERE a = 1",
  "SELECT a b c FROM t",
  "DELETE FROM",
  "BEGIN x := ; END;\n/",
  "BEGIN IF x THEN NULL; END;\n/",       // missing END IF
];
for (const sql of invalid) {
  assert(sql.replace(/\n/g, " "), validateGrammar(sql, "all").length > 0);
}

done();
