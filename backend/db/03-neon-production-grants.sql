\set ON_ERROR_STOP on

-- From the repository root in Windows CMD, with DIRECT_URL set to the Neon
-- direct neondb_owner connection string:
-- psql "%DIRECT_URL%" -v expected_database=neondb -f backend\db\03-neon-production-grants.sql

-- This script manages bv_app's object grants; it does not change database-wide
-- privileges granted to PUBLIC (for example, PostgreSQL's default TEMPORARY).

\if :{?expected_database}
\else
\echo 'Set expected_database to the exact Neon database name before running this script.'
\quit 3
\endif

SELECT current_database() = :'expected_database' AS bv_expected_database \gset
\if :bv_expected_database
\else
\echo 'Connected to a database other than expected_database; no grants were changed.'
\quit 3
\endif

BEGIN;

DO $preflight$
DECLARE
  v_app_oid oid;
  v_owner_oid oid;
  v_account_owner oid;
  v_balance_owner oid;
  v_guard_owner oid;
  v_expected_migrations text[] := ARRAY[
    '20261109103331_init',
    '20261111055105_db_integrity',
    '20261111064327_ledger_posting_window',
    '20261111064418_ledger_posting_window',
    '20261111182457_onboarding_active_unique',
    '20261111182458_account_balance_cache',
    '20261111183422_system_account_update_guard'
  ];
BEGIN
  IF current_user <> 'neondb_owner' THEN
    RAISE EXCEPTION 'Run this script as neondb_owner; current_user is %', current_user;
  END IF;

  SELECT oid
    INTO v_owner_oid
    FROM pg_roles
   WHERE rolname = current_user;

  SELECT oid
    INTO v_app_oid
    FROM pg_roles
   WHERE rolname = 'bv_app';

  IF v_app_oid IS NULL THEN
    RAISE EXCEPTION 'Required runtime role bv_app does not exist';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM pg_roles
     WHERE oid = v_app_oid
       AND (
         NOT rolcanlogin
         OR rolsuper
         OR rolcreatedb
         OR rolcreaterole
         OR rolreplication
         OR rolbypassrls
       )
  ) THEN
    RAISE EXCEPTION 'bv_app must be a login role without elevated role attributes';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM pg_auth_members
     WHERE member = v_app_oid
        OR (
          roleid = v_app_oid
          AND (
            member <> v_owner_oid
            OR NOT admin_option
          )
        )
  ) OR NOT EXISTS (
    SELECT 1
      FROM pg_auth_members
     WHERE roleid = v_app_oid
       AND member = v_owner_oid
       AND admin_option
  ) THEN
    RAISE EXCEPTION 'bv_app may only have neondb_owner as a member with ADMIN OPTION, and must not be a member of another role';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname = ANY (ARRAY[
         'User', 'Session', 'OnboardingApplication', 'Account',
         'LedgerTransaction', 'LedgerEntry', 'IdempotencyRecord', 'AuditLog'
       ])
       AND c.relowner = v_app_oid
  ) THEN
    RAISE EXCEPTION 'bv_app must not own application tables';
  END IF;

  IF to_regclass('public."_prisma_migrations"') IS NULL THEN
    RAISE EXCEPTION 'Prisma migration history is missing';
  END IF;

  IF (
    SELECT count(DISTINCT migration_name)
      FROM public."_prisma_migrations"
     WHERE migration_name = ANY (v_expected_migrations)
       AND finished_at IS NOT NULL
       AND rolled_back_at IS NULL
  ) <> cardinality(v_expected_migrations) THEN
    RAISE EXCEPTION 'All seven expected Prisma migrations must be successfully applied';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname = ANY (ARRAY[
         'User', 'Session', 'OnboardingApplication', 'Account',
         'LedgerTransaction', 'LedgerEntry', 'IdempotencyRecord', 'AuditLog',
         'LedgerEntry_id_seq', 'AuditLog_id_seq'
       ])
       AND c.relowner <> v_owner_oid
  ) THEN
    RAISE EXCEPTION 'Application tables and runtime sequences must be owned by neondb_owner';
  END IF;

  SELECT relowner
    INTO v_account_owner
    FROM pg_class
    JOIN pg_namespace ON pg_namespace.oid = pg_class.relnamespace
   WHERE pg_namespace.nspname = 'public'
     AND pg_class.relname = 'Account';

  IF v_account_owner IS NULL OR v_account_owner <> v_owner_oid THEN
    RAISE EXCEPTION 'public.Account must be owned by neondb_owner';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname = 'bv_update_account_balance_from_ledger'
       AND p.pronargs = 0
       AND p.proowner = v_account_owner
       AND p.prosecdef
       AND p.proconfig @> ARRAY['search_path=pg_catalog']
       AND NOT has_function_privilege(v_app_oid, p.oid, 'EXECUTE')
       AND NOT EXISTS (
         SELECT 1
           FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) acl
          WHERE acl.grantee = 0
            AND acl.privilege_type = 'EXECUTE'
       )
  ) THEN
    RAISE EXCEPTION 'Balance-cache function ownership, SECURITY DEFINER settings, search_path, or EXECUTE restrictions are invalid';
  END IF;

  SELECT p.proowner
    INTO v_balance_owner
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname = 'bv_update_account_balance_from_ledger'
     AND p.pronargs = 0;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname = 'bv_reject_system_account_app_updates'
       AND p.pronargs = 0
       AND p.proowner = v_account_owner
       AND NOT p.prosecdef
       AND p.proconfig @> ARRAY['search_path=pg_catalog']
       AND NOT has_function_privilege(v_app_oid, p.oid, 'EXECUTE')
       AND NOT EXISTS (
         SELECT 1
           FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) acl
          WHERE acl.grantee = 0
            AND acl.privilege_type = 'EXECUTE'
       )
  ) THEN
    RAISE EXCEPTION 'SYSTEM-account guard function ownership, security mode, search_path, or EXECUTE restrictions are invalid';
  END IF;

  SELECT p.proowner
    INTO v_guard_owner
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname = 'bv_reject_system_account_app_updates'
     AND p.pronargs = 0;

  IF v_balance_owner IS DISTINCT FROM v_account_owner
     OR v_guard_owner IS DISTINCT FROM v_account_owner THEN
    RAISE EXCEPTION 'Balance-cache and SYSTEM-account guard functions must share the Account owner';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM (VALUES
        ('LedgerEntry', 'LedgerEntry_append_only_row'),
        ('LedgerEntry', 'LedgerEntry_append_only_truncate'),
        ('LedgerEntry', 'LedgerEntry_balanced'),
        ('LedgerEntry', 'LedgerEntry_posting_window'),
        ('LedgerEntry', 'LedgerEntry_balance_cache'),
        ('LedgerTransaction', 'LedgerTransaction_append_only_row'),
        ('LedgerTransaction', 'LedgerTransaction_append_only_truncate'),
        ('LedgerTransaction', 'LedgerTransaction_has_entries'),
        ('LedgerTransaction', 'LedgerTransaction_stamp_posting_txid'),
        ('AuditLog', 'AuditLog_append_only_row'),
        ('AuditLog', 'AuditLog_append_only_truncate'),
        ('Account', 'Account_reject_app_system_update')
      ) AS expected(table_name, trigger_name)
      LEFT JOIN pg_class c
        ON c.relname = expected.table_name
       AND c.relnamespace = 'public'::regnamespace
      LEFT JOIN pg_trigger t
        ON t.tgrelid = c.oid
       AND t.tgname = expected.trigger_name
       AND NOT t.tgisinternal
     WHERE c.oid IS NULL
        OR t.oid IS NULL
        OR t.tgenabled <> 'A'
  ) THEN
    RAISE EXCEPTION 'Required ledger, audit, balance-cache, or SYSTEM-account triggers are missing or not ENABLE ALWAYS';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl, acldefault('r', c.relowner))) acl
     WHERE n.nspname = 'public'
       AND c.relname = ANY (ARRAY[
         'User', 'Session', 'OnboardingApplication', 'Account',
         'LedgerTransaction', 'LedgerEntry', 'IdempotencyRecord', 'AuditLog'
       ])
       AND acl.grantee = 0
  ) OR EXISTS (
    SELECT 1
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_attribute a ON a.attrelid = c.oid
      CROSS JOIN LATERAL aclexplode(a.attacl) acl
     WHERE n.nspname = 'public'
       AND c.relname = ANY (ARRAY[
         'User', 'Session', 'OnboardingApplication', 'Account',
         'LedgerTransaction', 'LedgerEntry', 'IdempotencyRecord', 'AuditLog'
       ])
       AND a.attnum > 0
       AND NOT a.attisdropped
       AND acl.grantee = 0
  ) THEN
    RAISE EXCEPTION 'PUBLIC has privileges on application tables; review those grants before applying bv_app privileges';
  END IF;
