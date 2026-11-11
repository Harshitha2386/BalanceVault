-- Run as the table owner (postgres). Everything is rolled back at the end.
-- Each test sits in a SAVEPOINT so an expected error doesn't abort the rest.

\echo '=== SETUP ==='
BEGIN;
SET CONSTRAINTS ALL DEFERRED;

INSERT INTO "User" ("id","email","fullName","passwordHash","updatedAt") VALUES
 ('00000000-0000-0000-0000-0000000000a1','user1@example.test','Test One','not-a-real-hash',now()),
 ('00000000-0000-0000-0000-0000000000a2','user2@example.test','Test Two','not-a-real-hash',now());

INSERT INTO "Account" ("id","accountNumber","kind","balanceMinor","updatedAt") VALUES
 ('00000000-0000-0000-0000-0000000000b1','TEST-SYS-1','SYSTEM',0,now()),
 ('00000000-0000-0000-0000-0000000000b2','TEST-SYS-2','SYSTEM',0,now());

INSERT INTO "Account" ("id","accountNumber","kind","balanceMinor","ownerId","updatedAt") VALUES
 ('00000000-0000-0000-0000-0000000000c1','TEST-CUST-1','CUSTOMER',0,'00000000-0000-0000-0000-0000000000a1',now());

\echo '=== T01 customer balance below zero. EXPECT ERROR: Account_customer_balance_non_negative'
SAVEPOINT t;
UPDATE "Account" SET "balanceMinor" = -1 WHERE "id" = '00000000-0000-0000-0000-0000000000c1';
ROLLBACK TO t;

\echo '=== T02 SYSTEM balance below zero is allowed. EXPECT UPDATE 1'
UPDATE "Account" SET "balanceMinor" = -5000 WHERE "id" = '00000000-0000-0000-0000-0000000000b1';

\echo '=== T03 CUSTOMER with no owner. EXPECT ERROR: Account_owner_matches_kind'
SAVEPOINT t;
INSERT INTO "Account" ("id","accountNumber","kind","updatedAt")
VALUES ('00000000-0000-0000-0000-0000000000c2','TEST-CUST-2','CUSTOMER',now());
ROLLBACK TO t;

\echo '=== T04 SYSTEM with an owner. EXPECT ERROR: Account_owner_matches_kind'
SAVEPOINT t;
INSERT INTO "Account" ("id","accountNumber","kind","ownerId","updatedAt")
VALUES ('00000000-0000-0000-0000-0000000000c3','TEST-SYS-3','SYSTEM','00000000-0000-0000-0000-0000000000a2',now());
ROLLBACK TO t;

\echo '=== T05 uppercase email. EXPECT ERROR: User_email_lowercase'
SAVEPOINT t;
INSERT INTO "User" ("id","email","fullName","passwordHash","updatedAt")
VALUES ('00000000-0000-0000-0000-0000000000a3','Upper@Example.test','X','x',now());
ROLLBACK TO t;

\echo '=== T06 ledger entry with amount 0. EXPECT ERROR: LedgerEntry_amount_positive'
SAVEPOINT t;
INSERT INTO "LedgerTransaction" ("id","reference","type")
VALUES ('00000000-0000-0000-0000-0000000000d1','TEST-TX-1','FUNDING');
INSERT INTO "LedgerEntry" ("transactionId","accountId","direction","amountMinor")
VALUES ('00000000-0000-0000-0000-0000000000d1','00000000-0000-0000-0000-0000000000b1','DEBIT',0);
ROLLBACK TO t;

\echo '=== T07 unbalanced transaction (debit 1000, credit 900). EXPECT ERROR: unbalanced'
SAVEPOINT t;
SET CONSTRAINTS ALL DEFERRED;
INSERT INTO "LedgerTransaction" ("id","reference","type")
VALUES ('00000000-0000-0000-0000-0000000000d2','TEST-TX-2','TRANSFER');
INSERT INTO "LedgerEntry" ("transactionId","accountId","direction","amountMinor") VALUES
 ('00000000-0000-0000-0000-0000000000d2','00000000-0000-0000-0000-0000000000b1','DEBIT',1000),
 ('00000000-0000-0000-0000-0000000000d2','00000000-0000-0000-0000-0000000000b2','CREDIT',900);
