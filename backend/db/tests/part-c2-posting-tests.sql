-- Run as postgres against balancevault_test only.
-- Successful ledger postings are append-only and remain in the test database.
-- This script creates three committed test transactions and three SYSTEM
-- accounts. Expected failures are caught or rolled back.

\set ON_ERROR_STOP on

\echo '=== SAFETY: require balancevault_test and postgres before any writes ==='
DO $test$
BEGIN
  IF current_database() <> 'balancevault_test' THEN
    RAISE EXCEPTION
      'FAIL: this test must run against balancevault_test, not %',
      current_database();
  END IF;

  IF current_user <> 'postgres' THEN
    RAISE EXCEPTION 'FAIL: this test must run as postgres, not %', current_user;
  END IF;
END
$test$;

\echo '=== SETUP: generate isolated synthetic test IDs ==='
CREATE TEMP TABLE bv_c2_posting_ids ON COMMIT PRESERVE ROWS AS
SELECT
  gen_random_uuid() AS account_a,
  gen_random_uuid() AS account_b,
  gen_random_uuid() AS account_c,
  gen_random_uuid() AS tx_initial,
  gen_random_uuid() AS tx_unbalanced,
  gen_random_uuid() AS tx_empty_header,
  gen_random_uuid() AS tx_missing_header,
  gen_random_uuid() AS tx_rolled_back_header,
  gen_random_uuid() AS tx_savepoint,
  gen_random_uuid() AS tx_three_leg;

\echo '=== T01 initial posting: header plus two entries; forged postedTxid is overridden ==='
BEGIN;

INSERT INTO "Account" ("id", "accountNumber", "kind", "updatedAt")
SELECT account_a, 'C2-' || account_a::text, 'SYSTEM'::"AccountKind", now()
FROM pg_temp.bv_c2_posting_ids
UNION ALL
SELECT account_b, 'C2-' || account_b::text, 'SYSTEM'::"AccountKind", now()
FROM pg_temp.bv_c2_posting_ids
UNION ALL
SELECT account_c, 'C2-' || account_c::text, 'SYSTEM'::"AccountKind", now()
FROM pg_temp.bv_c2_posting_ids;

INSERT INTO "LedgerTransaction" ("id", "reference", "type", "postedTxid")
SELECT tx_initial, 'C2-INITIAL-' || tx_initial::text,
       'FUNDING'::"LedgerTransactionType", 'forged-value'
FROM pg_temp.bv_c2_posting_ids;

DO $test$
DECLARE
  v_posted_txid text;
BEGIN
  SELECT t."postedTxid"
    INTO v_posted_txid
    FROM "LedgerTransaction" AS t
    JOIN pg_temp.bv_c2_posting_ids AS i ON t."id" = i.tx_initial;

  IF v_posted_txid <> pg_current_xact_id()::text THEN
    RAISE EXCEPTION 'FAIL: stamp trigger did not override forged postedTxid';
  END IF;

  RAISE NOTICE 'PASS: forged postedTxid was replaced with the current transaction ID';
END
$test$;

INSERT INTO "LedgerEntry" ("transactionId", "accountId", "direction", "amountMinor")
SELECT tx_initial, account_a, 'DEBIT'::"EntryDirection", 1000
FROM pg_temp.bv_c2_posting_ids;

INSERT INTO "LedgerEntry" ("transactionId", "accountId", "direction", "amountMinor")
SELECT tx_initial, account_b, 'CREDIT'::"EntryDirection", 1000
FROM pg_temp.bv_c2_posting_ids;

COMMIT;
\echo 'EXPECTED: initial balanced posting committed successfully'

\echo '=== T02 late balanced pair in a later transaction is rejected ==='
BEGIN;

DO $test$
DECLARE
  v_tx uuid;
  v_account_a uuid;
  v_account_b uuid;
  v_rejected boolean := false;