END;
$preflight$;

REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM bv_app;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM bv_app;
REVOKE CREATE ON SCHEMA public FROM bv_app;
GRANT USAGE ON SCHEMA public TO bv_app;

DO $database_connect$
BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO bv_app', current_database());
END;
$database_connect$;

-- User reads omit updatedAt except for the admin listing; password and
-- lockout columns are required for authentication and lockout management.
GRANT SELECT (
  "id", "email", "fullName", "passwordHash", "role", "status",
  "mustChangePassword", "failedLoginCount", "lockedUntil",
  "createdAt", "updatedAt"
) ON TABLE public."User" TO bv_app;
GRANT INSERT (
  "id", "email", "fullName", "passwordHash", "updatedAt"
) ON TABLE public."User" TO bv_app;
GRANT UPDATE (
  "status", "failedLoginCount", "lockedUntil", "updatedAt"
) ON TABLE public."User" TO bv_app;

GRANT SELECT (
  "id", "tokenHash", "userId", "createdAt", "lastSeenAt", "expiresAt", "revokedAt"
) ON TABLE public."Session" TO bv_app;
GRANT INSERT (
  "id", "tokenHash", "userId", "expiresAt"
) ON TABLE public."Session" TO bv_app;
GRANT UPDATE ("lastSeenAt", "revokedAt") ON TABLE public."Session" TO bv_app;

