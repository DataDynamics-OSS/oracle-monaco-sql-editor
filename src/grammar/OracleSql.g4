/*
 * A focused Oracle SQL / PL/SQL grammar for context-aware completion (antlr4-c3).
 *
 * The completion core parses ONE statement at a time (see splitter.ts), so the
 * root is a single SQL statement or PL/SQL unit. Coverage:
 *   - queries: WITH (CTEs, 12c WITH FUNCTION), set operators incl. MINUS,
 *     joins / APPLY / LATERAL, inline views, CONNECT BY, GROUP BY ROLLUP/CUBE,
 *     analytic OVER (...), KEEP / WITHIN GROUP, OFFSET / FETCH, FOR UPDATE,
 *     flashback AS OF, `table@dblink`, `(+)` outer joins
 *   - DML: INSERT (single and INSERT ALL/FIRST), UPDATE, DELETE, MERGE, RETURNING
 *   - DDL / control: CREATE TABLE / VIEW / INDEX / SEQUENCE / SYNONYM,
 *     DROP, ALTER TABLE, TRUNCATE, COMMENT ON, GRANT / REVOKE, COMMIT /
 *     ROLLBACK / SAVEPOINT, EXPLAIN PLAN, ALTER SESSION, CALL
 *   - PL/SQL: anonymous blocks, CREATE PROCEDURE / FUNCTION / PACKAGE [BODY] /
 *     TRIGGER / TYPE, declarations (%TYPE, %ROWTYPE, cursors, records,
 *     collections, nested subprograms), IF / CASE / LOOP / WHILE / FOR,
 *     cursor FOR loops, EXECUTE IMMEDIATE, OPEN / FETCH / CLOSE, FORALL,
 *     exception handlers, labels
 * It is intentionally reduced — not the full Oracle grammar.
 *
 * Preferred rules the completion engine keys on:
 *   tableRef      an existing table / view / synonym (FROM, INTO, UPDATE, …)
 *   columnRef     an existing column or qualified reference
 *   functionName  a function (built-in, schema or package function)
 *   procedureRef  a procedure call statement in PL/SQL
 *   variableRef   a PL/SQL variable / INTO target
 *   typeName      a data type
 *   dblinkRef     a database link after `@`
 *   nonReserved   keywords usable as identifiers (hidden from keyword lists)
 * New-object names (CREATE targets, column definitions, declarations) use plain
 * identifier / qualifiedName so they do NOT trigger existing-object suggestions.
 *
 * Written from scratch, following the structure of trino-monaco's TrinoSql.g4.
 */
grammar OracleSql;

options { caseInsensitive = true; }

// ============================ Entry ============================

root
    : unit? SEMICOLON? EOF
    ;

unit
    : sqlStatement
    | plsqlUnit
    ;

sqlStatement
    : selectStatement
    | insertStatement
    | updateStatement
    | deleteStatement
    | mergeStatement
    | createTableStatement
    | createViewStatement
    | createIndexStatement
    | createSequenceStatement
    | createSynonymStatement
    | dropStatement
    | alterTableStatement
    | truncateStatement
    | commentStatement
    | grantStatement
    | revokeStatement
    | commitStatement
    | rollbackStatement
    | savepointStatement
    | explainStatement
    | alterSessionStatement
    | callStatement
    ;

// ============================ Queries ============================

selectStatement
    : subquery forUpdateClause?
    ;

subquery
    : withClause? queryExpression orderByClause? rowLimitingClause?
    ;

withClause
    : WITH subprogramBody+ (namedQuery (COMMA namedQuery)*)?
    | WITH namedQuery (COMMA namedQuery)*
    ;

namedQuery
    : identifier columnAliases? AS LPAREN subquery RPAREN
    ;

columnAliases
    : LPAREN identifier (COMMA identifier)* RPAREN
    ;

queryExpression
    : queryTerm ((UNION ALL? | INTERSECT | MINUS | EXCEPT) queryTerm)*
    ;

queryTerm
    : queryBlock
    | LPAREN subquery RPAREN
    ;

queryBlock
    : SELECT setQuantifier? selectList
      intoClause?
      fromClause?
      whereClause?
      hierarchicalClause?
      groupByClause?
      havingClause?
    ;

setQuantifier
    : DISTINCT | UNIQUE | ALL
    ;

selectList
    : ASTERISK
    | selectItem (COMMA selectItem)*
    ;

selectItem
    : allColumns
    | expression (AS? identifier)?
    ;

allColumns
    : identifier (DOT identifier)? DOT ASTERISK
    ;

intoClause
    : (BULK COLLECT)? INTO variableRef (COMMA variableRef)*
    ;

fromClause
    : FROM tableSource (COMMA tableSource)*
    ;

tableSource
    : tableReference joinClause*
    ;

joinClause
    : joinType? JOIN tableReference joinCondition?
    | (CROSS | OUTER) APPLY tableReference
    ;

joinType
    : INNER
    | (LEFT | RIGHT | FULL) OUTER?
    | CROSS
    | NATURAL (INNER | (LEFT | RIGHT | FULL) OUTER?)?
    ;