BEGIN
  SELECT tx_initial, account_a, account_b
    INTO v_tx, v_account_a, v_account_b
    FROM pg_temp.bv_c2_posting_ids;

  BEGIN
    INSERT INTO "LedgerEntry" ("transactionId", "accountId", "direction", "amountMinor")
    VALUES
      (v_tx, v_account_a, 'DEBIT'::"EntryDirection", 1000),
      (v_tx, v_account_b, 'CREDIT'::"EntryDirection", 1000);
  EXCEPTION WHEN OTHERS THEN
    IF position('already posted' IN SQLERRM) > 0 THEN
      v_rejected := true;
    ELSE
      RAISE;
    END IF;
  END;

  IF NOT v_rejected THEN
    RAISE EXCEPTION 'FAIL: a later balanced pair was accepted';
  END IF;

  RAISE NOTICE 'PASS: a balanced pair in a later transaction was rejected';
END
$test$;

COMMIT;

\echo '=== T03 deferred balance constraint rejects unbalanced posting with check_violation ==='
DO $test$
DECLARE
  v_tx uuid;
  v_account_a uuid;
  v_account_b uuid;
  v_sqlstate text;
  v_message text;
  v_rejected boolean := false;
BEGIN
  SELECT tx_unbalanced, account_a, account_b
    INTO v_tx, v_account_a, v_account_b
    FROM pg_temp.bv_c2_posting_ids;

  BEGIN
    INSERT INTO "LedgerTransaction" ("id", "reference", "type")
    VALUES (
      v_tx,
      'C2-UNBALANCED-' || v_tx::text,
      'TRANSFER'::"LedgerTransactionType"
    );

    INSERT INTO "LedgerEntry" ("transactionId", "accountId", "direction", "amountMinor")
    VALUES
      (v_tx, v_account_a, 'DEBIT'::"EntryDirection", 1000),
      (v_tx, v_account_b, 'CREDIT'::"EntryDirection", 900);

    SET CONSTRAINTS ALL IMMEDIATE;
    RAISE EXCEPTION 'FAIL: unbalanced posting passed deferred validation';
  EXCEPTION WHEN check_violation THEN
    GET STACKED DIAGNOSTICS
      v_sqlstate = RETURNED_SQLSTATE,
      v_message = MESSAGE_TEXT;

    IF v_sqlstate <> '23514'
       OR position('is unbalanced' IN v_message) = 0 THEN
      RAISE EXCEPTION
        'FAIL: unbalanced posting failed for an unexpected reason: SQLSTATE %, message %',
        v_sqlstate, v_message;
    END IF;
    v_rejected := true;
  END;

  IF NOT v_rejected THEN
    RAISE EXCEPTION 'FAIL: unbalanced posting was not rejected by the balance constraint';
  END IF;
  RAISE NOTICE 'PASS: deferred balance constraint rejected the unbalanced posting';
END
$test$;

\echo '=== T04 deferred entry-count constraint rejects an empty header with check_violation ==='
DO $test$
DECLARE
  v_tx uuid;
  v_sqlstate text;
  v_message text;
  v_rejected boolean := false;
BEGIN
  SELECT tx_empty_header
    INTO v_tx
    FROM pg_temp.bv_c2_posting_ids;

  BEGIN
    INSERT INTO "LedgerTransaction" ("id", "reference", "type")
    VALUES (
      v_tx,
      'C2-EMPTY-' || v_tx::text,
      'TRANSFER'::"LedgerTransactionType"
    );

    SET CONSTRAINTS ALL IMMEDIATE;
    RAISE EXCEPTION 'FAIL: empty ledger header passed deferred validation';
  EXCEPTION WHEN check_violation THEN
    GET STACKED DIAGNOSTICS
      v_sqlstate = RETURNED_SQLSTATE,
      v_message = MESSAGE_TEXT;

    IF v_sqlstate <> '23514'
       OR position('needs at least 2 entries' IN v_message) = 0 THEN
      RAISE EXCEPTION
        'FAIL: empty header failed for an unexpected reason: SQLSTATE %, message %',
        v_sqlstate, v_message;
    END IF;
    v_rejected := true;
  END;

  IF NOT v_rejected THEN
    RAISE EXCEPTION 'FAIL: empty header was not rejected by the entry-count constraint';
  END IF;
  RAISE NOTICE 'PASS: deferred entry-count constraint rejected the empty header';
END
$test$;

\echo '=== T05 entry for a nonexistent header is rejected ==='
BEGIN;

DO $test$
DECLARE
  v_tx uuid;
  v_account uuid;
  v_rejected boolean := false;
