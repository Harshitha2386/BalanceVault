\set ON_ERROR_STOP on

\echo '=== SAFETY: require balancevault_test and bv_app ==='
DO $test$
BEGIN
  IF current_database() <> 'balancevault_test' THEN
    RAISE EXCEPTION
      'FAIL: this test must run against balancevault_test, not %',
      current_database();
  END IF;

  IF current_user <> 'bv_app' THEN
    RAISE EXCEPTION 'FAIL: this test must run as bv_app, not %', current_user;
  END IF;
END
$test$;

\echo '=== SETUP: require owner-seeded SYSTEM account ==='
DO $test$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public."Account"
    WHERE "accountNumber" = 'BV-SYSTEM-FUNDING-INR'
      AND "kind" = 'SYSTEM'::public."AccountKind"
      AND "ownerId" IS NULL
  ) THEN
    RAISE EXCEPTION 'FAIL: owner-run SYSTEM seed must run before this test';
  END IF;
END
$test$;

SELECT "id"::text AS phase_b_system_account_id,
       "balanceMinor"::text AS phase_b_system_balance_before
FROM public."Account"
WHERE "accountNumber" = 'BV-SYSTEM-FUNDING-INR'
\gset
SELECT gen_random_uuid()::text AS phase_b_balance_user_id \gset
SELECT gen_random_uuid()::text AS phase_b_balance_customer_id \gset
SELECT gen_random_uuid()::text AS phase_b_rollback_tx_id \gset
SELECT gen_random_uuid()::text AS phase_b_funding_tx_id \gset
SELECT gen_random_uuid()::text AS phase_b_final_tx_id \gset
SELECT set_config(
  'bv.phase_b.balance_system_id',
  :'phase_b_system_account_id',
  false
);
SELECT set_config(
  'bv.phase_b.balance_user_id',
  :'phase_b_balance_user_id',
  false
);
SELECT set_config(
  'bv.phase_b.balance_customer_id',
  :'phase_b_balance_customer_id',
  false
);
SELECT set_config(
  'bv.phase_b.balance_system_before',
  :'phase_b_system_balance_before',
  false
);

BEGIN;

INSERT INTO public."User" (
  "id", "email", "fullName", "passwordHash", "updatedAt"
)
VALUES (
  :'phase_b_balance_user_id'::uuid,
  'phase-b-balance-' || :'phase_b_balance_user_id' || '@example.test',
  'Synthetic Balance Test User',
  'synthetic-not-a-password-hash',
  now()
);

INSERT INTO public."Account" (
  "id", "accountNumber", "ownerId", "updatedAt"
)
VALUES (
  :'phase_b_balance_customer_id'::uuid,
  'BV-BALANCE-TEST-' || :'phase_b_balance_customer_id',
  :'phase_b_balance_user_id'::uuid,
  now()
);

\echo '=== T01 a rolled-back balanced posting rolls back both cache updates ==='
SAVEPOINT rollback_probe;

INSERT INTO public."LedgerTransaction" ("id", "reference", "type")
VALUES (
  :'phase_b_rollback_tx_id'::uuid,
  'PHASE-B-ROLLBACK-' || :'phase_b_rollback_tx_id',
  'FUNDING'::public."LedgerTransactionType"
);

INSERT INTO public."LedgerEntry" (
  "transactionId", "accountId", "direction", "amountMinor"
)
SELECT
  :'phase_b_rollback_tx_id'::uuid,
  p.account_id,
  p.direction,
  p.amount_minor
FROM (
  VALUES
    (
      :'phase_b_system_account_id'::uuid,
      'DEBIT'::public."EntryDirection",
      100::bigint
    ),
    (
      :'phase_b_balance_customer_id'::uuid,
      'CREDIT'::public."EntryDirection",
      100::bigint
    )
) AS p(account_id, direction, amount_minor)
ORDER BY p.account_id;

DO $test$
DECLARE
  v_system_id uuid := current_setting('bv.phase_b.balance_system_id')::uuid;
  v_customer_id uuid := current_setting('bv.phase_b.balance_customer_id')::uuid;
  v_system_balance bigint;
  v_customer_balance bigint;
  v_system_start bigint :=
    current_setting('bv.phase_b.balance_system_before')::bigint;
