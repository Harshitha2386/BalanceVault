-- Run as bv_app against balancevault_test only.
-- All test rows are rolled back; no committed ledger rows are created.

\set ON_ERROR_STOP on

\echo '=== SAFETY: require balancevault_test and bv_app ==='
DO $test$
BEGIN
  IF current_database() <> 'balancevault_test' THEN
    RAISE EXCEPTION 'FAIL: this test must run against balancevault_test, not %',
      current_database();
  END IF;

  IF current_user <> 'bv_app' THEN
    RAISE EXCEPTION 'FAIL: this test must run as bv_app, not %', current_user;
  END IF;
END
$test$;

\echo '=== G01-G04: exact effective UPDATE column grants and no table-level UPDATE ==='
DO $test$
DECLARE
  v_table name;
  v_expected text[];
  v_actual text[];
BEGIN
  FOR v_table, v_expected IN
    SELECT *
    FROM (VALUES
      ('User'::name, ARRAY[
        'failedLoginCount', 'fullName', 'lockedUntil', 'mustChangePassword',
        'passwordHash', 'status', 'updatedAt'
      ]::text[]),
      ('Account'::name, ARRAY[
        'status', 'updatedAt'
      ]::text[]),
      ('Session'::name, ARRAY[
        'lastSeenAt', 'revokedAt'
      ]::text[]),
      ('OnboardingApplication'::name, ARRAY[
        'reviewNote', 'reviewedAt', 'reviewedById', 'status', 'updatedAt'
      ]::text[])
    ) AS expected(table_name, column_names)
  LOOP
    SELECT COALESCE(
             array_agg(a.attname::text ORDER BY a.attname::text COLLATE "C"),
             ARRAY[]::text[]
           )
      INTO v_actual
      FROM pg_attribute AS a
     WHERE a.attrelid = format('public.%I', v_table)::regclass
       AND a.attnum > 0
       AND NOT a.attisdropped
       AND has_column_privilege(
         'bv_app',
         format('public.%I', v_table),
         a.attname::text,
         'UPDATE'
       );

    IF v_actual <> v_expected THEN
      RAISE EXCEPTION
        'FAIL: % effective UPDATE columns differ; expected %, got %',
        v_table, v_expected, v_actual;
    END IF;

    IF has_table_privilege('bv_app', format('public.%I', v_table), 'UPDATE') THEN
      RAISE EXCEPTION 'FAIL: bv_app has table-level UPDATE on %', v_table;
    END IF;

    RAISE NOTICE 'PASS: % UPDATE columns exactly %, with no table-level UPDATE',
      v_table, v_expected;
  END LOOP;
END
$test$;

\echo '=== G05-G08: exact column-level INSERT grants where configured ==='
DO $test$
DECLARE
  v_table name;
  v_expected text[];
  v_actual text[];
BEGIN
  FOR v_table, v_expected IN
    SELECT *
    FROM (VALUES
      ('User'::name, ARRAY[
        'email', 'fullName', 'id', 'passwordHash', 'updatedAt'
      ]::text[]),
      ('Account'::name, ARRAY[
        'accountNumber', 'currency', 'id', 'ownerId', 'updatedAt'
      ]::text[]),
      ('OnboardingApplication'::name, ARRAY[
        'addressLine', 'city', 'country', 'dateOfBirth', 'id',
        'legalName', 'phone', 'updatedAt', 'userId'
      ]::text[])
    ) AS expected(table_name, column_names)
  LOOP
    SELECT COALESCE(
             array_agg(a.attname::text ORDER BY a.attname::text COLLATE "C"),
             ARRAY[]::text[]
           )
      INTO v_actual
      FROM pg_attribute AS a
     WHERE a.attrelid = format('public.%I', v_table)::regclass
       AND a.attnum > 0
       AND NOT a.attisdropped
       AND has_column_privilege(
         'bv_app',
         format('public.%I', v_table),
         a.attname::text,
         'INSERT'
       );

    IF v_actual <> v_expected THEN
      RAISE EXCEPTION
        'FAIL: % effective INSERT columns differ; expected %, got %',
        v_table, v_expected, v_actual;
    END IF;

    IF has_table_privilege('bv_app', format('public.%I', v_table), 'INSERT') THEN
      RAISE EXCEPTION 'FAIL: bv_app has table-level INSERT on %', v_table;
    END IF;

    RAISE NOTICE 'PASS: % INSERT columns exactly %, with no table-level INSERT',
      v_table, v_expected;
  END LOOP;

  IF NOT has_table_privilege('bv_app', 'public."Session"', 'INSERT') THEN
    RAISE EXCEPTION 'FAIL: expected table-level INSERT on Session';
  END IF;

  RAISE NOTICE 'PASS: Session uses the intended table-level INSERT grant';
