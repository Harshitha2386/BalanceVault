\set ON_ERROR_STOP on

\echo '=== SAFETY: database must be balancevault_dev or balancevault_test ==='
SELECT CASE
         WHEN current_database() IN ('balancevault_dev', 'balancevault_test')
           THEN 'true'
         ELSE 'false'
       END AS bv_allowed_database
\gset

\if :bv_allowed_database
  SELECT current_database() AS connected_database,
         current_user AS connected_role;
\else
  \echo 'FAIL: connect only to balancevault_dev or balancevault_test'
  \quit 3
\endif

\echo '=== DUPLICATE USERS: more than one PENDING or APPROVED application ==='
SELECT
  "userId" AS "userId",
  array_agg("id"::text ORDER BY "createdAt", "id") AS application_ids,
  array_agg("status"::text ORDER BY "createdAt", "id") AS application_statuses,
  count(*) AS active_application_count
FROM "OnboardingApplication"
WHERE "status" IN (
  'PENDING'::"ApplicationStatus",
  'APPROVED'::"ApplicationStatus"
)
GROUP BY "userId"
HAVING count(*) > 1
ORDER BY "userId";

SELECT
  count(*) AS duplicate_user_count,
  CASE WHEN count(*) > 0 THEN 'true' ELSE 'false' END AS duplicate_conflict
FROM (
  SELECT "userId"
  FROM "OnboardingApplication"
  WHERE "status" IN (
    'PENDING'::"ApplicationStatus",
    'APPROVED'::"ApplicationStatus"
  )
  GROUP BY "userId"
  HAVING count(*) > 1
) AS duplicate_users
\gset

\echo '=== SUMMARY ==='
\echo 'Users with conflicting active applications: ' :duplicate_user_count
SELECT
  count(*) FILTER (
    WHERE "status" IN (
      'PENDING'::"ApplicationStatus",
      'APPROVED'::"ApplicationStatus"
    )
  ) AS total_active_applications,
  count(*) FILTER (
    WHERE "status" = 'REJECTED'::"ApplicationStatus"
  ) AS total_rejected_applications
FROM "OnboardingApplication";

\if :duplicate_conflict
  \echo 'RESULT: CONFLICTS FOUND; resolve duplicates before creating the partial unique index.'
\else
  \echo 'RESULT: NO EXISTING-DATA CONFLICTS; the proposed partial unique index can be created without duplicate-active-row conflicts.'
\endif
