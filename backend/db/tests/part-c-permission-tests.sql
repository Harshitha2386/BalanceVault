-- Run as bv_app. Everything is rolled back at the end, even if something
-- unexpectedly succeeds.
\echo '=== Identity. EXPECT current_user = bv_app, is_superuser = f ==='
SELECT current_user,
       (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS is_superuser;

BEGIN;

\echo '=== P01 (positive control) read accounts. EXPECT a count ==='
SELECT count(*) FROM "Account";

\echo '=== P02 (positive control) row lock, needed for transfers. EXPECT 0 rows, no error ==='
SELECT "id" FROM "Account" FOR UPDATE;

\echo '=== P03 (positive control) insert an audit row. EXPECT INSERT 0 1 ==='
INSERT INTO "AuditLog" ("action","outcome","requestId") VALUES ('PERM_TEST','SUCCESS','perm-test-1');

\echo '=== P04 UPDATE ledger entries. EXPECT permission denied for table LedgerEntry ==='
SAVEPOINT t; UPDATE "LedgerEntry" SET "amountMinor" = 1; ROLLBACK TO t;

\echo '=== P05 DELETE ledger entries. EXPECT permission denied for table LedgerEntry ==='
SAVEPOINT t; DELETE FROM "LedgerEntry"; ROLLBACK TO t;

\echo '=== P06 UPDATE the audit log. EXPECT permission denied for table AuditLog ==='
SAVEPOINT t; UPDATE "AuditLog" SET "action" = 'X'; ROLLBACK TO t;

\echo '=== P07 DELETE the audit log. EXPECT permission denied for table AuditLog ==='
SAVEPOINT t; DELETE FROM "AuditLog"; ROLLBACK TO t;

\echo '=== P08 TRUNCATE the audit log. EXPECT permission denied for table AuditLog ==='
SAVEPOINT t; TRUNCATE "AuditLog"; ROLLBACK TO t;

\echo '=== P09 DELETE accounts. EXPECT permission denied for table Account ==='
SAVEPOINT t; DELETE FROM "Account"; ROLLBACK TO t;

\echo '=== P10 DROP the ledger table. EXPECT must be owner of table LedgerEntry ==='
SAVEPOINT t; DROP TABLE "LedgerEntry"; ROLLBACK TO t;

\echo '=== P11 DISABLE triggers. EXPECT must be owner of table LedgerEntry ==='
SAVEPOINT t; ALTER TABLE "LedgerEntry" DISABLE TRIGGER ALL; ROLLBACK TO t;

\echo '=== P12 DROP the append-only trigger. EXPECT must be owner of table LedgerEntry ==='
SAVEPOINT t; DROP TRIGGER "LedgerEntry_append_only_row" ON "LedgerEntry"; ROLLBACK TO t;

\echo '=== P13 CREATE a table. EXPECT permission denied for schema public ==='
SAVEPOINT t; CREATE TABLE evil_table (id int); ROLLBACK TO t;

\echo '=== P14 turn triggers off for the session. EXPECT permission denied to set parameter ==='
SAVEPOINT t; SET session_replication_role = replica; ROLLBACK TO t;

\echo '=== P15 read Prisma migration history. EXPECT permission denied for table _prisma_migrations ==='
SAVEPOINT t; SELECT * FROM _prisma_migrations; ROLLBACK TO t;

\echo '=== P16 create a superuser role. EXPECT permission denied to create role ==='
SAVEPOINT t; CREATE ROLE evil_role SUPERUSER; ROLLBACK TO t;

ROLLBACK;