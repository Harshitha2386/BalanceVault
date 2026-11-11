
-- BalanceVault: least-privilege application grants
-- Run as postgres against balancevault_dev.
-- The application role must never own these tables.

GRANT USAGE ON SCHEMA public TO bv_app;

-- Remove existing table and sequence privileges.
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM bv_app;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM bv_app;

-- -------------------------------------------------------
-- USER
-- No permission to insert or update role/status.
-- Defaults create ACCOUNT_HOLDER users.
-- -------------------------------------------------------

GRANT SELECT ON "User" TO bv_app;

GRANT INSERT (
  "id", "email", "fullName", "passwordHash", "updatedAt"
)
ON "User" TO bv_app;

GRANT UPDATE (
  "fullName",
  "passwordHash",
  "mustChangePassword",
  "failedLoginCount",
  "lockedUntil",
  "updatedAt"
)
ON "User" TO bv_app;

-- -------------------------------------------------------
-- ONBOARDING APPLICATION
-- Application can submit and process applications.
-- Authorization must be enforced in the API.
-- -------------------------------------------------------

GRANT SELECT ON "OnboardingApplication" TO bv_app;

GRANT INSERT (
  "id", "userId", "legalName", "dateOfBirth",
  "phone", "addressLine", "city", "country", "updatedAt"
)
ON "OnboardingApplication" TO bv_app;

GRANT UPDATE (
  "status", "reviewedById", "reviewedAt",
  "reviewNote", "updatedAt"
)
ON "OnboardingApplication" TO bv_app;

-- -------------------------------------------------------
-- ACCOUNT
-- No direct balance updates.
-- CUSTOMER and ACTIVE are database defaults.
-- SYSTEM accounts must be provisioned separately.
-- -------------------------------------------------------

GRANT SELECT ON "Account" TO bv_app;

GRANT INSERT (
  "id", "accountNumber", "currency", "ownerId", "updatedAt"
)
ON "Account" TO bv_app;

GRANT UPDATE (
  "status", "updatedAt"
)
ON "Account" TO bv_app;

-- -------------------------------------------------------
-- SESSION
-- Sessions require normal lifecycle operations.
-- -------------------------------------------------------

GRANT SELECT, INSERT, UPDATE, DELETE
ON "Session" TO bv_app;

-- -------------------------------------------------------
-- LEDGER AND AUDIT
-- Append-only: SELECT and INSERT only.
-- -------------------------------------------------------

GRANT SELECT, INSERT
ON "LedgerTransaction", "LedgerEntry", "AuditLog", "IdempotencyRecord"
TO bv_app;

-- Auto-increment sequences.
GRANT USAGE
ON SEQUENCE "LedgerEntry_id_seq", "AuditLog_id_seq"
TO bv_app;

-- -------------------------------------------------------
-- PERMISSION SUMMARY
-- -------------------------------------------------------

SELECT
  table_name,
  privilege_type,
  column_name
FROM information_schema.role_column_grants
WHERE grantee = 'bv_app'

UNION ALL

SELECT
  table_name,
  privilege_type,
  NULL AS column_name
FROM information_schema.role_table_grants
WHERE grantee = 'bv_app'

ORDER BY table_name, privilege_type, column_name;