joinCondition
    : ON condition
    | USING LPAREN columnRef (COMMA columnRef)* RPAREN
    ;

// Oracle table aliases never take AS.
tableReference
    : queryTableExpression flashbackClause? tableAlias?
    ;

tableAlias
    : identifier
    ;

queryTableExpression
    : tableRef dbLink?
    | LATERAL? LPAREN subquery RPAREN
    | TABLE LPAREN expression RPAREN
    | ONLY LPAREN tableRef RPAREN
    ;

dbLink
    : AT_SIGN dblinkRef
    ;

flashbackClause
    : AS OF (SCN | TIMESTAMP) expression
    | VERSIONS BETWEEN (SCN | TIMESTAMP) expression AND expression
    ;

whereClause
    : WHERE (condition | CURRENT OF identifier)
    ;

hierarchicalClause
    : START WITH condition CONNECT BY NOCYCLE? condition
    | CONNECT BY NOCYCLE? condition (START WITH condition)?
    ;

groupByClause
    : GROUP BY groupingElement (COMMA groupingElement)*
    ;

groupingElement
    : (ROLLUP | CUBE) LPAREN expression (COMMA expression)* RPAREN
    | GROUPING SETS LPAREN groupingElement (COMMA groupingElement)* RPAREN
    | LPAREN RPAREN
    | expression
    ;

havingClause
    : HAVING condition
    ;

orderByClause
    : ORDER SIBLINGS? BY sortItem (COMMA sortItem)*
    ;

sortItem
    : expression (ASC | DESC)? (NULLS (FIRST | LAST))?
    ;

rowLimitingClause
    : OFFSET expression (ROW | ROWS) fetchClause?
    | fetchClause
    ;

fetchClause
    : FETCH (FIRST | NEXT) (expression PERCENT_KW?)? (ROW | ROWS) (ONLY | WITH TIES)
    ;

forUpdateClause
    : FOR UPDATE (OF columnRef (COMMA columnRef)*)? (NOWAIT | WAIT expression | SKIP_ LOCKED)?
    ;

// ============================ DML ============================

insertStatement
    : INSERT (singleTableInsert | multiTableInsert)
    ;

singleTableInsert
    : insertIntoClause (valuesClause returningClause? | subquery)
    ;

insertIntoClause
    : INTO tableRef dbLink? tableAlias? columnRefList?
    ;

valuesClause
    : VALUES LPAREN expression (COMMA expression)* RPAREN
    ;

multiTableInsert
    : ALL (insertIntoClause valuesClause?)+ subquery
    | (ALL | FIRST) conditionalInsert+ (ELSE (insertIntoClause valuesClause?)+)? subquery
    ;

conditionalInsert
    : WHEN condition THEN (insertIntoClause valuesClause?)+
    ;

columnRefList
    : LPAREN columnRef (COMMA columnRef)* RPAREN
    ;

updateStatement
    : UPDATE tableRef dbLink? tableAlias? SET updateSet (COMMA updateSet)* whereClause? returningClause?
    ;

updateSet
    : columnRef EQ expression
    | columnRefList EQ LPAREN subquery RPAREN
    ;

deleteStatement
    : DELETE FROM? tableRef dbLink? tableAlias? whereClause? returningClause?
    ;

mergeStatement
    : MERGE INTO tableRef tableAlias?
      USING (tableRef | LPAREN subquery RPAREN) tableAlias?
      ON LPAREN condition RPAREN
      mergeUpdateClause? mergeInsertClause?
    ;

mergeUpdateClause
    : WHEN MATCHED THEN UPDATE SET updateSet (COMMA updateSet)* whereClause? (DELETE whereClause)?
    ;

mergeInsertClause
    : WHEN NOT MATCHED THEN INSERT columnRefList? valuesClause whereClause?
    ;

returningClause
    : (RETURNING | RETURN) expression (COMMA expression)* (BULK COLLECT)? INTO variableRef (COMMA variableRef)*
    ;

// ============================ DDL / control ============================

createTableStatement
    : CREATE ((GLOBAL | PRIVATE) TEMPORARY)? TABLE ifNotExists? qualifiedName
      (LPAREN relationalProperty (COMMA relationalProperty)* RPAREN)?
      tableOption*
      (AS subquery)?
    ;

ifNotExists
    : IF NOT EXISTS
    ;

ifExists
    : IF EXISTS
    ;

relationalProperty
    : outOfLineConstraint
    | columnDefinition
    ;

columnDefinition
    : identifier typeName? (DEFAULT expression)? inlineConstraint*
    ;

inlineConstraint
    : (CONSTRAINT identifier)?
      ( NOT? NULL
      | PRIMARY KEY
      | UNIQUE
      | REFERENCES tableRef columnAliases? (ON DELETE (CASCADE | SET NULL))?
      | CHECK LPAREN condition RPAREN
      )
    ;