END
$test$;

\echo '=== G09-G12: ledger and audit mutation privileges are absent ==='
DO $test$
DECLARE
  v_table name;
  v_column name;
BEGIN
  FOREACH v_table IN ARRAY ARRAY[
    'LedgerTransaction'::name,
    'LedgerEntry'::name,
    'AuditLog'::name
  ]
  LOOP
    IF has_table_privilege('bv_app', format('public.%I', v_table), 'UPDATE')
       OR has_table_privilege('bv_app', format('public.%I', v_table), 'DELETE')
       OR has_table_privilege('bv_app', format('public.%I', v_table), 'TRUNCATE') THEN
      RAISE EXCEPTION
        'FAIL: bv_app has UPDATE, DELETE, or TRUNCATE on %', v_table;
    END IF;

    FOR v_column IN
      SELECT a.attname
        FROM pg_attribute AS a
       WHERE a.attrelid = format('public.%I', v_table)::regclass
         AND a.attnum > 0
         AND NOT a.attisdropped
       ORDER BY a.attname
    LOOP
      IF has_column_privilege(
        'bv_app',
        format('public.%I', v_table),
        v_column::text,
        'UPDATE'
      ) THEN
        RAISE EXCEPTION
          'FAIL: bv_app has effective UPDATE privilege on %.%',
          v_table, v_column;
      END IF;
    END LOOP;

    RAISE NOTICE 'PASS: no effective UPDATE privilege on any column of %', v_table;
  END LOOP;

  RAISE NOTICE 'PASS: ledger and audit tables grant no UPDATE, DELETE, or TRUNCATE';

  IF NOT has_table_privilege('bv_app', 'public."LedgerTransaction"', 'INSERT')
     OR NOT has_table_privilege('bv_app', 'public."LedgerEntry"', 'INSERT')
     OR NOT has_table_privilege('bv_app', 'public."AuditLog"', 'INSERT') THEN
    RAISE EXCEPTION 'FAIL: expected append-only INSERT grants are missing';
  END IF;

  RAISE NOTICE 'PASS: expected append-only ledger/audit INSERT grants are present';
END
$test$;

\echo '=== DML setup: synthetic rows for allowed and denied column checks ==='
BEGIN;

SELECT gen_random_uuid()::text AS c3_user_id \gset
SELECT gen_random_uuid()::text AS c3_account_id \gset
SELECT gen_random_uuid()::text AS c3_session_id \gset
SELECT gen_random_uuid()::text AS c3_application_id \gset
SELECT gen_random_uuid()::text AS c3_transaction_id \gset
SELECT gen_random_uuid()::text AS c3_audit_request_id \gset

SELECT set_config('bv.c3.user_id', :'c3_user_id', false);
SELECT set_config('bv.c3.account_id', :'c3_account_id', false);
SELECT set_config('bv.c3.session_id', :'c3_session_id', false);
SELECT set_config('bv.c3.application_id', :'c3_application_id', false);
SELECT set_config('bv.c3.transaction_id', :'c3_transaction_id', false);
SELECT set_config('bv.c3.audit_request_id', :'c3_audit_request_id', false);

\echo '=== D01 insert normal user succeeds; approved fullName/status updates succeed ==='
INSERT INTO "User" ("id", "email", "fullName", "passwordHash", "updatedAt")
VALUES (
  :'c3_user_id'::uuid,
  'grant-test-' || :'c3_user_id' || '@example.test',
  'Synthetic Grant Test',
  'not-a-real-hash',
  now()
);

UPDATE "User"
   SET "fullName" = 'Synthetic Updated Name',
       "status" = 'DISABLED'::"UserStatus",
       "updatedAt" = now()
 WHERE "id" = :'c3_user_id'::uuid;

