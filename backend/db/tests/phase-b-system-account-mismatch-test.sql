-- Expected-failure safety test for the owner-run SYSTEM-account seed.
-- The seed's expected exception stops psql; connection close rolls back this
-- script's open transaction and restores/removes the synthetic conflict.

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

  IF EXISTS (
    SELECT 1
    FROM public."Account"
    WHERE "accountNumber" = 'BV-SYSTEM-FUNDING-INR'
      AND (
        "kind" <> 'SYSTEM'::public."AccountKind"
        OR "ownerId" IS NOT NULL
        OR "currency" <> 'INR'
      )
  ) THEN
    RAISE EXCEPTION
      'FAIL: existing seed account is already mismatched; refusing to alter it';
  END IF;
END
$test$;

SELECT gen_random_uuid()::text AS phase_b_conflict_user_id \gset
SELECT gen_random_uuid()::text AS phase_b_conflict_account_id \gset
SELECT EXISTS (
  SELECT 1
  FROM public."Account"
  WHERE "accountNumber" = 'BV-SYSTEM-FUNDING-INR'
) AS phase_b_seed_exists
\gset

BEGIN;

\if :phase_b_seed_exists
UPDATE public."Account"
   SET "currency" = 'USD'
 WHERE "accountNumber" = 'BV-SYSTEM-FUNDING-INR';
\else
INSERT INTO public."User" (
  "id", "email", "fullName", "passwordHash", "updatedAt"
)
VALUES (
  :'phase_b_conflict_user_id'::uuid,
  'phase-b-seed-conflict-' || :'phase_b_conflict_user_id' || '@example.test',
  'Synthetic Seed Conflict Owner',
  'synthetic-not-a-password-hash',
  now()
);

INSERT INTO public."Account" (
  "id", "accountNumber", "kind", "currency", "ownerId", "updatedAt"
)
VALUES (
  :'phase_b_conflict_account_id'::uuid,
  'BV-SYSTEM-FUNDING-INR',
  'CUSTOMER'::public."AccountKind",
  'INR',
  :'phase_b_conflict_user_id'::uuid,
  now()
);
\endif

\echo '=== EXPECTED FAILURE: seed rejects the mismatched account properties ==='
\ir ../seed-system-account.sql

\echo 'FAIL: seed unexpectedly accepted mismatched account properties'
\if :phase_b_seed_exists
UPDATE public."Account"
   SET "currency" = 'INR'
 WHERE "accountNumber" = 'BV-SYSTEM-FUNDING-INR';
\else
DELETE FROM public."Account"
 WHERE "accountNumber" = 'BV-SYSTEM-FUNDING-INR';

DELETE FROM public."User"
 WHERE "id" = :'phase_b_conflict_user_id'::uuid;
\endif
\quit 1