outOfLineConstraint
    : (CONSTRAINT identifier)?
      ( PRIMARY KEY columnAliases
      | UNIQUE columnAliases
      | FOREIGN KEY columnAliases REFERENCES tableRef columnAliases? (ON DELETE (CASCADE | SET NULL))?
      | CHECK LPAREN condition RPAREN
      )
    ;

tableOption
    : TABLESPACE identifier
    ;

createViewStatement
    : CREATE (OR REPLACE)? (NO? FORCE)? EDITIONING? (MATERIALIZED)? VIEW qualifiedName columnAliases?
      AS subquery (WITH (READ ONLY | CHECK OPTION))?
    ;

createIndexStatement
    : CREATE (UNIQUE | BITMAP)? INDEX qualifiedName ON tableRef
      LPAREN sortItem (COMMA sortItem)* RPAREN tableOption*
    ;

createSequenceStatement
    : CREATE SEQUENCE ifNotExists? qualifiedName sequenceOption*
    ;

sequenceOption
    : START WITH expression
    | INCREMENT BY expression
    | (MAXVALUE | MINVALUE | CACHE) expression
    | NOMAXVALUE | NOMINVALUE | NOCACHE | CYCLE | NOCYCLE | ORDER | NOORDER
    ;

createSynonymStatement
    : CREATE (OR REPLACE)? PUBLIC? SYNONYM qualifiedName FOR tableRef dbLink?
    ;

dropStatement
    : DROP TABLE ifExists? tableRef (CASCADE CONSTRAINTS)? PURGE?
    | DROP MATERIALIZED? VIEW ifExists? tableRef
    | DROP INDEX ifExists? qualifiedName
    | DROP SEQUENCE ifExists? qualifiedName
    | DROP PUBLIC? SYNONYM ifExists? qualifiedName FORCE?
    | DROP (PROCEDURE | FUNCTION | PACKAGE BODY? | TRIGGER | TYPE BODY?) ifExists? qualifiedName
    ;

alterTableStatement
    : ALTER TABLE tableRef alterTableAction
    ;

alterTableAction
    : ADD (LPAREN relationalProperty (COMMA relationalProperty)* RPAREN | relationalProperty)
    | MODIFY (LPAREN columnModification (COMMA columnModification)* RPAREN | columnModification)
    | DROP (COLUMN columnRef | columnRefList | CONSTRAINT identifier) (CASCADE CONSTRAINTS)?
    | RENAME (TO identifier | COLUMN columnRef TO identifier | CONSTRAINT identifier TO identifier)
    ;

columnModification
    : columnRef typeName? (DEFAULT expression)? inlineConstraint*
    ;

truncateStatement
    : TRUNCATE TABLE tableRef
    ;

commentStatement
    : COMMENT ON (TABLE tableRef | COLUMN columnRef | MATERIALIZED VIEW tableRef) IS STRING
    ;

grantStatement
    : GRANT privilege (COMMA privilege)* (ON tableRef)? TO identifier (COMMA identifier)* (WITH (GRANT | ADMIN) OPTION)?
    ;

revokeStatement
    : REVOKE privilege (COMMA privilege)* (ON tableRef)? FROM identifier (COMMA identifier)*
    ;

privilege
    : ALL PRIVILEGES?
    | SELECT | INSERT | UPDATE | DELETE | EXECUTE | INDEX | REFERENCES
    | (CREATE | ALTER | DROP)? ANY? (identifier | TABLE | VIEW | SEQUENCE | SYNONYM | PROCEDURE | TRIGGER | TYPE | SESSION)+
    | ALTER
    ;

commitStatement
    : COMMIT WORK?
    ;

rollbackStatement
    : ROLLBACK WORK? (TO SAVEPOINT? identifier)?
    ;

savepointStatement
    : SAVEPOINT identifier
    ;

explainStatement
    : EXPLAIN PLAN (SET STATEMENT_ID EQ STRING)? (INTO tableRef)? FOR
      (selectStatement | insertStatement | updateStatement | deleteStatement | mergeStatement)
    ;

alterSessionStatement
    : ALTER SESSION SET identifier EQ expression (identifier EQ expression)*
    ;

callStatement
    : CALL functionCall (INTO variableRef)?
    ;

// ============================ PL/SQL ============================

plsqlUnit
    : anonymousBlock
    | createProcedure
    | createFunction
    | createPackage
    | createPackageBody
    | createTrigger
    | createType
    ;

anonymousBlock
    : LABEL* (DECLARE declaration*)? block
    ;

block
    : BEGIN plsqlStatements (EXCEPTION exceptionHandler+)? END identifier? SEMICOLON
    ;

orReplace
    : OR REPLACE
    ;

editionable
    : EDITIONABLE | NONEDITIONABLE
    ;

createProcedure
    : CREATE orReplace? editionable? PROCEDURE qualifiedName parameterList? invokerRights? (IS | AS) declaration* block
    ;

createFunction
    : CREATE orReplace? editionable? FUNCTION qualifiedName parameterList? RETURN plsqlType functionOption*
      (IS | AS) declaration* block
    ;