INSERT INTO "Account" ("id", "accountNumber", "ownerId", "updatedAt")
VALUES (
  :'c3_account_id'::uuid,
  'C3-' || :'c3_account_id',
  :'c3_user_id'::uuid,
  now()
);

UPDATE "Account"
   SET "status" = 'FROZEN'::"AccountStatus",
       "updatedAt" = now()
 WHERE "id" = :'c3_account_id'::uuid;

INSERT INTO "OnboardingApplication" (
  "id", "userId", "legalName", "dateOfBirth", "phone",
  "addressLine", "city", "country", "updatedAt"
)
VALUES (
  :'c3_application_id'::uuid,
  :'c3_user_id'::uuid,
  'Synthetic Grant Applicant',
  DATE '2000-01-01',
  '0000000000',
  'Synthetic Test Address',
  'Test City',
  'IN',
  now()
);

UPDATE "OnboardingApplication"
   SET "status" = 'APPROVED'::"ApplicationStatus",
       "reviewedById" = :'c3_user_id'::uuid,
       "reviewedAt" = now(),
       "reviewNote" = 'Synthetic grant test',
       "updatedAt" = now()
 WHERE "id" = :'c3_application_id'::uuid;

INSERT INTO "Session" ("id", "tokenHash", "userId", "expiresAt")
VALUES (
  :'c3_session_id'::uuid,
  'synthetic-test-hash-' || :'c3_session_id',
  :'c3_user_id'::uuid,
  now() + interval '1 hour'
);

UPDATE "Session"
   SET "lastSeenAt" = now(),
       "revokedAt" = now()
 WHERE "id" = :'c3_session_id'::uuid;

\echo 'PASS: allowed User, Account, OnboardingApplication, and Session inserts/updates succeeded'

\echo '=== D02-D08: protected User, Account, and Session columns reject writes ==='
DO $test$
DECLARE
  v_user_id uuid := current_setting('bv.c3.user_id')::uuid;
  v_account_id uuid := current_setting('bv.c3.account_id')::uuid;
  v_email text;
  v_rejected boolean;
