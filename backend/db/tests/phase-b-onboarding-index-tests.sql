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

\echo '=== VERIFY: expected unique partial index exists ==='
DO $test$
DECLARE
  v_is_unique boolean;
  v_is_partial boolean;
  v_user_id_column text;
  v_predicate text;
BEGIN
  SELECT i.indisunique,
         i.indpred IS NOT NULL,
         pg_get_indexdef(i.indexrelid, 1, true),
         pg_get_expr(i.indpred, i.indrelid)
    INTO v_is_unique, v_is_partial, v_user_id_column, v_predicate
    FROM pg_index AS i
    JOIN pg_class AS index_class ON index_class.oid = i.indexrelid
    JOIN pg_namespace AS index_schema ON index_schema.oid = index_class.relnamespace
   WHERE index_schema.nspname = 'public'
     AND index_class.relname = 'OnboardingApplication_userId_active_key'
     AND i.indrelid = 'public."OnboardingApplication"'::regclass;

  IF NOT FOUND
     OR NOT v_is_unique
     OR NOT v_is_partial
     OR v_user_id_column <> '"userId"'
     OR position('PENDING' IN v_predicate) = 0
     OR position('APPROVED' IN v_predicate) = 0 THEN
    RAISE EXCEPTION
      'FAIL: expected unique partial index on userId for PENDING and APPROVED';
  END IF;

  RAISE NOTICE 'PASS: unique partial index and active-status predicate are present';
END
$test$;

\echo '=== SETUP: create synthetic user and application IDs ==='
SELECT gen_random_uuid()::text AS phase_b_user_id \gset
SELECT gen_random_uuid()::text AS phase_b_other_user_id \gset
SELECT gen_random_uuid()::text AS phase_b_pending_id \gset
SELECT gen_random_uuid()::text AS phase_b_duplicate_pending_id \gset
SELECT gen_random_uuid()::text AS phase_b_rejected_id \gset
SELECT gen_random_uuid()::text AS phase_b_extra_id \gset
SELECT gen_random_uuid()::text AS phase_b_attempt_id \gset
SELECT gen_random_uuid()::text AS phase_b_other_application_id \gset
SELECT set_config('bv.phase_b.onboarding_user_id', :'phase_b_user_id', false);
SELECT set_config('bv.phase_b.onboarding_other_user_id', :'phase_b_other_user_id', false);
SELECT set_config('bv.phase_b.onboarding_pending_id', :'phase_b_pending_id', false);
SELECT set_config('bv.phase_b.onboarding_duplicate_pending_id', :'phase_b_duplicate_pending_id', false);
SELECT set_config('bv.phase_b.onboarding_rejected_id', :'phase_b_rejected_id', false);
SELECT set_config('bv.phase_b.onboarding_extra_id', :'phase_b_extra_id', false);
SELECT set_config('bv.phase_b.onboarding_attempt_id', :'phase_b_attempt_id', false);
SELECT set_config('bv.phase_b.onboarding_other_application_id', :'phase_b_other_application_id', false);

BEGIN;

INSERT INTO public."User" (
  "id", "email", "fullName", "passwordHash", "updatedAt"
)
VALUES (
  :'phase_b_user_id'::uuid,
  'phase-b-' || :'phase_b_user_id' || '@example.test',
  'Synthetic Phase B Applicant',
  'synthetic-not-a-password-hash',
  now()
);

INSERT INTO public."OnboardingApplication" (
  "id", "userId", "legalName", "dateOfBirth", "phone",
  "addressLine", "city", "country", "updatedAt"
)
VALUES (
  :'phase_b_pending_id'::uuid,
  :'phase_b_user_id'::uuid,
  'Synthetic Applicant',
  DATE '2000-01-01',
  '0000000000',
  'Synthetic Test Address',
  'Test City',
  'IN',
  now()
);

\echo '=== T01 a second PENDING application for the user is rejected ==='
DO $test$
DECLARE
  v_user_id uuid := current_setting('bv.phase_b.onboarding_user_id')::uuid;
  v_application_id uuid := current_setting('bv.phase_b.onboarding_duplicate_pending_id')::uuid;
  v_constraint_name text;
  v_rejected boolean := false;