createPackage
    : CREATE orReplace? editionable? PACKAGE qualifiedName invokerRights? (IS | AS) declaration* END identifier? SEMICOLON
    ;

createPackageBody
    : CREATE orReplace? editionable? PACKAGE BODY qualifiedName (IS | AS) declaration*
      (BEGIN plsqlStatements)? END identifier? SEMICOLON
    ;

createTrigger
    : CREATE orReplace? editionable? TRIGGER qualifiedName
      (BEFORE | AFTER | INSTEAD OF) dmlEvent (OR dmlEvent)* ON tableRef
      (FOR EACH ROW)? (WHEN LPAREN condition RPAREN)?
      (DECLARE declaration*)? block
    ;

dmlEvent
    : INSERT
    | DELETE
    | UPDATE (OF columnRef (COMMA columnRef)*)?
    ;

createType
    : CREATE orReplace? editionable? TYPE qualifiedName FORCE? (IS | AS)
      ( OBJECT LPAREN typeAttribute (COMMA typeAttribute)* RPAREN
      | TABLE OF plsqlType
      | VARRAY LPAREN expression RPAREN OF plsqlType
      ) (NOT? FINAL)? SEMICOLON?
    | CREATE orReplace? editionable? TYPE BODY qualifiedName (IS | AS)
      ((MEMBER | STATIC) subprogramBody)+ END SEMICOLON?
    ;

typeAttribute
    : (MEMBER | STATIC) (FUNCTION identifier parameterList? RETURN plsqlType | PROCEDURE identifier parameterList?)
    | identifier plsqlType
    ;

invokerRights
    : AUTHID (CURRENT_USER | DEFINER)
    ;

functionOption
    : DETERMINISTIC | PIPELINED | PARALLEL_ENABLE | RESULT_CACHE
    ;

parameterList
    : LPAREN parameter (COMMA parameter)* RPAREN
    ;

parameter
    : identifier (IN OUT? | OUT)? NOCOPY? plsqlType ((ASSIGN | DEFAULT) expression)?
    ;

declaration
    : variableDeclaration
    | exceptionDeclaration
    | cursorDeclaration
    | typeDeclaration
    | pragmaDeclaration
    | subprogramBody
    | subprogramSpec
    ;

variableDeclaration
    : identifier CONSTANT? plsqlType (NOT NULL)? ((ASSIGN | DEFAULT) expression)? SEMICOLON
    ;

exceptionDeclaration
    : identifier EXCEPTION SEMICOLON
    ;

cursorDeclaration
    : CURSOR identifier parameterList? (RETURN plsqlType)? (IS selectStatement)? SEMICOLON
    ;

typeDeclaration
    : (TYPE | SUBTYPE) identifier IS typeDefinition SEMICOLON
    ;

typeDefinition
    : RECORD LPAREN recordField (COMMA recordField)* RPAREN
    | TABLE OF plsqlType (NOT NULL)? (INDEX BY plsqlType)?
    | VARRAY LPAREN expression RPAREN OF plsqlType
    | REF CURSOR (RETURN plsqlType)?
    | plsqlType (NOT NULL)?
    ;

recordField
    : identifier plsqlType (NOT NULL)? ((ASSIGN | DEFAULT) expression)?
    ;

pragmaDeclaration
    : PRAGMA identifier (LPAREN argument (COMMA argument)* RPAREN)? SEMICOLON
    ;

subprogramSpec
    : PROCEDURE identifier parameterList? SEMICOLON
    | FUNCTION identifier parameterList? RETURN plsqlType functionOption* SEMICOLON
    ;

subprogramBody
    : PROCEDURE identifier parameterList? (IS | AS) declaration* block
    | FUNCTION identifier parameterList? RETURN plsqlType functionOption* (IS | AS) declaration* block
    ;

// `employees.salary%TYPE`, `employees%ROWTYPE`, or a plain type.
plsqlType
    : columnRef PERCENT (TYPE | ROWTYPE)
    | REF CURSOR
    | typeName
    ;

plsqlStatements
    : (LABEL* plsqlStatement)+
    ;

plsqlStatement
    : assignmentStatement
    | ifStatement
    | caseStatement
    | loopStatement
    | exitStatement
    | returnStatement
    | raiseStatement
    | NULL SEMICOLON
    | GOTO identifier SEMICOLON
    | executeImmediateStatement
    | openStatement
    | fetchStatement
    | closeStatement
    | forallStatement
    | PIPE ROW LPAREN expression RPAREN SEMICOLON
    | (DECLARE declaration*)? block
    | sqlStatement SEMICOLON
    | procedureCall
    ;

assignmentStatement
    : assignmentTarget ASSIGN expression SEMICOLON
    ;

assignmentTarget
    : BIND_VARIABLE (DOT identifier)*
    | variableRef (LPAREN expression RPAREN)? (DOT identifier)*
    ;

procedureCall
    : procedureRef (LPAREN (argument (COMMA argument)*)? RPAREN)? SEMICOLON
    ;

