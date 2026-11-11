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

\echo '=== ASSERT bv_app cannot directly change protected Account columns ==='
DO $test$
DECLARE
  v_account_id uuid;
  v_rejected boolean;
  v_message text;
BEGIN
  SELECT "id"
    INTO v_account_id
    FROM public."Account"
   WHERE "accountNumber" = 'BV-SYSTEM-FUNDING-INR';

  IF v_account_id IS NULL THEN
    RAISE EXCEPTION
      'FAIL: owner-run SYSTEM seed must run before this test';
  END IF;

  IF has_table_privilege('bv_app', 'public."Account"', 'UPDATE')
     OR has_column_privilege(
       'bv_app', 'public."Account"', 'balanceMinor', 'UPDATE'
     )
     OR has_column_privilege(
       'bv_app', 'public."Account"', 'kind', 'UPDATE'
     )
     OR has_column_privilege(
       'bv_app', 'public."Account"', 'kind', 'INSERT'
     )
     OR has_column_privilege(
       'bv_app', 'public."Account"', 'balanceMinor', 'INSERT'
     ) THEN
    RAISE EXCEPTION
      'FAIL: bv_app has direct privilege to write Account.kind or balanceMinor';
  END IF;

  v_rejected := false;
  BEGIN
    UPDATE public."Account"
       SET "balanceMinor" = "balanceMinor" + 1
     WHERE "id" = v_account_id;
  EXCEPTION WHEN insufficient_privilege THEN
    v_rejected := true;
  END;
  IF NOT v_rejected THEN
    RAISE EXCEPTION 'FAIL: direct balance update was accepted';
  END IF;
  RAISE NOTICE 'PASS: direct balance update denied';

  v_rejected := false;
  BEGIN
    UPDATE public."Account"
       SET "kind" = 'CUSTOMER'::public."AccountKind"
     WHERE "id" = v_account_id;
  EXCEPTION WHEN insufficient_privilege THEN
    v_rejected := true;
  END;
  IF NOT v_rejected THEN
    RAISE EXCEPTION 'FAIL: direct SYSTEM kind update was accepted';
  END IF;
  RAISE NOTICE 'PASS: direct account kind update denied';

  v_rejected := false;
  BEGIN
    UPDATE public."Account"
       SET "status" = 'FROZEN'::public."AccountStatus"
     WHERE "id" = v_account_id;
  EXCEPTION WHEN insufficient_privilege THEN
    GET STACKED DIAGNOSTICS v_message = MESSAGE_TEXT;
    IF v_message <> 'bv_app may not modify SYSTEM accounts' THEN
      RAISE EXCEPTION
        'FAIL: SYSTEM status update failed for an unexpected reason: %',
        v_message;
    END IF;
    v_rejected := true;
  END;
  IF NOT v_rejected THEN
    RAISE EXCEPTION 'FAIL: bv_app changed SYSTEM account status';
  END IF;
  RAISE NOTICE 'PASS: SYSTEM account status update denied';

  v_rejected := false;
  BEGIN
    UPDATE public."Account"
       SET "updatedAt" = now()
     WHERE "id" = v_account_id;
  EXCEPTION WHEN insufficient_privilege THEN
    GET STACKED DIAGNOSTICS v_message = MESSAGE_TEXT;
    IF v_message <> 'bv_app may not modify SYSTEM accounts' THEN
      RAISE EXCEPTION
        'FAIL: SYSTEM metadata update failed for an unexpected reason: %',
        v_message;
    END IF;
    v_rejected := true;
  END;
  IF NOT v_rejected THEN
    RAISE EXCEPTION 'FAIL: bv_app modified SYSTEM account metadata';
  END IF;
  RAISE NOTICE 'PASS: SYSTEM account metadata update denied';

  v_rejected := false;
  BEGIN
    UPDATE public."Account"
       SET "ownerId" = gen_random_uuid()
     WHERE "id" = v_account_id;
  EXCEPTION WHEN insufficient_privilege THEN
    v_rejected := true;
  END;
  IF NOT v_rejected THEN
    RAISE EXCEPTION 'FAIL: bv_app changed SYSTEM account ownership';
  END IF;
  RAISE NOTICE 'PASS: SYSTEM account ownership update denied';

  v_rejected := false;
  BEGIN
    DELETE FROM public."Account"
     WHERE "id" = v_account_id;
  EXCEPTION WHEN insufficient_privilege THEN
    v_rejected := true;
  END;
  IF NOT v_rejected THEN
    RAISE EXCEPTION 'FAIL: bv_app deleted SYSTEM account';
  END IF;
  RAISE NOTICE 'PASS: SYSTEM account deletion denied';

  v_rejected := false;
  BEGIN
    INSERT INTO public."Account" (
      "id", "accountNumber", "kind", "updatedAt"
    )
    VALUES (
      gen_random_uuid(),
      'BV-APP-SYSTEM-ATTEMPT-' || gen_random_uuid()::text,
      'SYSTEM'::public."AccountKind",
      now()
    );
  EXCEPTION WHEN insufficient_privilege THEN
    v_rejected := true;
  END;
  IF NOT v_rejected THEN
    RAISE EXCEPTION 'FAIL: bv_app inserted a SYSTEM account';
  END IF;
  RAISE NOTICE 'PASS: app-role SYSTEM account insert denied';
