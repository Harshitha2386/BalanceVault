\set ON_ERROR_STOP on

\echo '=== SAFETY: require an approved BalanceVault database and postgres ==='
DO $test$
BEGIN
  IF current_database() NOT IN ('balancevault_dev', 'balancevault_test') THEN
    RAISE EXCEPTION
      'FAIL: use balancevault_dev or balancevault_test, not %',
      current_database();
  END IF;

  IF current_user <> 'postgres' THEN
    RAISE EXCEPTION 'FAIL: this test must run as postgres, not %', current_user;
  END IF;
END
$test$;

\echo '=== CHECK: every cached account balance equals its ledger-derived balance ==='
DO $test$
DECLARE
  v_mismatch_count bigint;
BEGIN
  SELECT count(*)
    INTO v_mismatch_count
    FROM public."Account" AS a
   WHERE a."balanceMinor"::numeric <> COALESCE(
     (
       SELECT sum(
         CASE e."direction"
           WHEN 'CREDIT'::public."EntryDirection" THEN e."amountMinor"
           WHEN 'DEBIT'::public."EntryDirection" THEN -e."amountMinor"
         END
       )
       FROM public."LedgerEntry" AS e
       WHERE e."accountId" = a."id"
     ),
     0
   );

  IF v_mismatch_count <> 0 THEN
    RAISE EXCEPTION
      'FAIL: found % cached account balances that differ from ledger totals',
      v_mismatch_count;
  END IF;

  RAISE NOTICE 'PASS: all account cache values match the ledger';
END
$test$;