BEGIN
  SELECT "balanceMinor" INTO v_system_balance
    FROM public."Account" WHERE "id" = v_system_id;
  SELECT "balanceMinor" INTO v_customer_balance
    FROM public."Account" WHERE "id" = v_customer_id;

  IF v_system_balance <> v_system_start - 100
     OR v_customer_balance <> 100 THEN
    RAISE EXCEPTION
      'FAIL: inserted entries did not update both cached balances';
  END IF;
  RAISE NOTICE 'PASS: debit and credit updated caches before commit';
END
$test$;

ROLLBACK TO SAVEPOINT rollback_probe;
RELEASE SAVEPOINT rollback_probe;

DO $test$
DECLARE
  v_system_id uuid := current_setting('bv.phase_b.balance_system_id')::uuid;
  v_customer_id uuid := current_setting('bv.phase_b.balance_customer_id')::uuid;
  v_system_balance bigint;
  v_customer_balance bigint;
  v_system_start bigint :=
    current_setting('bv.phase_b.balance_system_before')::bigint;
BEGIN
  SELECT "balanceMinor" INTO v_system_balance
    FROM public."Account" WHERE "id" = v_system_id;
  SELECT "balanceMinor" INTO v_customer_balance
    FROM public."Account" WHERE "id" = v_customer_id;

  IF v_system_balance <> v_system_start OR v_customer_balance <> 0 THEN
    RAISE EXCEPTION 'FAIL: savepoint rollback did not restore cached balances';
  END IF;
  RAISE NOTICE 'PASS: savepoint rollback restored both cached balances';
END
$test$;

\echo '=== T02 successful posting funds customer and updates both caches ==='
INSERT INTO public."LedgerTransaction" ("id", "reference", "type")
VALUES (
  :'phase_b_funding_tx_id'::uuid,
  'PHASE-B-FUNDING-' || :'phase_b_funding_tx_id',
  'FUNDING'::public."LedgerTransactionType"
);

INSERT INTO public."LedgerEntry" (
  "transactionId", "accountId", "direction", "amountMinor"
)
SELECT
  :'phase_b_funding_tx_id'::uuid,
  p.account_id,
  p.direction,
  p.amount_minor
FROM (
  VALUES
    (
      :'phase_b_system_account_id'::uuid,
      'DEBIT'::public."EntryDirection",
      500::bigint
    ),
    (
      :'phase_b_balance_customer_id'::uuid,
      'CREDIT'::public."EntryDirection",
      500::bigint
    )
) AS p(account_id, direction, amount_minor)
ORDER BY p.account_id;

DO $test$
DECLARE
  v_system_id uuid := current_setting('bv.phase_b.balance_system_id')::uuid;
  v_customer_id uuid := current_setting('bv.phase_b.balance_customer_id')::uuid;
  v_system_balance bigint;
  v_customer_balance bigint;
  v_system_start bigint :=
    current_setting('bv.phase_b.balance_system_before')::bigint;
BEGIN
  SELECT "balanceMinor" INTO v_system_balance
    FROM public."Account" WHERE "id" = v_system_id;
  SELECT "balanceMinor" INTO v_customer_balance
    FROM public."Account" WHERE "id" = v_customer_id;

  IF v_system_balance <> v_system_start - 500
     OR v_customer_balance <> 500 THEN
    RAISE EXCEPTION 'FAIL: funding posting produced incorrect cached balances';
  END IF;
  RAISE NOTICE 'PASS: funding posting updated customer and SYSTEM balances';
END
$test$;

\echo '=== T03 unbalanced posting failure rolls back cache changes ==='
DO $test$
DECLARE
  v_system_id uuid := current_setting('bv.phase_b.balance_system_id')::uuid;
  v_customer_id uuid := current_setting('bv.phase_b.balance_customer_id')::uuid;
  v_system_balance_before bigint;
  v_customer_balance_before bigint;
  v_system_balance_after bigint;
  v_customer_balance_after bigint;
  v_txid uuid := gen_random_uuid();
  v_message text;
  v_rejected boolean := false;