BEGIN
  SELECT tx_missing_header, account_a
    INTO v_tx, v_account
    FROM pg_temp.bv_c2_posting_ids;

  BEGIN
    INSERT INTO "LedgerEntry" ("transactionId", "accountId", "direction", "amountMinor")
    VALUES (v_tx, v_account, 'DEBIT'::"EntryDirection", 1);
  EXCEPTION WHEN OTHERS THEN
    IF position('does not exist or is not visible' IN SQLERRM) > 0 THEN
      v_rejected := true;
    ELSE
      RAISE;
    END IF;
  END;

  IF NOT v_rejected THEN
    RAISE EXCEPTION 'FAIL: an entry for a nonexistent header was accepted';
  END IF;

  RAISE NOTICE 'PASS: an entry for a nonexistent header was rejected';
END
$test$;

COMMIT;

\echo '=== T06 header and entries in a released savepoint succeed ==='
BEGIN;
SAVEPOINT posting_pair;

INSERT INTO "LedgerTransaction" ("id", "reference", "type")
SELECT tx_savepoint, 'C2-SAVEPOINT-' || tx_savepoint::text,
       'TRANSFER'::"LedgerTransactionType"
FROM pg_temp.bv_c2_posting_ids;

INSERT INTO "LedgerEntry" ("transactionId", "accountId", "direction", "amountMinor")
SELECT tx_savepoint, account_a, 'DEBIT'::"EntryDirection", 250
FROM pg_temp.bv_c2_posting_ids;

INSERT INTO "LedgerEntry" ("transactionId", "accountId", "direction", "amountMinor")
SELECT tx_savepoint, account_b, 'CREDIT'::"EntryDirection", 250
FROM pg_temp.bv_c2_posting_ids;

RELEASE SAVEPOINT posting_pair;
COMMIT;
\echo 'EXPECTED: posting inside the released savepoint committed successfully'

\echo '=== T07 a rolled-back header savepoint cannot authorize a later entry ==='
BEGIN;
SAVEPOINT rolled_back_header;

INSERT INTO "LedgerTransaction" ("id", "reference", "type")
SELECT tx_rolled_back_header, 'C2-ROLLED-BACK-' || tx_rolled_back_header::text,
       'TRANSFER'::"LedgerTransactionType"
FROM pg_temp.bv_c2_posting_ids;

ROLLBACK TO SAVEPOINT rolled_back_header;
RELEASE SAVEPOINT rolled_back_header;

DO $test$
DECLARE
  v_tx uuid;
  v_account uuid;
  v_rejected boolean := false;
BEGIN
  SELECT tx_rolled_back_header, account_a
    INTO v_tx, v_account
    FROM pg_temp.bv_c2_posting_ids;

  BEGIN
    INSERT INTO "LedgerEntry" ("transactionId", "accountId", "direction", "amountMinor")
    VALUES (v_tx, v_account, 'DEBIT'::"EntryDirection", 1);
  EXCEPTION WHEN OTHERS THEN
    IF position('does not exist or is not visible' IN SQLERRM) > 0 THEN
      v_rejected := true;
    ELSE
      RAISE;
    END IF;
  END;

  IF NOT v_rejected THEN
    RAISE EXCEPTION 'FAIL: entry after a rolled-back header savepoint was accepted';
  END IF;

  RAISE NOTICE 'PASS: entry after a rolled-back header savepoint was rejected';
END
$test$;

COMMIT;

\echo '=== T08 UPDATE of postedTxid is rejected by append-only enforcement ==='
BEGIN;

DO $test$
DECLARE
  v_tx uuid;
  v_rejected boolean := false;
BEGIN
  SELECT tx_initial INTO v_tx FROM pg_temp.bv_c2_posting_ids;

  BEGIN
    UPDATE "LedgerTransaction"
       SET "postedTxid" = 'tampered'
     WHERE "id" = v_tx;
  EXCEPTION WHEN OTHERS THEN
    IF position('is append-only:' IN SQLERRM) > 0 THEN
      v_rejected := true;
    ELSE
      RAISE;
    END IF;
  END;

  IF NOT v_rejected THEN
    RAISE EXCEPTION 'FAIL: UPDATE of postedTxid was accepted';
  END IF;

  RAISE NOTICE 'PASS: UPDATE of postedTxid was rejected';
END
$test$;

COMMIT;