ifStatement
    : IF condition THEN plsqlStatements
      (ELSIF condition THEN plsqlStatements)*
      (ELSE plsqlStatements)?
      END IF SEMICOLON
    ;

caseStatement
    : CASE expression? (WHEN condition THEN plsqlStatements)+ (ELSE plsqlStatements)? END CASE identifier? SEMICOLON
    ;

loopStatement
    : (WHILE condition | FOR identifier IN loopRange)? LOOP plsqlStatements END LOOP identifier? SEMICOLON
    ;

loopRange
    : REVERSE? expression DOTDOT expression
    | LPAREN subquery RPAREN
    | variableRef (LPAREN (argument (COMMA argument)*)? RPAREN)?
    ;

exitStatement
    : (EXIT | CONTINUE) identifier? (WHEN condition)? SEMICOLON
    ;

returnStatement
    : RETURN expression? SEMICOLON
    ;

raiseStatement
    : RAISE identifier? SEMICOLON
    ;

executeImmediateStatement
    : EXECUTE IMMEDIATE expression
      ((BULK COLLECT)? INTO variableRef (COMMA variableRef)*)?
      (USING usingBind (COMMA usingBind)*)?
      SEMICOLON
    ;

usingBind
    : (IN OUT? | OUT)? expression
    ;

openStatement
    : OPEN variableRef (LPAREN (argument (COMMA argument)*)? RPAREN)?
      (FOR (subquery | expression) (USING usingBind (COMMA usingBind)*)?)? SEMICOLON
    ;

fetchStatement
    : FETCH variableRef (BULK COLLECT)? INTO variableRef (COMMA variableRef)* (LIMIT expression)? SEMICOLON
    ;

closeStatement
    : CLOSE variableRef SEMICOLON
    ;

forallStatement
    : FORALL identifier IN expression DOTDOT expression (SAVE EXCEPTIONS)?
      (insertStatement | updateStatement | deleteStatement | mergeStatement) SEMICOLON
    ;

exceptionHandler
    : WHEN (OTHERS | identifier (OR identifier)*) THEN plsqlStatements
    ;

// ============================ Conditions & expressions ============================

condition
    : NOT condition
    | condition AND condition
    | condition OR condition
    | predicate
    ;

predicate
    : expression comparisonOperator (ANY | SOME | ALL) LPAREN (subquery | expression (COMMA expression)*) RPAREN
    | expression comparisonOperator expression
    | expression IS NOT? (NULL | EMPTY | NAN | INFINITE | OF TYPE? LPAREN typeName RPAREN)
    | expression NOT? IN (LPAREN (subquery | expression (COMMA expression)*) RPAREN | expression)
    | expression NOT? BETWEEN expression AND expression
    | expression NOT? (LIKE | LIKEC | LIKE2 | LIKE4) expression (ESCAPE expression)?
    | EXISTS LPAREN subquery RPAREN
    | LPAREN condition RPAREN
    | expression
    ;

comparisonOperator
    : EQ | NEQ | LT | LTE | GT | GTE
    ;

expression
    : (PLUS | MINUS_SIGN | PRIOR | CONNECT_BY_ROOT) expression
    | expression EXPONENT expression
    | expression (ASTERISK | SLASH) expression
    | expression (PLUS | MINUS_SIGN) expression
    | expression CONCAT expression
    | primary
    ;

primary
    : literal
    | BIND_VARIABLE (DOT identifier)*
    | caseExpression
    | CAST LPAREN (expression | MULTISET LPAREN subquery RPAREN) AS typeName RPAREN
    | EXTRACT LPAREN identifier FROM expression RPAREN
    | TRIM LPAREN ((LEADING | TRAILING | BOTH)? expression? FROM)? expression RPAREN
    | functionCall (DOT identifier)*   // v_tab(i).empno, obj.method().attr
    | columnRef PERCENT identifier (LPAREN expression RPAREN)?   // SQL%ROWCOUNT, c%FOUND, SQL%BULK_ROWCOUNT(i)
    | columnRef (LPAREN PLUS RPAREN)?
    | LPAREN subquery RPAREN
    | LPAREN expression (COMMA expression)* RPAREN
    ;

caseExpression
    : CASE expression? (WHEN condition THEN expression)+ (ELSE expression)? END
    ;

functionCall
    : functionName LPAREN (setQuantifier? (ASTERISK | argument (COMMA argument)*))? RPAREN
      (KEEP LPAREN identifier (FIRST | LAST) orderByClause RPAREN)?
      (WITHIN GROUP LPAREN orderByClause RPAREN)?
      overClause?
    ;

argument
    : (identifier ARROW)? condition
    ;

overClause
    : OVER LPAREN (PARTITION BY expression (COMMA expression)*)? orderByClause? windowingClause? RPAREN
    ;

windowingClause
    : (ROWS | RANGE) (BETWEEN windowBound AND windowBound | windowBound)
    ;

windowBound
    : UNBOUNDED (PRECEDING | FOLLOWING)
    | CURRENT ROW
    | expression (PRECEDING | FOLLOWING)
    ;