SET CONSTRAINTS ALL IMMEDIATE;
ROLLBACK TO t;

\echo '=== T08 transaction header with no entries. EXPECT ERROR: needs at least 2 entries'
SAVEPOINT t;
SET CONSTRAINTS ALL DEFERRED;
INSERT INTO "LedgerTransaction" ("id","reference","type")
VALUES ('00000000-0000-0000-0000-0000000000d3','TEST-TX-3','TRANSFER');
SET CONSTRAINTS ALL IMMEDIATE;
ROLLBACK TO t;

\echo '=== T09 balanced transaction (debit 500, credit 500). EXPECT no error'
SET CONSTRAINTS ALL DEFERRED;
INSERT INTO "LedgerTransaction" ("id","reference","type")
VALUES ('00000000-0000-0000-0000-0000000000d4','TEST-TX-4','TRANSFER');
INSERT INTO "LedgerEntry" ("transactionId","accountId","direction","amountMinor") VALUES
 ('00000000-0000-0000-0000-0000000000d4','00000000-0000-0000-0000-0000000000b1','DEBIT',500),
 ('00000000-0000-0000-0000-0000000000d4','00000000-0000-0000-0000-0000000000b2','CREDIT',500);
SET CONSTRAINTS ALL IMMEDIATE;
SET CONSTRAINTS ALL DEFERRED;

\echo '=== T10 UPDATE a ledger entry. EXPECT ERROR: append-only'
SAVEPOINT t;
UPDATE "LedgerEntry" SET "amountMinor" = 999 WHERE "transactionId" = '00000000-0000-0000-0000-0000000000d4';
ROLLBACK TO t;

\echo '=== T11 DELETE a ledger entry. EXPECT ERROR: append-only'
SAVEPOINT t;
DELETE FROM "LedgerEntry" WHERE "transactionId" = '00000000-0000-0000-0000-0000000000d4';
ROLLBACK TO t;

\echo '=== T12 TRUNCATE ledger entries. EXPECT ERROR: append-only'
SAVEPOINT t;
TRUNCATE "LedgerEntry";
ROLLBACK TO t;

\echo '=== T13 UPDATE a ledger transaction header. EXPECT ERROR: append-only'
SAVEPOINT t;
UPDATE "LedgerTransaction" SET "reference" = 'TAMPERED' WHERE "id" = '00000000-0000-0000-0000-0000000000d4';
ROLLBACK TO t;

\echo '=== T14 DELETE a ledger transaction header. EXPECT ERROR: append-only'
SAVEPOINT t;
DELETE FROM "LedgerTransaction" WHERE "id" = '00000000-0000-0000-0000-0000000000d4';
ROLLBACK TO t;

\echo '=== T15 INSERT an audit row. EXPECT INSERT 0 1'
INSERT INTO "AuditLog" ("action","outcome","requestId") VALUES ('TEST_ACTION','SUCCESS','test-request-1');

\echo '=== T16 UPDATE an audit row. EXPECT ERROR: append-only'
SAVEPOINT t;
UPDATE "AuditLog" SET "action" = 'TAMPERED';
ROLLBACK TO t;

\echo '=== T17 DELETE an audit row. EXPECT ERROR: append-only'
SAVEPOINT t;
DELETE FROM "AuditLog";
ROLLBACK TO t;

\echo '=== T18 TRUNCATE the audit log. EXPECT ERROR: append-only'
SAVEPOINT t;
TRUNCATE "AuditLog";
ROLLBACK TO t;

\echo '=== CLEANUP: roll everything back ==='
ROLLBACK;

\echo '=== After rollback: all counts should be 0 (assuming an empty dev database) ==='
SELECT (SELECT count(*) FROM "User")        AS users,
       (SELECT count(*) FROM "Account")     AS accounts,
       (SELECT count(*) FROM "LedgerEntry") AS entries,
       (SELECT count(*) FROM "AuditLog")    AS audit_rows;

\echo '=== Sequence check: rows are 0, but the sequence still advanced ==='
SELECT last_value, is_called FROM "AuditLog_id_seq";