GRANT SELECT ON TABLE public."OnboardingApplication" TO bv_app;
GRANT INSERT (
  "id", "userId", "legalName", "dateOfBirth", "phone",
  "addressLine", "city", "country", "updatedAt"
) ON TABLE public."OnboardingApplication" TO bv_app;
GRANT UPDATE (
  "status", "reviewedById", "reviewedAt", "reviewNote", "updatedAt"
) ON TABLE public."OnboardingApplication" TO bv_app;

GRANT SELECT ON TABLE public."Account" TO bv_app;
GRANT INSERT (
  "id", "accountNumber", "currency", "ownerId", "updatedAt"
) ON TABLE public."Account" TO bv_app;
GRANT UPDATE ("status", "updatedAt") ON TABLE public."Account" TO bv_app;

GRANT SELECT (
  "id", "reference", "type", "postedTxid", "createdAt"
) ON TABLE public."LedgerTransaction" TO bv_app;
GRANT INSERT (
  "id", "reference", "type", "description", "createdById"
) ON TABLE public."LedgerTransaction" TO bv_app;

GRANT SELECT (
  "id", "transactionId", "accountId", "direction", "amountMinor"
) ON TABLE public."LedgerEntry" TO bv_app;
GRANT INSERT (
  "transactionId", "accountId", "direction", "amountMinor"
) ON TABLE public."LedgerEntry" TO bv_app;

GRANT SELECT (
  "id", "userId", "key", "requestHash", "transactionId"
) ON TABLE public."IdempotencyRecord" TO bv_app;
GRANT INSERT (
  "id", "userId", "key", "requestHash", "transactionId"
) ON TABLE public."IdempotencyRecord" TO bv_app;

-- The API deliberately omits requestId and ipAddress from audit reads.
GRANT SELECT (
  "id", "actorId", "action", "targetType", "targetId",
  "outcome", "metadata", "createdAt"
) ON TABLE public."AuditLog" TO bv_app;
GRANT INSERT (
  "actorId", "action", "targetType", "targetId", "outcome",
  "requestId", "ipAddress", "metadata"
) ON TABLE public."AuditLog" TO bv_app;