END
$test$;

\echo '=== ASSERT cache function is narrowly executable and SECURITY DEFINER ==='
DO $test$
DECLARE
  v_is_security_definer boolean;
  v_owner name;
  v_config text[];
BEGIN
  SELECT p.prosecdef, r.rolname, p.proconfig
    INTO v_is_security_definer, v_owner, v_config
    FROM pg_proc AS p
    JOIN pg_namespace AS n ON n.oid = p.pronamespace
    JOIN pg_roles AS r ON r.oid = p.proowner
   WHERE n.nspname = 'public'
     AND p.proname = 'bv_update_account_balance_from_ledger'
     AND p.pronargs = 0;

  IF NOT FOUND
     OR NOT v_is_security_definer
     OR v_owner <> 'postgres'
     OR NOT (
       'search_path=pg_catalog' = ANY(COALESCE(v_config, ARRAY[]::text[]))
     )
     OR has_function_privilege(
       'bv_app',
       'public.bv_update_account_balance_from_ledger()',
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION
      'FAIL: balance function owner, SECURITY DEFINER, search_path, or execute grants are unsafe';
  END IF;

  RAISE NOTICE 'PASS: only the owner can execute the pinned SECURITY DEFINER function';
END
$test$;

\echo '=== ASSERT SYSTEM-account guard protects app updates and preserves customer status updates ==='
DO $test$
DECLARE
  v_is_security_definer boolean;
  v_function_owner name;
  v_search_path text[];
  v_trigger_count bigint;
  v_guard_enabled boolean;
BEGIN
  SELECT p.prosecdef, r.rolname, p.proconfig
    INTO v_is_security_definer, v_function_owner, v_search_path
    FROM pg_proc AS p
    JOIN pg_namespace AS n ON n.oid = p.pronamespace
    JOIN pg_roles AS r ON r.oid = p.proowner
   WHERE n.nspname = 'public'
     AND p.proname = 'bv_reject_system_account_app_updates'
     AND p.pronargs = 0;

  SELECT count(*), COALESCE(bool_and(t.tgenabled = 'A'), false)
    INTO v_trigger_count, v_guard_enabled
    FROM pg_trigger AS t
    JOIN pg_class AS c ON c.oid = t.tgrelid
    JOIN pg_namespace AS n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public'
     AND c.relname = 'Account'
     AND t.tgname = 'Account_reject_app_system_update'
     AND NOT t.tgisinternal;

  IF v_is_security_definer IS DISTINCT FROM false
     OR v_function_owner <> 'postgres'
     OR NOT ('search_path=pg_catalog' = ANY(COALESCE(v_search_path, ARRAY[]::text[])))
     OR v_trigger_count <> 1
     OR NOT v_guard_enabled THEN
    RAISE EXCEPTION
      'FAIL: SYSTEM-account update guard owner, search_path, trigger, or ENABLE ALWAYS state is incorrect';
  END IF;

  RAISE NOTICE 'PASS: SYSTEM-account update guard is installed and ENABLE ALWAYS';
END
$test$;

DO $test$
DECLARE
  v_trigger_count bigint;
  v_all_always_enabled boolean;
  v_trigger_names text[];
  v_expected_trigger_names text[] := ARRAY[
    'AuditLog_append_only_row',
    'AuditLog_append_only_truncate'
  ];
BEGIN
  SELECT count(*),
         COALESCE(bool_and(t.tgenabled = 'A'), false),
         array_agg(t.tgname::text ORDER BY t.tgname COLLATE "C")
    INTO v_trigger_count, v_all_always_enabled, v_trigger_names
    FROM pg_trigger AS t
    JOIN pg_class AS c ON c.oid = t.tgrelid
    JOIN pg_namespace AS n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public'
     AND c.relname = 'AuditLog'
     AND NOT t.tgisinternal;

  IF v_trigger_count <> 2
     OR NOT v_all_always_enabled
     OR v_trigger_names <> v_expected_trigger_names THEN
    RAISE EXCEPTION
      'FAIL: expected exact two AuditLog append-only triggers enabled ALWAYS; found %, all_always_enabled=%, names=%',
      v_trigger_count, v_all_always_enabled, v_trigger_names;
  END IF;

  RAISE NOTICE 'PASS: AuditLog append-only triggers are exact and enabled ALWAYS';
END
$test$;

BEGIN;
DO $test$
DECLARE
  v_user_id uuid := gen_random_uuid();
  v_account_id uuid := gen_random_uuid();
  v_account_status public."AccountStatus";
BEGIN
  INSERT INTO public."User" (
    "id", "email", "fullName", "passwordHash", "updatedAt"
  )
  VALUES (
    v_user_id,
    'phase-b-customer-status-' || v_user_id::text || '@example.test',
    'Synthetic Customer Status Test',
    'synthetic-not-a-password-hash',
    now()
  );

  INSERT INTO public."Account" (
    "id", "accountNumber", "ownerId", "updatedAt"
  )
  VALUES (
    v_account_id,
    'BV-APP-CUSTOMER-STATUS-' || v_account_id::text,
    v_user_id,
    now()
  );

  UPDATE public."Account"
     SET "status" = 'FROZEN'::public."AccountStatus"
   WHERE "id" = v_account_id;

  SELECT "status"
    INTO v_account_status
    FROM public."Account"
   WHERE "id" = v_account_id;

  IF v_account_status <> 'FROZEN'::public."AccountStatus" THEN
    RAISE EXCEPTION 'FAIL: customer status update was not preserved';
  END IF;

  RAISE NOTICE 'PASS: bv_app can still update CUSTOMER account status';
END
$test$;
ROLLBACK;

\echo '=== ASSERT AuditLog is append-only for bv_app ==='
DO $test$
BEGIN
  IF has_table_privilege('bv_app', 'public."AuditLog"', 'UPDATE')
     OR has_table_privilege('bv_app', 'public."AuditLog"', 'DELETE')
     OR has_table_privilege('bv_app', 'public."AuditLog"', 'TRUNCATE') THEN
    RAISE EXCEPTION 'FAIL: bv_app has UPDATE, DELETE, or TRUNCATE on AuditLog';
  END IF;

  BEGIN
    UPDATE public."AuditLog"
       SET "action" = "action"
     WHERE false;
    RAISE EXCEPTION 'FAIL: AuditLog UPDATE privilege was accepted';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'PASS: AuditLog UPDATE denied';
  END;

  BEGIN
    DELETE FROM public."AuditLog"
     WHERE false;
    RAISE EXCEPTION 'FAIL: AuditLog DELETE privilege was accepted';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'PASS: AuditLog DELETE denied';
  END;

  BEGIN
    TRUNCATE TABLE public."AuditLog";
    RAISE EXCEPTION 'FAIL: AuditLog TRUNCATE privilege was accepted';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'PASS: AuditLog TRUNCATE denied';
  END;
END
$test$;

\echo '=== ASSERT bv_app cannot disable the balance trigger ==='
DO $test$
BEGIN
  BEGIN
    ALTER TABLE public."LedgerEntry"
      DISABLE TRIGGER "LedgerEntry_balance_cache";
    RAISE EXCEPTION 'FAIL: bv_app disabled the balance-cache trigger';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'PASS: disabling balance-cache trigger denied';
  END;
END
$test$;

\echo '=== ASSERT bv_app cannot disable the SYSTEM-account update guard ==='
DO $test$
BEGIN
  BEGIN
    ALTER TABLE public."Account"
      DISABLE TRIGGER "Account_reject_app_system_update";
    RAISE EXCEPTION 'FAIL: bv_app disabled the SYSTEM-account update guard';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'PASS: disabling SYSTEM-account update guard denied';
  END;
END
$test$;