BEGIN
  BEGIN
    INSERT INTO public."OnboardingApplication" (
      "id", "userId", "legalName", "dateOfBirth", "phone",
      "addressLine", "city", "country", "updatedAt"
    )
    VALUES (
      v_application_id, v_user_id, 'Synthetic Duplicate',
      DATE '2000-01-01', '0000000000', 'Synthetic Test Address',
      'Test City', 'IN', now()
    );
  EXCEPTION WHEN unique_violation THEN
    GET STACKED DIAGNOSTICS v_constraint_name = CONSTRAINT_NAME;
    IF v_constraint_name <> 'OnboardingApplication_userId_active_key' THEN
      RAISE EXCEPTION
        'FAIL: duplicate PENDING failed on unexpected constraint %',
        v_constraint_name;
    END IF;
    v_rejected := true;
  END;

  IF NOT v_rejected THEN
    RAISE EXCEPTION 'FAIL: duplicate PENDING application was accepted';
  END IF;
  RAISE NOTICE 'PASS: duplicate PENDING application rejected';
END
$test$;

\echo '=== T02 a REJECTED application does not prevent a new PENDING application ==='
UPDATE public."OnboardingApplication"
   SET "status" = 'REJECTED'::public."ApplicationStatus",
       "updatedAt" = now()
 WHERE "id" = :'phase_b_pending_id'::uuid;

INSERT INTO public."OnboardingApplication" (
  "id", "userId", "legalName", "dateOfBirth", "phone",
  "addressLine", "city", "country", "updatedAt"
)
VALUES (
  :'phase_b_rejected_id'::uuid,
  :'phase_b_user_id'::uuid,
  'Synthetic Second Applicant',
  DATE '2000-01-01',
  '0000000000',
  'Synthetic Test Address',
  'Test City',
  'IN',
  now()
);

\echo '=== T03 PENDING and APPROVED for the same user are rejected ==='
DO $test$
DECLARE
  v_application_id uuid := current_setting('bv.phase_b.onboarding_pending_id')::uuid;
  v_constraint_name text;
  v_rejected boolean := false;
BEGIN
  BEGIN
    UPDATE public."OnboardingApplication"
       SET "status" = 'APPROVED'::public."ApplicationStatus",
           "updatedAt" = now()
     WHERE "id" = v_application_id;
  EXCEPTION WHEN unique_violation THEN
    GET STACKED DIAGNOSTICS v_constraint_name = CONSTRAINT_NAME;
    IF v_constraint_name <> 'OnboardingApplication_userId_active_key' THEN
      RAISE EXCEPTION
        'FAIL: PENDING/APPROVED combination failed on unexpected constraint %',
        v_constraint_name;
    END IF;
    v_rejected := true;
  END;

  IF NOT v_rejected THEN
    RAISE EXCEPTION 'FAIL: PENDING and APPROVED applications for one user were accepted';
  END IF;
  RAISE NOTICE 'PASS: PENDING/APPROVED combination rejected';
END
$test$;

\echo '=== T04 a new PENDING application is allowed after prior applications are REJECTED ==='
UPDATE public."OnboardingApplication"
   SET "status" = 'REJECTED'::public."ApplicationStatus",
       "updatedAt" = now()
 WHERE "id" = :'phase_b_rejected_id'::uuid;

\echo '=== T04 continued: a new active row can be created beside rejected rows ==='
INSERT INTO public."OnboardingApplication" (
  "id", "userId", "legalName", "dateOfBirth", "phone",
  "addressLine", "city", "country", "updatedAt"
)
VALUES (
  :'phase_b_extra_id'::uuid,
  :'phase_b_user_id'::uuid,
  'Synthetic Replacement Applicant',
  DATE '2000-01-01',
  '0000000000',
  'Synthetic Test Address',
  'Test City',
  'IN',
  now()
);

UPDATE public."OnboardingApplication"
   SET "status" = 'APPROVED'::public."ApplicationStatus",
       "updatedAt" = now()
 WHERE "id" = :'phase_b_extra_id'::uuid;

\echo '=== T05 multiple APPROVED applications for one user are rejected ==='
DO $test$
DECLARE
  v_application_id uuid := current_setting('bv.phase_b.onboarding_rejected_id')::uuid;
  v_constraint_name text;
  v_rejected boolean := false;
BEGIN
  BEGIN
    UPDATE public."OnboardingApplication"
       SET "status" = 'APPROVED'::public."ApplicationStatus",
           "updatedAt" = now()
     WHERE "id" = v_application_id;
  EXCEPTION WHEN unique_violation THEN
    GET STACKED DIAGNOSTICS v_constraint_name = CONSTRAINT_NAME;
    IF v_constraint_name <> 'OnboardingApplication_userId_active_key' THEN
      RAISE EXCEPTION
        'FAIL: duplicate APPROVED failed on unexpected constraint %',
        v_constraint_name;
    END IF;
    v_rejected := true;
  END;

  IF NOT v_rejected THEN
    RAISE EXCEPTION 'FAIL: a second APPROVED application was accepted';
  END IF;
  RAISE NOTICE 'PASS: multiple APPROVED applications rejected';