BEGIN
  SELECT "email" INTO v_email FROM "User" WHERE "id" = v_user_id;

  v_rejected := false;
  BEGIN
    INSERT INTO "User" ("id", "email", "fullName", "passwordHash", "role", "updatedAt")
    VALUES (
      gen_random_uuid(),
      'admin-grant-test-' || gen_random_uuid()::text || '@example.test',
      'Synthetic Admin Attempt',
      'not-a-real-hash',
      'ADMIN'::"Role",
      now()
    );
  EXCEPTION WHEN insufficient_privilege THEN
    v_rejected := true;
  END;
  IF NOT v_rejected THEN
    RAISE EXCEPTION 'FAIL: INSERT of User.role was accepted';
  END IF;
  RAISE NOTICE 'PASS: INSERT of User.role denied';

  v_rejected := false;
  BEGIN
    UPDATE "User" SET "role" = 'ADMIN'::"Role" WHERE "id" = v_user_id;
  EXCEPTION WHEN insufficient_privilege THEN
    v_rejected := true;
  END;
  IF NOT v_rejected THEN
    RAISE EXCEPTION 'FAIL: UPDATE of User.role was accepted';
  END IF;
  RAISE NOTICE 'PASS: UPDATE of User.role denied';

  v_rejected := false;
  BEGIN
    UPDATE "User" SET "email" = 'changed-' || v_email WHERE "id" = v_user_id;
  EXCEPTION WHEN insufficient_privilege THEN
    v_rejected := true;
  END;
  IF NOT v_rejected THEN
    RAISE EXCEPTION 'FAIL: UPDATE of User.email was accepted';
  END IF;
  RAISE NOTICE 'PASS: UPDATE of User.email denied';

  v_rejected := false;
  BEGIN
    INSERT INTO "Account" ("id", "accountNumber", "kind", "updatedAt")
    VALUES (
      gen_random_uuid(),
      'C3-SYSTEM-' || gen_random_uuid()::text,
      'SYSTEM'::"AccountKind",
      now()
    );
  EXCEPTION WHEN insufficient_privilege THEN
    v_rejected := true;
  END;
  IF NOT v_rejected THEN
    RAISE EXCEPTION 'FAIL: INSERT of Account.kind/SYSTEM was accepted';
  END IF;
  RAISE NOTICE 'PASS: INSERT of Account.kind/SYSTEM denied';

  v_rejected := false;
  BEGIN
    INSERT INTO "Account" (
      "id", "accountNumber", "ownerId", "balanceMinor", "updatedAt"
    )
    VALUES (
      gen_random_uuid(),
      'C3-BALANCE-' || gen_random_uuid()::text,
      v_user_id,
      1,
      now()
    );
  EXCEPTION WHEN insufficient_privilege THEN
    v_rejected := true;
  END;
  IF NOT v_rejected THEN
    RAISE EXCEPTION 'FAIL: INSERT of Account.balanceMinor was accepted';
  END IF;
  RAISE NOTICE 'PASS: INSERT of Account.balanceMinor denied';

  v_rejected := false;
  BEGIN
    UPDATE "Account" SET "kind" = 'SYSTEM'::"AccountKind"
     WHERE "id" = v_account_id;
  EXCEPTION WHEN insufficient_privilege THEN
    v_rejected := true;
  END;
  IF NOT v_rejected THEN
    RAISE EXCEPTION 'FAIL: UPDATE of Account.kind was accepted';
  END IF;
  RAISE NOTICE 'PASS: UPDATE of Account.kind denied';

  v_rejected := false;
  BEGIN
    UPDATE "Account" SET "balanceMinor" = 1 WHERE "id" = v_account_id;
  EXCEPTION WHEN insufficient_privilege THEN
    v_rejected := true;
  END;
  IF NOT v_rejected THEN
    RAISE EXCEPTION 'FAIL: UPDATE of Account.balanceMinor was accepted';
  END IF;
  RAISE NOTICE 'PASS: UPDATE of Account.balanceMinor denied';

  v_rejected := false;
  BEGIN
    UPDATE "Session"
       SET "expiresAt" = now() + interval '2 hours'
     WHERE "id" = current_setting('bv.c3.session_id')::uuid;
  EXCEPTION WHEN insufficient_privilege THEN
    v_rejected := true;
  END;
  IF NOT v_rejected THEN
    RAISE EXCEPTION 'FAIL: UPDATE of Session.expiresAt was accepted';
  END IF;
  RAISE NOTICE 'PASS: UPDATE of Session.expiresAt denied';
END
$test$;

\echo '=== D09-D14: ledger and audit rows are insert-only for bv_app ==='
INSERT INTO "LedgerTransaction" ("id", "reference", "type")
VALUES (
  :'c3_transaction_id'::uuid,
  'C3-LEDGER-' || :'c3_transaction_id',
  'FUNDING'::"LedgerTransactionType"
);

INSERT INTO "LedgerEntry" ("transactionId", "accountId", "direction", "amountMinor")
VALUES
  (
    :'c3_transaction_id'::uuid,
    :'c3_account_id'::uuid,
    'DEBIT'::"EntryDirection",
    25
  ),
  (
    :'c3_transaction_id'::uuid,
    :'c3_account_id'::uuid,
    'CREDIT'::"EntryDirection",
    25
  );

INSERT INTO "AuditLog" ("action", "outcome", "requestId")
VALUES (
  'C3_SYNTHETIC_GRANT_TEST',
  'SUCCESS'::"AuditOutcome",
  :'c3_audit_request_id'
);

SET CONSTRAINTS ALL IMMEDIATE;

DO $test$
DECLARE
  v_transaction_id uuid := current_setting('bv.c3.transaction_id')::uuid;
  v_entry_id bigint;
  v_audit_id bigint;
  v_request_id text := current_setting('bv.c3.audit_request_id');
  v_rejected boolean;
