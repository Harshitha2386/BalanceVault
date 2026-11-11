# AI-assisted development record

This log records meaningful development tasks and separates retained evidence
from historical details that are unavailable. The project-wide AI disclosure
is Claude (Free), ChatGPT and GitHub Copilot. The available record does not
reliably attribute each earlier task to one of those tools or retain exact
prompt text; historical prompts below are labelled faithful summaries rather
than quotations. No historical commit hash is inferred.

## Database integrity and role boundaries — Phases B and V

- **Date:** Historical date not retained.
- **Tool:** Per-task tool attribution not retained; see project-wide disclosure.
- **Prompt:** Faithful summary — inspect and enforce PostgreSQL integrity for
  account balances, owner/SYSTEM account rules, lowercase email, balanced
  append-only ledger posting, posting-window restrictions and least-privilege
  `bv_app` grants. Add SQL tests without changing applied migrations.
- **Proposed/implemented:** Versioned PostgreSQL migrations and SQL tests
  enforce ledger posting windows, trigger protections, balance-cache updates,
  active-onboarding uniqueness and restricted grants.
- **What was wrong or risky:** No specific AI proposal error is retained for
  this task. Important risk: SQL constraints/triggers and Prisma's declarative
  schema do not describe every database object, so migration history and
  provider compatibility must be preserved and checked.
- **How checked / evidence:** The user reported Phase V owner/runtime-role
  suites passed on `balancevault_test`, including posting-window, append-only,
  grants and trigger-bypass checks. Relevant evidence is in
  `backend/prisma/migrations/` and `backend/db/tests/`. These Phase V results
  were user-reported, not rerun as part of this documentation task.
- **Commit:** No task-specific commit hash retained. The latest known earlier
  repository commit is `c5a718f`; it is not asserted to contain all Phase B
  work.

## Authentication, sessions and RBAC — Phases D and E

- **Date:** Historical date not retained.
- **Tool:** Per-task tool attribution not retained; see project-wide disclosure.
- **Prompt:** Faithful summary — implement account-holder authentication with
  opaque server-side sessions, password hashing, CSRF/Origin checks, rate
  limiting, database-backed roles and a first-admin process that cannot be
  called through a public endpoint.
- **Proposed/implemented:** Authentication and authorization middleware,
  session lifecycle, strict request validation, and an owner-connected admin
  bootstrap CLI with database identity checks and audit logging.
- **What was wrong or risky:** No specific AI proposal error is retained.
  Bootstrap is intentionally limited to `balancevault_test`; this is not a
  production provisioning tool and must not be bypassed.
- **How checked / evidence:** Backend automated tests and guarded
  `balancevault_test` runtime/owner checks are documented in
  `backend/README.md` and `THREATS.md`; see
  `backend/src/services/admin-bootstrap-service.js`,
  `backend/src/services/session-service.js`, and
  `backend/src/middleware/authorization.js`.
- **Commit:** No task-specific hash retained.

## Onboarding and admin access control — Phases F and H

- **Date:** Historical date not retained.
- **Tool:** Per-task tool attribution not retained; see project-wide disclosure.
- **Prompt:** Faithful summary — implement customer-owned onboarding and
  account resources, admin review/user-management/audit routes, deny IDOR,
  prevent role changes and self/last-admin disablement, and preserve database
  grants and append-only audit controls.
- **Proposed/implemented:** Owner-scoped services, admin-only paginated
  handlers, status changes that do not alter roles, session revocation and
  audit recording.
- **What was wrong or risky:** A Phase I admin integration assertion initially
  assumed the target admin would appear in the first five-row page. It failed;
  the harness was corrected to check pagination and safe response fields
  instead. This is the only retained correction for that test path.
- **How checked / evidence:** Automated admin/authorization tests and a
  rollback-only PostgreSQL admin integration were reported passing. See
  `backend/src/routes/admin-management-routes.js`,
  `backend/src/services/admin-management-service.js` and
  `backend/test/admin-management.test.js`.
- **Commit:** No task-specific hash retained.

## Ledger transfers, idempotency and concurrency — Phase G

- **Date:** Historical date not retained.
- **Tool:** Per-task tool attribution not retained; see project-wide disclosure.
- **Prompt:** Faithful summary — implement transfers through the append-only
  ledger with account locks, overdraft protection, stable idempotency and
  audited administrative funding; verify real PostgreSQL concurrency using
  only `balancevault_test`.
- **Proposed/implemented:** Integer paise values, ordered account locking,
  transactional ledger posting, request hashing and idempotency records, plus
  balance-cache updates through a database trigger.
- **What was wrong or risky:** No specific AI proposal error is retained.
  Real concurrency tests append rows that cannot be deleted; those checks must
  stay on `balancevault_test`.
