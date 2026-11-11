-- Run as bv_app against balancevault_test only.
-- Successful ledger rows are append-only and remain in the test database.
-- Requires at least two SYSTEM accounts provisioned by the owner-side setup.

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

\echo '=== SETUP: require and select two existing SYSTEM accounts ==='
DO $test$
BEGIN
  IF (
    SELECT count(*)
    FROM "Account"
    WHERE "kind" = 'SYSTEM'::"AccountKind"
  ) < 2 THEN
    RAISE EXCEPTION
      'FAIL: at least two owner-provisioned SYSTEM accounts are required in balancevault_test';
  END IF;
END
$test$;

SELECT "id"::text AS app_account_a
FROM "Account"
WHERE "kind" = 'SYSTEM'::"AccountKind"
ORDER BY "id"
LIMIT 1
\gset

SELECT "id"::text AS app_account_b
FROM "Account"
WHERE "kind" = 'SYSTEM'::"AccountKind"
ORDER BY "id"
OFFSET 1
LIMIT 1
\gset

SELECT gen_random_uuid()::text AS app_txid \gset
SELECT set_config('bv.c2.app_role_txid', :'app_txid', false);
SELECT set_config('bv.c2.app_role_account_a', :'app_account_a', false);
SELECT set_config('bv.c2.app_role_account_b', :'app_account_b', false);

\echo '=== T01 bv_app can post a balanced transaction in one database transaction ==='
BEGIN;

INSERT INTO "LedgerTransaction" ("id", "reference", "type")
VALUES (
  :'app_txid'::uuid,
  'C2-APP-ROLE-' || :'app_txid',
  'FUNDING'::"LedgerTransactionType"
);

INSERT INTO "LedgerEntry" ("transactionId", "accountId", "direction", "amountMinor")
VALUES (
  :'app_txid'::uuid,
  :'app_account_a'::uuid,
  'DEBIT'::"EntryDirection",
  1000
);

INSERT INTO "LedgerEntry" ("transactionId", "accountId", "direction", "amountMinor")
VALUES (
  :'app_txid'::uuid,
  :'app_account_b'::uuid,
  'CREDIT'::"EntryDirection",
  1000
);

COMMIT;
\echo 'PASS: bv_app committed the balanced header and two entries'

\echo '=== T02 bv_app cannot add a balanced pair after the posting transaction ends ==='
DO $test$
DECLARE
  v_txid uuid := current_setting('bv.c2.app_role_txid')::uuid;
  v_account_a uuid := current_setting('bv.c2.app_role_account_a')::uuid;
  v_account_b uuid := current_setting('bv.c2.app_role_account_b')::uuid;
  v_message text;
BEGIN
  BEGIN
    INSERT INTO "LedgerEntry" ("transactionId", "accountId", "direction", "amountMinor")
    VALUES
      (v_txid, v_account_a, 'DEBIT'::"EntryDirection", 1000),
      (v_txid, v_account_b, 'CREDIT'::"EntryDirection", 1000);

    RAISE EXCEPTION 'FAIL: late balanced entries were accepted';
  EXCEPTION WHEN restrict_violation THEN
    GET STACKED DIAGNOSTICS v_message = MESSAGE_TEXT;
    IF position('already posted' IN v_message) = 0 THEN
      RAISE EXCEPTION 'FAIL: late entries failed for an unexpected reason: %', v_message;
    END IF;
  END;

  RAISE NOTICE 'PASS: posting-window trigger rejected late entries';
END
$test$;

\echo '=== T03 bv_app cannot commit an unbalanced posting ==='
SELECT gen_random_uuid()::text AS app_unbalanced_txid \gset
SELECT set_config('bv.c2.app_role_unbalanced_txid', :'app_unbalanced_txid', false);

DO $test$
DECLARE
  v_txid uuid := current_setting('bv.c2.app_role_unbalanced_txid')::uuid;
  v_account_a uuid := current_setting('bv.c2.app_role_account_a')::uuid;
  v_account_b uuid := current_setting('bv.c2.app_role_account_b')::uuid;
  v_message text;
BEGIN
  BEGIN
    INSERT INTO "LedgerTransaction" ("id", "reference", "type")
    VALUES (
      v_txid,
      'C2-APP-ROLE-UNBALANCED-' || v_txid::text,
      'TRANSFER'::"LedgerTransactionType"
    );

    INSERT INTO "LedgerEntry" ("transactionId", "accountId", "direction", "amountMinor")
    VALUES
      (v_txid, v_account_a, 'DEBIT'::"EntryDirection", 1000),
      (v_txid, v_account_b, 'CREDIT'::"EntryDirection", 900);

    SET CONSTRAINTS ALL IMMEDIATE;
    RAISE EXCEPTION 'FAIL: unbalanced entries were accepted';
  EXCEPTION WHEN check_violation THEN
    GET STACKED DIAGNOSTICS v_message = MESSAGE_TEXT;
    IF position('is unbalanced' IN v_message) = 0 THEN
      RAISE EXCEPTION 'FAIL: unbalanced posting failed for an unexpected reason: %',
        v_message;
    END IF;
  END;

  RAISE NOTICE 'PASS: deferred balance check rejected unbalanced entries';