GRANT USAGE ON SEQUENCE
  public."LedgerEntry_id_seq",
  public."AuditLog_id_seq"
TO bv_app;

GRANT USAGE ON TYPE
  public."Role",
  public."UserStatus",
  public."ApplicationStatus",
  public."AccountKind",
  public."AccountStatus",
  public."LedgerTransactionType",
  public."EntryDirection",
  public."AuditOutcome"
TO bv_app;

DO $postflight$
BEGIN
  IF has_schema_privilege('bv_app', 'public', 'CREATE') THEN
    RAISE EXCEPTION 'bv_app must not have CREATE on schema public';
  END IF;

  IF has_table_privilege('bv_app', 'public."LedgerTransaction"', 'UPDATE')
     OR has_table_privilege('bv_app', 'public."LedgerTransaction"', 'DELETE')
     OR has_table_privilege('bv_app', 'public."LedgerTransaction"', 'TRUNCATE')
     OR has_table_privilege('bv_app', 'public."LedgerEntry"', 'UPDATE')
     OR has_table_privilege('bv_app', 'public."LedgerEntry"', 'DELETE')
     OR has_table_privilege('bv_app', 'public."LedgerEntry"', 'TRUNCATE')
     OR has_table_privilege('bv_app', 'public."AuditLog"', 'UPDATE')
     OR has_table_privilege('bv_app', 'public."AuditLog"', 'DELETE')
     OR has_table_privilege('bv_app', 'public."AuditLog"', 'TRUNCATE') THEN
    RAISE EXCEPTION 'bv_app has a forbidden UPDATE, DELETE, or TRUNCATE privilege on append-only data';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM pg_attribute a
     WHERE a.attrelid IN (
       'public."LedgerTransaction"'::regclass,
       'public."LedgerEntry"'::regclass,
       'public."AuditLog"'::regclass
     )
       AND a.attnum > 0
       AND NOT a.attisdropped
       AND has_column_privilege(
         'bv_app',
         a.attrelid,
         a.attname,
         'UPDATE'
       )
  ) THEN
    RAISE EXCEPTION 'bv_app has a forbidden column-level UPDATE privilege on append-only data';
  END IF;

  IF has_column_privilege('bv_app', 'public."Account"', 'balanceMinor', 'UPDATE')
     OR has_column_privilege('bv_app', 'public."Account"', 'kind', 'INSERT')
     OR has_column_privilege('bv_app', 'public."LedgerTransaction"', 'postedTxid', 'INSERT') THEN
    RAISE EXCEPTION 'bv_app has a forbidden privilege that can bypass account or posting protections';
  END IF;

  IF has_function_privilege('bv_app', 'public.bv_update_account_balance_from_ledger()', 'EXECUTE')
     OR has_function_privilege('bv_app', 'public.bv_reject_system_account_app_updates()', 'EXECUTE') THEN
    RAISE EXCEPTION 'bv_app must not execute protected trigger functions directly';
  END IF;

  IF NOT has_type_privilege('bv_app', 'public."Role"', 'USAGE')
     OR NOT has_type_privilege('bv_app', 'public."UserStatus"', 'USAGE')
     OR NOT has_type_privilege('bv_app', 'public."ApplicationStatus"', 'USAGE')
     OR NOT has_type_privilege('bv_app', 'public."AccountKind"', 'USAGE')
     OR NOT has_type_privilege('bv_app', 'public."AccountStatus"', 'USAGE')
     OR NOT has_type_privilege('bv_app', 'public."LedgerTransactionType"', 'USAGE')
     OR NOT has_type_privilege('bv_app', 'public."EntryDirection"', 'USAGE')
     OR NOT has_type_privilege('bv_app', 'public."AuditOutcome"', 'USAGE') THEN
    RAISE EXCEPTION 'bv_app must have USAGE on the application enum types';
  END IF;
END;
$postflight$;

COMMIT;