BEGIN
  SELECT "balanceMinor" INTO v_system_balance_before
    FROM public."Account" WHERE "id" = v_system_id;
  SELECT "balanceMinor" INTO v_customer_balance_before
    FROM public."Account" WHERE "id" = v_customer_id;

  BEGIN
    INSERT INTO public."LedgerTransaction" ("id", "reference", "type")
    VALUES (
      v_txid,
      'PHASE-B-UNBALANCED-' || v_txid::text,
      'TRANSFER'::public."LedgerTransactionType"
    );

    INSERT INTO public."LedgerEntry" (
      "transactionId", "accountId", "direction", "amountMinor"
    )
    SELECT
      v_txid, p.account_id, p.direction, p.amount_minor
    FROM (
      VALUES
        (
          v_system_id,
          'CREDIT'::public."EntryDirection",
          40::bigint
        ),
        (
          v_customer_id,
          'DEBIT'::public."EntryDirection",
          50::bigint
        )
    ) AS p(account_id, direction, amount_minor)
    ORDER BY p.account_id;

    SET CONSTRAINTS ALL IMMEDIATE;
  EXCEPTION WHEN check_violation THEN
    GET STACKED DIAGNOSTICS v_message = MESSAGE_TEXT;
    IF position('is unbalanced' IN v_message) = 0 THEN
      RAISE EXCEPTION
        'FAIL: unbalanced posting failed for an unexpected reason: %',
        v_message;
    END IF;
    v_rejected := true;
  END;

  IF NOT v_rejected THEN
    RAISE EXCEPTION 'FAIL: unbalanced posting was accepted';
  END IF;

  SELECT "balanceMinor" INTO v_system_balance_after
    FROM public."Account" WHERE "id" = v_system_id;
  SELECT "balanceMinor" INTO v_customer_balance_after
    FROM public."Account" WHERE "id" = v_customer_id;

  IF v_system_balance_after <> v_system_balance_before
     OR v_customer_balance_after <> v_customer_balance_before THEN
    RAISE EXCEPTION
      'FAIL: rejected unbalanced posting left cached balance changes';
  END IF;
  RAISE NOTICE 'PASS: failed unbalanced posting restored both cached balances';
END
$test$;

\echo '=== T04 customer overdraft is rejected and cache remains unchanged ==='
DO $test$
DECLARE
  v_system_id uuid := current_setting('bv.phase_b.balance_system_id')::uuid;
  v_customer_id uuid := current_setting('bv.phase_b.balance_customer_id')::uuid;
  v_system_balance_before bigint;
  v_customer_balance_before bigint;
  v_system_balance_after bigint;
  v_customer_balance_after bigint;
  v_txid uuid := gen_random_uuid();
  v_message text;
  v_rejected boolean := false;
BEGIN
  SELECT "balanceMinor" INTO v_system_balance_before
    FROM public."Account" WHERE "id" = v_system_id;
  SELECT "balanceMinor" INTO v_customer_balance_before
    FROM public."Account" WHERE "id" = v_customer_id;

  BEGIN
    INSERT INTO public."LedgerTransaction" ("id", "reference", "type")
    VALUES (
      v_txid,
      'PHASE-B-OVERDRAFT-' || v_txid::text,
      'TRANSFER'::public."LedgerTransactionType"
    );

    INSERT INTO public."LedgerEntry" (
      "transactionId", "accountId", "direction", "amountMinor"
    )
    SELECT
      v_txid, p.account_id, p.direction, p.amount_minor
    FROM (
      VALUES
        (
          v_system_id,
          'CREDIT'::public."EntryDirection",
          501::bigint
        ),
        (
          v_customer_id,
          'DEBIT'::public."EntryDirection",
          501::bigint
        )
    ) AS p(account_id, direction, amount_minor)
    ORDER BY p.account_id;
  EXCEPTION WHEN check_violation THEN
    GET STACKED DIAGNOSTICS v_message = MESSAGE_TEXT;
    IF position('Account_customer_balance_non_negative' IN v_message) = 0 THEN
      RAISE EXCEPTION
        'FAIL: overdraft failed for an unexpected reason: %', v_message;
    END IF;
    v_rejected := true;
  END;

  IF NOT v_rejected THEN
    RAISE EXCEPTION 'FAIL: customer overdraft was accepted';
  END IF;

  SELECT "balanceMinor" INTO v_system_balance_after
    FROM public."Account" WHERE "id" = v_system_id;
  SELECT "balanceMinor" INTO v_customer_balance_after
    FROM public."Account" WHERE "id" = v_customer_id;

  IF v_system_balance_after <> v_system_balance_before
     OR v_customer_balance_after <> v_customer_balance_before THEN
    RAISE EXCEPTION 'FAIL: rejected overdraft left cached balance changes';
  END IF;
  RAISE NOTICE 'PASS: customer CHECK rejected overdraft and cache stayed unchanged';