END
$test$;

\echo '=== T06 a new PENDING application is rejected while APPROVED exists ==='
DO $test$
DECLARE
  v_user_id uuid := current_setting('bv.phase_b.onboarding_user_id')::uuid;
  v_application_id uuid := current_setting('bv.phase_b.onboarding_attempt_id')::uuid;
  v_constraint_name text;
  v_rejected boolean := false;
BEGIN
  BEGIN
    INSERT INTO public."OnboardingApplication" (
      "id", "userId", "legalName", "dateOfBirth", "phone",
      "addressLine", "city", "country", "updatedAt"
    )
    VALUES (
      v_application_id, v_user_id, 'Synthetic Third Application',
      DATE '2000-01-01', '0000000000', 'Synthetic Test Address',
      'Test City', 'IN', now()
    );
  EXCEPTION WHEN unique_violation THEN
    GET STACKED DIAGNOSTICS v_constraint_name = CONSTRAINT_NAME;
    IF v_constraint_name <> 'OnboardingApplication_userId_active_key' THEN
      RAISE EXCEPTION
        'FAIL: pending insert beside APPROVED failed on unexpected constraint %',
        v_constraint_name;
    END IF;
    v_rejected := true;
  END;

  IF NOT v_rejected THEN
    RAISE EXCEPTION 'FAIL: PENDING application alongside APPROVED was accepted';
  END IF;
  RAISE NOTICE 'PASS: PENDING application alongside APPROVED rejected';
END
$test$;

\echo '=== T07 separate users may each have an active application ==='
INSERT INTO public."User" (
  "id", "email", "fullName", "passwordHash", "updatedAt"
)
VALUES (
  :'phase_b_other_user_id'::uuid,
  'phase-b-' || :'phase_b_other_user_id' || '@example.test',
  'Synthetic Second Applicant',
  'synthetic-not-a-password-hash',
  now()
);

INSERT INTO public."OnboardingApplication" (
  "id", "userId", "legalName", "dateOfBirth", "phone",
  "addressLine", "city", "country", "updatedAt"
)
VALUES (
  :'phase_b_other_application_id'::uuid,
  :'phase_b_other_user_id'::uuid,
  'Synthetic Second Applicant',
  DATE '2000-01-01',
  '0000000000',
  'Synthetic Test Address',
  'Test City',
  'IN',
  now()
);

DO $test$
DECLARE
  v_user_id uuid := current_setting('bv.phase_b.onboarding_user_id')::uuid;
  v_other_user_id uuid := current_setting('bv.phase_b.onboarding_other_user_id')::uuid;
  v_active_count bigint;
  v_active_status public."ApplicationStatus";
BEGIN
  SELECT count(*), min("status"::text)::public."ApplicationStatus"
    INTO v_active_count, v_active_status
    FROM public."OnboardingApplication"
   WHERE "userId" = v_user_id
     AND "status" IN (
       'PENDING'::public."ApplicationStatus",
       'APPROVED'::public."ApplicationStatus"
     );

  IF v_active_count <> 1 OR v_active_status <> 'APPROVED' THEN
    RAISE EXCEPTION
      'FAIL: first user expected one APPROVED application, found count=% status=%',
      v_active_count, v_active_status;
  END IF;

  SELECT count(*), min("status"::text)::public."ApplicationStatus"
    INTO v_active_count, v_active_status
    FROM public."OnboardingApplication"
   WHERE "userId" = v_other_user_id
     AND "status" IN (
       'PENDING'::public."ApplicationStatus",
       'APPROVED'::public."ApplicationStatus"
     );

  IF v_active_count <> 1 OR v_active_status <> 'PENDING' THEN
    RAISE EXCEPTION
      'FAIL: second user expected one PENDING application, found count=% status=%',
      v_active_count, v_active_status;
  END IF;
  RAISE NOTICE 'PASS: different users each have one active application';
END
$test$;

ROLLBACK;

RESET bv.phase_b.onboarding_user_id;
RESET bv.phase_b.onboarding_other_user_id;
RESET bv.phase_b.onboarding_pending_id;
RESET bv.phase_b.onboarding_duplicate_pending_id;
RESET bv.phase_b.onboarding_rejected_id;
RESET bv.phase_b.onboarding_extra_id;
RESET bv.phase_b.onboarding_attempt_id;
RESET bv.phase_b.onboarding_other_application_id;
\echo 'PASS: all synthetic onboarding rows were rolled back'