literal
    : NULL | TRUE | FALSE | INTEGER_VALUE | DECIMAL_VALUE | STRING
    | DATE STRING
    | TIMESTAMP STRING
    | INTERVAL STRING identifier (LPAREN INTEGER_VALUE RPAREN)? (TO identifier (LPAREN INTEGER_VALUE RPAREN)?)?
    ;

// ============================ Names & types ============================

// preferred rule: an existing table / view / synonym is expected here
tableRef
    : qualifiedName
    ;

// preferred rule: an existing column / qualified reference is expected here
columnRef
    : qualifiedName
    ;

// preferred rule: a function name (optionally schema / package qualified)
functionName
    : qualifiedName
    ;

// preferred rule: a procedure call in PL/SQL
procedureRef
    : qualifiedName
    ;

// preferred rule: a PL/SQL variable, cursor or INTO target
variableRef
    : qualifiedName
    | BIND_VARIABLE (DOT identifier)*
    ;

// preferred rule: a database link after `@`
dblinkRef
    : qualifiedName
    ;

// preferred rule: a data type
typeName
    : DATE
    | TIMESTAMP (LPAREN INTEGER_VALUE RPAREN)? (WITH LOCAL? TIME ZONE)?
    | INTERVAL identifier (LPAREN INTEGER_VALUE RPAREN)? TO identifier (LPAREN INTEGER_VALUE RPAREN)?
    | qualifiedName (LPAREN INTEGER_VALUE (COMMA INTEGER_VALUE)? identifier? RPAREN)?
    ;

qualifiedName
    : identifier (DOT identifier)*
    ;

identifier
    : IDENTIFIER
    | QUOTED_IDENTIFIER
    | SUBSTITUTION_VARIABLE
    | nonReserved
    ;

// Keywords Oracle lets you use as names (not in V$RESERVED_WORDS' reserved set).
nonReserved
    : ADMIN | APPLY | AUTHID | BITMAP | BODY | BOTH | BULK | CACHE | CASCADE | COLLECT
    | CONSTANT | CONSTRAINTS | CONTINUE | CUBE | CURRENT_USER | CYCLE | DEFINER
    | DETERMINISTIC | EDITIONABLE | EDITIONING | EMPTY | EXCEPTIONS | EXIT | FINAL
    | FIRST | FOLLOWING | FORCE | GLOBAL | GROUPING | INFINITE | INTERVAL | KEEP | KEY
    | LAST | LIMIT | LOCAL | LOCKED | MATCHED | MAXVALUE | MEMBER | MINVALUE | NAN
    | NEXT | NOCACHE | NOCYCLE | NOMAXVALUE | NOMINVALUE | NONEDITIONABLE | NOORDER
    | NULLS | OBJECT | OFFSET | ONLY | OTHERS | PARALLEL_ENABLE | PARTITION | PIPELINED
    | PLAN | PRECEDING | PRIVATE | PRIVILEGES | PURGE | RANGE | READ | RECORD | REF
    | REPLACE | RESULT_CACHE | REVERSE | ROLLUP | ROWTYPE | SAVE | SCN | SETS
    | SIBLINGS | SKIP_ | STATEMENT_ID | STATIC | SUBTYPE | TEMPORARY | TIES | TIME
    | TIMESTAMP | TYPE | UNBOUNDED | VARRAY | VERSIONS | WAIT | WORK | ZONE
    ;

// ============================ Lexer rules ============================