- **How checked / evidence:** The Phase I record reports real PostgreSQL
  duplicate-request and 20-request low-balance checks: one stored result for
  concurrent duplicates, and 10 accepted/10 insufficient-funds responses
  against a 1,000-paise balance. Synthetic append-only rows remain in the test
  database. See `backend/src/services/transfer-service.js` and
  `THREATS.md`.
- **Commit:** No task-specific hash retained.

## Security verification and threat evidence — Phase I

- **Date:** Historical date not retained.
- **Tool:** Per-task tool attribution not retained; see project-wide disclosure.
- **Prompt:** Faithful summary — exercise authentication, authorization,
  ownership, transfer validation/idempotency/concurrency, session revocation,
  brute-force/CSRF controls, ledger/audit protections and admin boundaries;
  fix genuine defects and write only observed threat results.
- **Proposed/implemented:** A security integration runner and threat-model
  evidence were added; sensitive checks used `balancevault_test` and
  `bv_app`, with rollback-only checks where possible.
- **What was wrong or risky:** The admin-list integration's first-page
  assumption described above was corrected after the observed failure. No
  broader AI mistake is inferred.
- **How checked / evidence:** The available Phase I report records 106 passing
  backend tests, selected PostgreSQL integrations and the bounded concurrency
  results. Exact historical command output and run dates are not retained
  here. See `backend/scripts/security-integration.js` and `THREATS.md`.
- **Commit:** No task-specific hash retained.

## React frontend integration — Phase J

- **Date:** Historical date not retained.
- **Tool:** Per-task tool attribution not retained; see project-wide disclosure.
- **Prompt:** Faithful summary — build a responsive React/Vite banking UI
  against actual backend endpoints, with centralized cookie/CSRF handling,
  account/onboarding/transfer/admin screens, integer-paise display and no
  fabricated financial data.
- **Proposed/implemented:** Login/register, customer pages, admin workflows,
  same-origin `/api` client, Vite development proxy, and INR conversion using
  integer minor units.
- **What was wrong or risky:** The backend has no password-change endpoint
  and transfer requests use account UUIDs; the UI communicates these actual
  contract limitations instead of inventing endpoints.
- **How checked / evidence:** The available Phase J report records frontend
  tests 3/3, a Vite production build, backend tests 106/106, syntax/diff checks,
  and limited browser checks (login/register at mobile width and protected
  route redirection). Authenticated screens were not fully browser-tested.
  See `frontend/src/` and `docs/REQUIREMENTS.md`.
- **Commit:** No task-specific hash retained.

## Integrated Render preparation and same-origin verification — Phase K

- **Date:** 2026-11-11, as stated in the project session instructions.
- **Tool:** GitHub Copilot (this interaction).
- **Prompt:** Faithful summary — prepare one Render service for the React build
  and Express API, inspect Neon/Prisma operational boundaries, and finish
  truthful deployment and security documentation without deploying or
  changing the database.
- **Proposed/implemented:** Express now serves `frontend/dist` and falls back
  to the SPA only for HTML navigation requests; unknown `/api` routes remain
  JSON 404s. The deployment config builds the two locked packages into one
  service. Production trusts only one Render proxy hop.
- **What was wrong or risky (observed):** A browser's same-origin GET omitted
  `Origin` but included `Sec-Fetch-Site: same-origin`; the existing CSRF-token
  GET rejected that request. This was reproduced in a browser and fixed only
  for CSRF-token issuance. State-changing endpoints still require exact
  allowed Origin and a valid CSRF token.
- **How checked / evidence:** Browser header observation; targeted backend
  regression tests for same-origin token issuance, rejection without an
  allowed signal, SPA fallback, static assets, API 404 isolation and health.
  Full backend tests passed 110/110; frontend tests passed 3/3; the Vite
  production build, both dependency trees, 64 JavaScript syntax checks, and
  `git diff --check` passed. A production-configured local smoke test returned
  healthy status, served an SPA deep link and returned JSON 404 for an unknown
  API path. Deployment, Neon and hosted browser behavior remain
  **NOT YET RUN**. See `backend/src/app.js`,
  `backend/src/middleware/origin.js`, `backend/test/foundation.test.js`,
  `backend/test/auth.test.js` and `render.yaml`.
- **Commit:** Not committed; no hash.

## Entry template

- **Date:**
- **Phase/task:**
- **Tool used (only if known):**
- **Exact prompt or labelled faithful summary:**
- **What the AI proposed/implemented:**
- **What was wrong or risky (leave blank unless observed):**
- **How I found it / correction:**
- **Evidence and exact test result:**
- **Commit hash (only after a real commit):**
