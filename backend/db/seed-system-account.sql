\set ON_ERROR_STOP on

\echo '=== SAFETY: database must be balancevault_dev or balancevault_test ==='
SELECT current_database() IN ('balancevault_dev', 'balancevault_test')
  AS bv_allowed_database
\gset

\if :bv_allowed_database
  SELECT current_database() AS connected_database,
         current_user AS connected_role;
\else
  \echo 'FAIL: connect only to balancevault_dev or balancevault_test'
  \quit 3
\endif

\echo '=== SAFETY: SYSTEM account provisioning must run as postgres ==='
SELECT current_user = 'postgres' AS bv_is_owner
\gset

\if :bv_is_owner
\else
  \echo 'FAIL: run this seed script as postgres'
  \quit 3
\endif

BEGIN;

INSERT INTO public."Account" (
  "id", "accountNumber", "kind", "currency", "updatedAt"
)
VALUES (
  gen_random_uuid(),
  'BV-SYSTEM-FUNDING-INR',
  'SYSTEM'::public."AccountKind",
  'INR',
  now()
)
ON CONFLICT ("accountNumber") DO NOTHING;

DO $seed$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public."Account"
    WHERE "accountNumber" = 'BV-SYSTEM-FUNDING-INR'
      AND "kind" = 'SYSTEM'::public."AccountKind"
      AND "ownerId" IS NULL
      AND "currency" = 'INR'
  ) THEN
    RAISE EXCEPTION
      'SYSTEM seed account number exists with unexpected kind, owner, or currency';
  END IF;
END
$seed$;

COMMIT;

\echo 'PASS: exactly one stable funding account is present; existing balance was left unchanged'