// keywords (MUST all precede the punctuation/operator/literal block below,
// because the completion core treats everything from LPAREN onward as ignored)
ADD              : 'ADD';
ADMIN            : 'ADMIN';
AFTER            : 'AFTER';
ALL              : 'ALL';
ALTER            : 'ALTER';
AND              : 'AND';
ANY              : 'ANY';
APPLY            : 'APPLY';
AS               : 'AS';
ASC              : 'ASC';
AUTHID           : 'AUTHID';
BEFORE           : 'BEFORE';
BEGIN            : 'BEGIN';
BETWEEN          : 'BETWEEN';
BITMAP           : 'BITMAP';
BODY             : 'BODY';
BOTH             : 'BOTH';
BULK             : 'BULK';
BY               : 'BY';
CACHE            : 'CACHE';
CALL             : 'CALL';
CASCADE          : 'CASCADE';
CASE             : 'CASE';
CAST             : 'CAST';
CHECK            : 'CHECK';
CLOSE            : 'CLOSE';
COLLECT          : 'COLLECT';
COLUMN           : 'COLUMN';
COMMENT          : 'COMMENT';
COMMIT           : 'COMMIT';
CONNECT          : 'CONNECT';
CONNECT_BY_ROOT  : 'CONNECT_BY_ROOT';
CONSTANT         : 'CONSTANT';
CONSTRAINT       : 'CONSTRAINT';
CONSTRAINTS      : 'CONSTRAINTS';
CONTINUE         : 'CONTINUE';
CREATE           : 'CREATE';
CROSS            : 'CROSS';
CUBE             : 'CUBE';
CURRENT          : 'CURRENT';
CURRENT_USER     : 'CURRENT_USER';
CURSOR           : 'CURSOR';
CYCLE            : 'CYCLE';
DATE             : 'DATE';
DECLARE          : 'DECLARE';
DEFAULT          : 'DEFAULT';
DEFINER          : 'DEFINER';
DELETE           : 'DELETE';
DESC             : 'DESC';
DETERMINISTIC    : 'DETERMINISTIC';
DISTINCT         : 'DISTINCT';
DROP             : 'DROP';
EACH             : 'EACH';
EDITIONABLE      : 'EDITIONABLE';
EDITIONING       : 'EDITIONING';
ELSE             : 'ELSE';
ELSIF            : 'ELSIF';
EMPTY            : 'EMPTY';
END              : 'END';
ESCAPE           : 'ESCAPE';
EXCEPT           : 'EXCEPT';
EXCEPTION        : 'EXCEPTION';
EXCEPTIONS       : 'EXCEPTIONS';
EXECUTE          : 'EXECUTE';
EXISTS           : 'EXISTS';
EXIT             : 'EXIT';
EXPLAIN          : 'EXPLAIN';
EXTRACT          : 'EXTRACT';
FALSE            : 'FALSE';
FETCH            : 'FETCH';
FINAL            : 'FINAL';
FIRST            : 'FIRST';
FOLLOWING        : 'FOLLOWING';
FOR              : 'FOR';
FORALL           : 'FORALL';
FORCE            : 'FORCE';
FOREIGN          : 'FOREIGN';
FROM             : 'FROM';
FULL             : 'FULL';
FUNCTION         : 'FUNCTION';
GLOBAL           : 'GLOBAL';
GOTO             : 'GOTO';
GRANT            : 'GRANT';
GROUP            : 'GROUP';
GROUPING         : 'GROUPING';
HAVING           : 'HAVING';
IF               : 'IF';
IMMEDIATE        : 'IMMEDIATE';
IN               : 'IN';
INCREMENT        : 'INCREMENT';
INDEX            : 'INDEX';
INFINITE         : 'INFINITE';
INNER            : 'INNER';
INSERT           : 'INSERT';
INSTEAD          : 'INSTEAD';
INTERSECT        : 'INTERSECT';
INTERVAL         : 'INTERVAL';
INTO             : 'INTO';
IS               : 'IS';
JOIN             : 'JOIN';
KEEP             : 'KEEP';
KEY              : 'KEY';
LAST             : 'LAST';
LATERAL          : 'LATERAL';
LEADING          : 'LEADING';
LEFT             : 'LEFT';
LIKE             : 'LIKE';
LIKE2            : 'LIKE2';
LIKE4            : 'LIKE4';
LIKEC            : 'LIKEC';
LIMIT            : 'LIMIT';
LOCAL            : 'LOCAL';
LOCKED           : 'LOCKED';
LOOP             : 'LOOP';
MATCHED          : 'MATCHED';
MATERIALIZED     : 'MATERIALIZED';
MAXVALUE         : 'MAXVALUE';
MEMBER           : 'MEMBER';
MERGE            : 'MERGE';
MINUS            : 'MINUS';
MINVALUE         : 'MINVALUE';
MODIFY           : 'MODIFY';
MULTISET         : 'MULTISET';
NAN              : 'NAN';
NATURAL          : 'NATURAL';
NEXT             : 'NEXT';
NO               : 'NO';
NOCACHE          : 'NOCACHE';
NOCOPY           : 'NOCOPY';
NOCYCLE          : 'NOCYCLE';
NOMAXVALUE       : 'NOMAXVALUE';
NOMINVALUE       : 'NOMINVALUE';
NONEDITIONABLE   : 'NONEDITIONABLE';
NOORDER          : 'NOORDER';
NOT              : 'NOT';
NOWAIT           : 'NOWAIT';
NULL             : 'NULL';
NULLS            : 'NULLS';
OBJECT           : 'OBJECT';
OF               : 'OF';
OFFSET           : 'OFFSET';
ON               : 'ON';
ONLY             : 'ONLY';
OPEN             : 'OPEN';
OPTION           : 'OPTION';
OR               : 'OR';
ORDER            : 'ORDER';
OTHERS           : 'OTHERS';
OUT              : 'OUT';
OUTER            : 'OUTER';
OVER             : 'OVER';
PACKAGE          : 'PACKAGE';
PARALLEL_ENABLE  : 'PARALLEL_ENABLE';
PARTITION        : 'PARTITION';
PERCENT_KW       : 'PERCENT';
PIPE             : 'PIPE';
PIPELINED        : 'PIPELINED';
PLAN             : 'PLAN';
PRAGMA           : 'PRAGMA';
PRECEDING        : 'PRECEDING';
PRIMARY          : 'PRIMARY';
PRIOR            : 'PRIOR';
PRIVATE          : 'PRIVATE';
PRIVILEGES       : 'PRIVILEGES';
PROCEDURE        : 'PROCEDURE';
PUBLIC           : 'PUBLIC';
PURGE            : 'PURGE';
RAISE            : 'RAISE';
RANGE            : 'RANGE';
READ             : 'READ';
RECORD           : 'RECORD';
REF              : 'REF';
REFERENCES       : 'REFERENCES';
RENAME           : 'RENAME';
REPLACE          : 'REPLACE';
RESULT_CACHE     : 'RESULT_CACHE';
RETURN           : 'RETURN';
RETURNING        : 'RETURNING';
REVERSE          : 'REVERSE';
REVOKE           : 'REVOKE';
RIGHT            : 'RIGHT';
ROLLBACK         : 'ROLLBACK';
ROLLUP           : 'ROLLUP';
ROW              : 'ROW';
ROWS             : 'ROWS';
ROWTYPE          : 'ROWTYPE';
SAVE             : 'SAVE';
SAVEPOINT        : 'SAVEPOINT';
SCN              : 'SCN';
SELECT           : 'SELECT';
SEQUENCE         : 'SEQUENCE';
SESSION          : 'SESSION';
SET              : 'SET';
SETS             : 'SETS';
SIBLINGS         : 'SIBLINGS';
SKIP_            : 'SKIP';
SOME             : 'SOME';
START            : 'START';
STATEMENT_ID     : 'STATEMENT_ID';
STATIC           : 'STATIC';
SUBTYPE          : 'SUBTYPE';
SYNONYM          : 'SYNONYM';
TABLE            : 'TABLE';
TABLESPACE       : 'TABLESPACE';
TEMPORARY        : 'TEMPORARY';
THEN             : 'THEN';
TIES             : 'TIES';
TIME             : 'TIME';
TIMESTAMP        : 'TIMESTAMP';
TO               : 'TO';
TRAILING         : 'TRAILING';
TRIGGER          : 'TRIGGER';
TRIM             : 'TRIM';
TRUE             : 'TRUE';
TRUNCATE         : 'TRUNCATE';
TYPE             : 'TYPE';
UNBOUNDED        : 'UNBOUNDED';
UNION            : 'UNION';
UNIQUE           : 'UNIQUE';
UPDATE           : 'UPDATE';
USING            : 'USING';
VALUES           : 'VALUES';
VARRAY           : 'VARRAY';
VERSIONS         : 'VERSIONS';
VIEW             : 'VIEW';
WAIT             : 'WAIT';
WHEN             : 'WHEN';
WHERE            : 'WHERE';
WHILE            : 'WHILE';
WITH             : 'WITH';
WITHIN           : 'WITHIN';
WORK             : 'WORK';
ZONE             : 'ZONE';