\echo '=== T09 legitimate three-leg transaction succeeds ==='
BEGIN;

INSERT INTO "LedgerTransaction" ("id", "reference", "type")
SELECT tx_three_leg, 'C2-THREE-LEG-' || tx_three_leg::text,
       'TRANSFER'::"LedgerTransactionType"
FROM pg_temp.bv_c2_posting_ids;

INSERT INTO "LedgerEntry" ("transactionId", "accountId", "direction", "amountMinor")
SELECT tx_three_leg, account_a, 'DEBIT'::"EntryDirection", 100
FROM pg_temp.bv_c2_posting_ids;

INSERT INTO "LedgerEntry" ("transactionId", "accountId", "direction", "amountMinor")
SELECT tx_three_leg, account_b, 'DEBIT'::"EntryDirection", 50
FROM pg_temp.bv_c2_posting_ids;

INSERT INTO "LedgerEntry" ("transactionId", "accountId", "direction", "amountMinor")
SELECT tx_three_leg, account_c, 'CREDIT'::"EntryDirection", 150
FROM pg_temp.bv_c2_posting_ids;

COMMIT;
\echo 'EXPECTED: balanced three-leg transaction committed successfully'

\echo '=== T10 global ledger invariant: EXPECT bad_transactions = 0 ==='
DO $test$
DECLARE
  v_bad_transactions bigint;
BEGIN
  SELECT count(*)
    INTO v_bad_transactions
    FROM (
      SELECT
        t."id",
        count(e."id") AS entry_count,
        COALESCE(sum(e."amountMinor") FILTER (WHERE e."direction" = 'DEBIT'), 0) AS debits,
        COALESCE(sum(e."amountMinor") FILTER (WHERE e."direction" = 'CREDIT'), 0) AS credits
      FROM "LedgerTransaction" AS t
      LEFT JOIN "LedgerEntry" AS e ON e."transactionId" = t."id"
      GROUP BY t."id"
      HAVING count(e."id") < 2
          OR COALESCE(sum(e."amountMinor") FILTER (WHERE e."direction" = 'DEBIT'), 0)
             <> COALESCE(sum(e."amountMinor") FILTER (WHERE e."direction" = 'CREDIT'), 0)
    ) AS bad;

  IF v_bad_transactions <> 0 THEN
    RAISE EXCEPTION 'FAIL: global ledger invariant found % bad transactions', v_bad_transactions;
  END IF;

  RAISE NOTICE 'PASS: global ledger invariant found 0 bad transactions';
END
$test$;

\echo '=== T11 ledger trigger inventory: EXPECT the exact 9 rows and all tgenabled = A ==='
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
  v_trigger_names text[];
  v_expected_trigger_names text[] := ARRAY[
    'LedgerEntry_append_only_row',
    'LedgerEntry_append_only_truncate',
    'LedgerEntry_balance_cache',
    'LedgerEntry_balanced',
    'LedgerEntry_posting_window',
    'LedgerTransaction_append_only_row',
    'LedgerTransaction_append_only_truncate',
    'LedgerTransaction_has_entries',
    'LedgerTransaction_stamp_posting_txid'
  ];
BEGIN
  SELECT count(*),
         COALESCE(bool_and(t.tgenabled = 'A'), false),
         array_agg(t.tgname::text ORDER BY c.relname, t.tgname COLLATE "C")
    INTO v_trigger_count, v_all_always_enabled, v_trigger_names
    FROM pg_trigger AS t
    JOIN pg_class AS c ON c.oid = t.tgrelid
    JOIN pg_namespace AS n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public'
     AND c.relname IN ('LedgerEntry', 'LedgerTransaction')
     AND NOT t.tgisinternal;

  IF v_trigger_count <> 9
     OR NOT v_all_always_enabled
     OR v_trigger_names <> v_expected_trigger_names THEN
    RAISE EXCEPTION
      'FAIL: expected exact 9 non-internal ledger triggers all enabled ALWAYS; found %, all_always_enabled=%, names=%',
      v_trigger_count, v_all_always_enabled, v_trigger_names;
  END IF;

  RAISE NOTICE 'PASS: exact 9-trigger inventory is present and all are enabled ALWAYS';
END
$test$;

\echo '=== DONE: successful append-only test rows remain in balancevault_test ==='