BEGIN
  SELECT "id" INTO v_entry_id
    FROM "LedgerEntry"
   WHERE "transactionId" = v_transaction_id
   ORDER BY "id"
   LIMIT 1;

  SELECT "id" INTO v_audit_id
    FROM "AuditLog"
   WHERE "requestId" = v_request_id
     AND "action" = 'C3_SYNTHETIC_GRANT_TEST';

  IF v_entry_id IS NULL OR v_audit_id IS NULL THEN
    RAISE EXCEPTION 'FAIL: synthetic ledger/audit rows were not inserted';
  END IF;

  v_rejected := false;
  BEGIN
    UPDATE "LedgerTransaction" SET "reference" = 'tampered'
     WHERE "id" = v_transaction_id;
  EXCEPTION WHEN insufficient_privilege THEN
    v_rejected := true;
  END;
  IF NOT v_rejected THEN
    RAISE EXCEPTION 'FAIL: UPDATE of LedgerTransaction was accepted';
  END IF;
  RAISE NOTICE 'PASS: UPDATE of LedgerTransaction denied';

  v_rejected := false;
  BEGIN
    DELETE FROM "LedgerTransaction" WHERE "id" = v_transaction_id;
  EXCEPTION WHEN insufficient_privilege THEN
    v_rejected := true;
  END;
  IF NOT v_rejected THEN
    RAISE EXCEPTION 'FAIL: DELETE of LedgerTransaction was accepted';
  END IF;
  RAISE NOTICE 'PASS: DELETE of LedgerTransaction denied';

  v_rejected := false;
  BEGIN
    UPDATE "LedgerEntry" SET "amountMinor" = 26 WHERE "id" = v_entry_id;
  EXCEPTION WHEN insufficient_privilege THEN
    v_rejected := true;
  END;
  IF NOT v_rejected THEN
    RAISE EXCEPTION 'FAIL: UPDATE of LedgerEntry was accepted';
  END IF;
  RAISE NOTICE 'PASS: UPDATE of LedgerEntry denied';

  v_rejected := false;
  BEGIN
    DELETE FROM "LedgerEntry" WHERE "id" = v_entry_id;
  EXCEPTION WHEN insufficient_privilege THEN
    v_rejected := true;
  END;
  IF NOT v_rejected THEN
    RAISE EXCEPTION 'FAIL: DELETE of LedgerEntry was accepted';
  END IF;
  RAISE NOTICE 'PASS: DELETE of LedgerEntry denied';

  v_rejected := false;
  BEGIN
    UPDATE "AuditLog" SET "action" = 'TAMPERED' WHERE "id" = v_audit_id;
  EXCEPTION WHEN insufficient_privilege THEN
    v_rejected := true;
  END;
  IF NOT v_rejected THEN
    RAISE EXCEPTION 'FAIL: UPDATE of AuditLog was accepted';
  END IF;
  RAISE NOTICE 'PASS: UPDATE of AuditLog denied';

  v_rejected := false;
  BEGIN
    DELETE FROM "AuditLog" WHERE "id" = v_audit_id;
  EXCEPTION WHEN insufficient_privilege THEN
    v_rejected := true;
  END;
  IF NOT v_rejected THEN
    RAISE EXCEPTION 'FAIL: DELETE of AuditLog was accepted';
  END IF;
  RAISE NOTICE 'PASS: DELETE of AuditLog denied';

  v_rejected := false;
  BEGIN
    TRUNCATE "LedgerTransaction";
  EXCEPTION WHEN insufficient_privilege THEN
    v_rejected := true;
  END;
  IF NOT v_rejected THEN
    RAISE EXCEPTION 'FAIL: TRUNCATE of LedgerTransaction was accepted';
  END IF;
  RAISE NOTICE 'PASS: TRUNCATE of LedgerTransaction denied';

  v_rejected := false;
  BEGIN
    TRUNCATE "LedgerEntry";
  EXCEPTION WHEN insufficient_privilege THEN
    v_rejected := true;
  END;
  IF NOT v_rejected THEN
    RAISE EXCEPTION 'FAIL: TRUNCATE of LedgerEntry was accepted';
  END IF;
  RAISE NOTICE 'PASS: TRUNCATE of LedgerEntry denied';

  v_rejected := false;
  BEGIN
    TRUNCATE "AuditLog";
  EXCEPTION WHEN insufficient_privilege THEN
    v_rejected := true;
  END;
  IF NOT v_rejected THEN
    RAISE EXCEPTION 'FAIL: TRUNCATE of AuditLog was accepted';
  END IF;
  RAISE NOTICE 'PASS: TRUNCATE of AuditLog denied';
END
$test$;

\echo '=== CLEANUP: roll back all synthetic test rows ==='
ROLLBACK;
\echo 'PASS: all DML test data was rolled back'