END
$test$;

\echo '=== T04-T07 UPDATE and DELETE of posted header and entries are denied ==='
DO $test$
DECLARE
  v_txid uuid := current_setting('bv.c2.app_role_txid')::uuid;
  v_entry_id bigint;
BEGIN
  SELECT "id"
    INTO v_entry_id
    FROM "LedgerEntry"
   WHERE "transactionId" = v_txid
   ORDER BY "id"
   LIMIT 1;

  IF v_entry_id IS NULL THEN
    RAISE EXCEPTION 'FAIL: initial posting has no entry to test';
  END IF;

  BEGIN
    UPDATE "LedgerTransaction"
       SET "postedTxid" = 'tampered'
     WHERE "id" = v_txid;
    RAISE EXCEPTION 'FAIL: UPDATE of postedTxid was accepted';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'PASS: UPDATE of postedTxid denied';
  END;

  BEGIN
    DELETE FROM "LedgerTransaction"
     WHERE "id" = v_txid;
    RAISE EXCEPTION 'FAIL: DELETE of posted LedgerTransaction was accepted';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'PASS: DELETE of posted LedgerTransaction denied';
  END;

  BEGIN
    UPDATE "LedgerEntry"
       SET "amountMinor" = 999
     WHERE "id" = v_entry_id;
    RAISE EXCEPTION 'FAIL: UPDATE of posted LedgerEntry was accepted';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'PASS: UPDATE of posted LedgerEntry denied';
  END;

  BEGIN
    DELETE FROM "LedgerEntry"
     WHERE "id" = v_entry_id;
    RAISE EXCEPTION 'FAIL: DELETE of posted LedgerEntry was accepted';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'PASS: DELETE of posted LedgerEntry denied';
  END;
END
$test$;

\echo '=== T08-T09 bv_app cannot truncate either ledger table ==='
DO $test$
BEGIN
  BEGIN
    TRUNCATE "LedgerTransaction";
    RAISE EXCEPTION 'FAIL: TRUNCATE of LedgerTransaction was accepted';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'PASS: TRUNCATE of LedgerTransaction denied';
  END;

  BEGIN
    TRUNCATE "LedgerEntry";
    RAISE EXCEPTION 'FAIL: TRUNCATE of LedgerEntry was accepted';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'PASS: TRUNCATE of LedgerEntry denied';
  END;
END
$test$;

\echo '=== T10-T11 bv_app cannot disable ledger triggers or bypass them ==='
DO $test$
BEGIN
  BEGIN
    ALTER TABLE "LedgerEntry" DISABLE TRIGGER ALL;
    RAISE EXCEPTION 'FAIL: bv_app disabled LedgerEntry triggers';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'PASS: disabling LedgerEntry triggers denied';
  END;

  BEGIN
    ALTER TABLE "LedgerTransaction" DISABLE TRIGGER ALL;
    RAISE EXCEPTION 'FAIL: bv_app disabled LedgerTransaction triggers';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'PASS: disabling LedgerTransaction triggers denied';
  END;

  BEGIN
    SET LOCAL session_replication_role = replica;
    RAISE EXCEPTION 'FAIL: bv_app changed session_replication_role';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'PASS: changing session_replication_role denied';
  END;
END
$test$;

\echo '=== T12 trigger inventory: EXPECT 8 non-internal triggers, all ALWAYS enabled ==='
SELECT c.relname AS table_name, t.tgname AS trigger_name, t.tgenabled
FROM pg_trigger AS t
JOIN pg_class AS c ON c.oid = t.tgrelid
JOIN pg_namespace AS n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN ('LedgerEntry', 'LedgerTransaction')
  AND NOT t.tgisinternal
ORDER BY c.relname, t.tgname;

DO $test$
DECLARE
  v_trigger_count bigint;
  v_all_always_enabled boolean;
BEGIN
  SELECT count(*), COALESCE(bool_and(t.tgenabled = 'A'), false)
    INTO v_trigger_count, v_all_always_enabled
    FROM pg_trigger AS t
    JOIN pg_class AS c ON c.oid = t.tgrelid
    JOIN pg_namespace AS n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public'
     AND c.relname IN ('LedgerEntry', 'LedgerTransaction')
     AND NOT t.tgisinternal;

  IF v_trigger_count <> 8 OR NOT v_all_always_enabled THEN
    RAISE EXCEPTION
      'FAIL: expected 8 non-internal ledger triggers all enabled ALWAYS; found % triggers, all_always_enabled=%',
      v_trigger_count, v_all_always_enabled;
  END IF;

  RAISE NOTICE 'PASS: all 8 non-internal ledger triggers remain enabled ALWAYS';
END
$test$;

RESET bv.c2.app_role_txid;
RESET bv.c2.app_role_account_a;
RESET bv.c2.app_role_account_b;
RESET bv.c2.app_role_unbalanced_txid;

\echo '=== DONE: successful append-only posting remains in balancevault_test ==='