END
$test$;

\echo '=== T05 valid debit/credit posting persists correct cache and ledger totals ==='
INSERT INTO public."LedgerTransaction" ("id", "reference", "type")
VALUES (
  :'phase_b_final_tx_id'::uuid,
  'PHASE-B-FINAL-' || :'phase_b_final_tx_id',
  'TRANSFER'::public."LedgerTransactionType"
);

INSERT INTO public."LedgerEntry" (
  "transactionId", "accountId", "direction", "amountMinor"
)
SELECT
  :'phase_b_final_tx_id'::uuid,
  p.account_id,
  p.direction,
  p.amount_minor
FROM (
  VALUES
    (
      :'phase_b_system_account_id'::uuid,
      'CREDIT'::public."EntryDirection",
      200::bigint
    ),
    (
      :'phase_b_balance_customer_id'::uuid,
      'DEBIT'::public."EntryDirection",
      200::bigint
    )
) AS p(account_id, direction, amount_minor)
ORDER BY p.account_id;

DO $test$
DECLARE
  v_system_id uuid := current_setting('bv.phase_b.balance_system_id')::uuid;
  v_customer_id uuid := current_setting('bv.phase_b.balance_customer_id')::uuid;
  v_system_balance bigint;
  v_customer_balance bigint;
  v_system_total numeric;
  v_customer_total numeric;
  v_system_start bigint :=
    current_setting('bv.phase_b.balance_system_before')::bigint;
BEGIN
  SELECT "balanceMinor" INTO v_system_balance
    FROM public."Account" WHERE "id" = v_system_id;
  SELECT "balanceMinor" INTO v_customer_balance
    FROM public."Account" WHERE "id" = v_customer_id;

  SELECT COALESCE(sum(
           CASE "direction"
             WHEN 'CREDIT'::public."EntryDirection" THEN "amountMinor"
             WHEN 'DEBIT'::public."EntryDirection" THEN -"amountMinor"
           END
         ), 0)
    INTO v_system_total
    FROM public."LedgerEntry"
   WHERE "accountId" = v_system_id;
  SELECT COALESCE(sum(
           CASE "direction"
             WHEN 'CREDIT'::public."EntryDirection" THEN "amountMinor"
             WHEN 'DEBIT'::public."EntryDirection" THEN -"amountMinor"
           END
         ), 0)
    INTO v_customer_total
    FROM public."LedgerEntry"
   WHERE "accountId" = v_customer_id;

  IF v_system_balance <> v_system_start - 300
     OR v_customer_balance <> 300
     OR v_system_balance::numeric <> v_system_total
     OR v_customer_balance::numeric <> v_customer_total THEN
    RAISE EXCEPTION
      'FAIL: cached balances differ from expected totals or ledger recomputation';
  END IF;
  RAISE NOTICE 'PASS: cached balances equal the ledger-derived totals';
END
$test$;

COMMIT;

RESET bv.phase_b.balance_system_id;
RESET bv.phase_b.balance_user_id;
RESET bv.phase_b.balance_customer_id;
RESET bv.phase_b.balance_system_before;
\echo 'PASS: successful synthetic ledger postings remain in balancevault_test'
