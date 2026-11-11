\set ON_ERROR_STOP on

\echo '=== SAFETY: require balancevault_test and postgres ==='
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

\echo '=== RECORD balance before idempotent seed reruns ==='
SELECT COALESCE(
         (
           SELECT "balanceMinor"
           FROM public."Account"
           WHERE "accountNumber" = 'BV-SYSTEM-FUNDING-INR'
         ),
         0
       )::text AS phase_b_seed_balance_before
\gset
SELECT set_config(
  'bv.phase_b.seed_balance_before',
  :'phase_b_seed_balance_before',
  false
);

\echo '=== RUN owner seed twice to prove reruns are safe ==='
\ir ../seed-system-account.sql
\ir ../seed-system-account.sql

DO $test$
DECLARE
  v_count bigint;
  v_kind public."AccountKind";
  v_owner uuid;
  v_currency text;
  v_balance bigint;
  v_balance_before bigint :=
    current_setting('bv.phase_b.seed_balance_before')::bigint;
BEGIN
  SELECT count(*)
    INTO v_count
    FROM public."Account"
   WHERE "accountNumber" = 'BV-SYSTEM-FUNDING-INR';

  IF v_count <> 1 THEN
    RAISE EXCEPTION
      'FAIL: expected one seeded SYSTEM account, found %', v_count;
  END IF;

  SELECT "kind", "ownerId", "currency", "balanceMinor"
    INTO v_kind, v_owner, v_currency, v_balance
    FROM public."Account"
   WHERE "accountNumber" = 'BV-SYSTEM-FUNDING-INR';

  IF v_kind <> 'SYSTEM'::public."AccountKind"
     OR v_owner IS NOT NULL
     OR v_currency <> 'INR'
     OR v_balance <> v_balance_before THEN
    RAISE EXCEPTION
      'FAIL: seed properties changed or do not match the expected SYSTEM account';
  END IF;

  RAISE NOTICE 'PASS: reruns preserve one SYSTEM account and its balance';
END
$test$;

RESET bv.phase_b.seed_balance_before;