// punctuation / operators
LPAREN    : '(';
RPAREN    : ')';
COMMA     : ',';
DOTDOT    : '..';
DOT       : '.';
SEMICOLON : ';';
ASSIGN    : ':=';
ARROW     : '=>';
CONCAT    : '||';
EXPONENT  : '**';
ASTERISK  : '*';
SLASH     : '/';
PERCENT   : '%';
PLUS      : '+';
MINUS_SIGN: '-';
AT_SIGN   : '@';
EQ        : '=';
NEQ       : '<>' | '!=' | '^=' | '~=';
LTE       : '<=';
GTE       : '>=';
LT        : '<';
GT        : '>';

// literals & identifiers
LABEL                 : '<<' (LETTER | '_') (LETTER | DIGIT | '_' | '$' | '#')* '>>' ;
STRING                : 'N'? '\'' ( ~'\'' | '\'\'' )* '\''
                      | 'N'? 'Q\'[' .*? ']\''
                      | 'N'? 'Q\'{' .*? '}\''
                      | 'N'? 'Q\'(' .*? ')\''
                      | 'N'? 'Q\'<' .*? '>\''
                      ;
DECIMAL_VALUE         : DIGIT+ '.' DIGIT+ EXPONENT_PART? | '.' DIGIT+ EXPONENT_PART? | DIGIT+ EXPONENT_PART ;
INTEGER_VALUE         : DIGIT+ ;
BIND_VARIABLE         : ':' ((LETTER | '_') (LETTER | DIGIT | '_' | '$' | '#')* | DIGIT+) ;
SUBSTITUTION_VARIABLE : '&' '&'? (LETTER | '_') (LETTER | DIGIT | '_' | '$' | '#')* ;
IDENTIFIER            : (LETTER | '_') (LETTER | DIGIT | '_' | '$' | '#')* ;
QUOTED_IDENTIFIER     : '"' ~'"'+ '"' ;

fragment EXPONENT_PART : 'E' [+-]? DIGIT+ ;
fragment DIGIT  : [0-9] ;
fragment LETTER : [A-Z] ;   // caseInsensitive option also matches a-z

LINE_COMMENT  : '--' ~[\r\n]* -> channel(HIDDEN) ;
BLOCK_COMMENT : '/*' .*? '*/' -> channel(HIDDEN) ;
WS            : [ \t\r\n]+ -> channel(HIDDEN) ;
