# BalanceVault threat verification

This is a focused record of Phase I security checks, not a production security
certification. Test dates were not retained in the available command output.
No deployment was tested. All database runtime checks below identified the
target as `balancevault_test` with role `bv_app`.

## Assets and boundaries

- **Assets:** user credentials and sessions; user and onboarding records;
  account ownership and cached balances; append-only ledger and audit rows;
  admin privileges; database credentials and database-role boundaries.
- **Trust boundaries:** untrusted HTTP clients to Express; authenticated
  account holders to admin-only routes; application services to Prisma;
  `bv_app` runtime SQL privileges to owner-managed schema and triggers;
  local test configuration to PostgreSQL.
- **Actors:** unauthenticated internet client; authenticated account holder;
  administrator; compromised application process using `bv_app`; database
  owner responsible for migrations and bootstrap.

## Threats and observed checks

| Threat / attack scenario | Component and attacker capability | Impact | Likelihood / severity | Existing mitigation | Test performed | Actual result | Remaining risk |
|---|---|---|---|---|---|---|---|
| Stolen, expired, revoked, or disabled-user session is reused to act as a user. | Authentication/session middleware; attacker has or guesses a cookie. | Account takeover or continued access after revocation. | Medium / High | Opaque random session token; only token hash stored; expiry, revocation, and current database user status checked on requests. | Automated auth suite; rollback-only PostgreSQL admin check disabled a synthetic user, revoked its session, verified the session no longer resolved, re-enabled the user, and verified the session stayed revoked. | Automated cases for expired, revoked, idle-expired, absolute-expired, and disabled-user sessions passed. PostgreSQL status/session revocation and disabled-session check passed; synthetic rows were rolled back. | Cookie theft remains possible; deployment cookie, TLS, and browser behavior are not tested in production. |
| Customer reads or changes another user's account, transaction, or onboarding record (IDOR/BOLA). | Customer API and ownership filters; attacker changes resource IDs or query parameters. | Exposure or unauthorized modification of another customer's data. | Medium / High | Backend authentication and owner-scoped database queries; other owners' resources are hidden with 404; SYSTEM accounts are excluded from customer reads. | Automated account, transaction-history, onboarding, and authorization tests; guarded PostgreSQL account/onboarding/ledger integrations. | Unit/API tests passed for other-owner access and hidden SYSTEM accounts; the guarded account, onboarding, and ledger integrations passed on the stated database identity. | Not every route/ID combination was exercised against live PostgreSQL; deployed API behavior is NOT YET RUN. |
| Customer forges role, owner, status, kind, balance, source account, or other protected fields. | Registration, onboarding, account, admin, and transfer inputs; attacker submits extra JSON fields or forged identifiers. | Privilege escalation, account takeover, or unauthorized money movement. | Medium / High | Strict Zod request schemas; server-derived user, role, owner, and source account; least-privilege column grants. | Automated mass-assignment, forged-source, and malformed-input tests; account and ledger database integrations. | Automated rejection tests passed, including role/status/owner/balance fields and forged source account. Guarded account and ledger integrations passed. | Full endpoint-by-endpoint adversarial fuzzing is NOT YET RUN. |
| Transfer replay or concurrent spending bypasses idempotency, locking, or overdraft controls. | Transfer service and PostgreSQL; attacker sends duplicate or concurrent requests. | Duplicate payment or negative customer balance. | Medium / Critical | Required idempotency key and unique database constraint; same-body replay; ordered row locks; single transaction; database balance constraint and ledger triggers. | Automated transfer tests plus real PostgreSQL concurrent duplicate and 20-request low-balance checks. | Automated tests passed. Real PostgreSQL duplicate requests returned one stored result. Of 20 concurrent requests against 1,000 paise, 10 succeeded and 10 were rejected as insufficient funds; observed balances matched expected values. Synthetic ledger rows remain in `balancevault_test`; fixture users were disabled and accounts closed. | This is a bounded test, not exhaustive concurrency, load, or multi-instance testing. |
| Runtime role tampers with ledger, audit, or cached balances, or bypasses triggers. | Compromised application process with `bv_app` credentials. | Financial record corruption or audit erasure. | Low / Critical | Restricted grants; append-only triggers; deferred balancing and posting-window triggers; database-maintained balance cache; no runtime balance UPDATE grant. | Runtime-role PostgreSQL privilege inspection and savepoint-protected UPDATE/DELETE denial probes; prior guarded Phase V SQL suites. | Security integration confirmed the protected table/column privileges absent and UPDATE/DELETE attempts denied; audit TRUNCATE privilege was false. Existing Phase V test results were not rerun in this phase. | Owner credentials, host security, and trigger behavior under a database compromise remain outside these runtime-role probes. |
| Administrator disables the last active administrator, themselves, or leaves a disabled user's session usable. | Admin user-management endpoints; authenticated admin attempts status changes. | Administrative lockout or continued access after disablement. | Low / High | Database-backed role/status recheck; self-disable and last-active-admin guards; serializable transaction; session revocation; audit records. | Automated admin-management tests; rollback-only PostgreSQL Phase H checks for status transitions, revocation, audit read, and self/last-admin refusal. | Automated cases passed, including concurrent last-admin protection. PostgreSQL checks passed; the check selected the expected refusal based on the observed active-admin count and rolled back synthetic changes. The test database had one active ADMIN during the integration run. | No multi-process stress test of concurrent last-admin changes was run against PostgreSQL. |
| Brute-force login, CSRF, or disallowed Origin is used to compromise or induce state changes. | Auth and state-changing routes; attacker sends repeated requests or cross-site requests. | Account compromise or cross-site actions. | Medium / High | In-memory IP/account throttles and lockout; required Origin and CSRF token checks; SameSite session cookie. | Automated rate-limit, lockout, CSRF, invalid-token, and invalid-Origin tests. | Automated checks passed. | Rate limits are process-local and reset at restart; distributed/multi-instance throttling and deployed browser behavior are NOT YET RUN. |
| Admin data or audit records are exposed to a customer or unauthenticated requester. | Admin user and audit endpoints; attacker calls routes directly. | Sensitive account metadata exposure or weakened accountability. | Medium / High | Authentication, database-backed permission checks, service-level authorization, response DTOs, pagination, append-only audit. | Automated unauthorized admin-route and audit tests; rollback-only PostgreSQL admin-list/details/audit checks and customer service-denial checks. | Automated tests passed. The PostgreSQL admin-only security integration passed, including paginated list shape, safe fields, admin detail, customer denial, and audit SELECT; generated rows were rolled back. | Deployed access control, pagination under large data volumes, and audit-retention operations are NOT YET RUN. |

## Not yet tested

- Deployed application, frontend, HTTPS/session-cookie behavior, hosting,
  proxy trust, and production database-role/trigger compatibility: **NOT YET
  RUN**.
- Distributed throttling across multiple backend instances and sustained
  brute-force/load testing: **NOT YET RUN**.
- Exhaustive fuzzing, long-duration concurrency, and concurrency across
  independent application processes: **NOT YET RUN**.
- External security review and penetration test: **NOT YET RUN**.

The admin-only security integration is rollback-only. The full
`db:security-integration` command appends synthetic ledger/audit/idempotency
rows that cannot be removed; it must only target `balancevault_test` as
`bv_app`.

## Additional threat coverage and deployment preparation

The following items supplement the Phase I checks above. “Verified” means the
named local test or user-reported database run occurred; it does not mean the
threat is eliminated or that a hosted deployment is secure.

| Threat / scenario | Affected component and attacker capability | Impact; likelihood / severity | Mitigation | Actual test performed and observed result | Residual risk |
|---|---|---|---|---|---|
| CSRF token bootstrap is blocked or forged, or a cross-site request attempts a state change. | Browser, CSRF-token endpoint and mutation routes; attacker can cause the victim's browser to make requests. | Denial of normal form actions or unauthorized state changes; Medium / High. | Mutations require the CSRF cookie/header and exact allowed Origin. Token issuance allows an allowed Origin, or a missing Origin only when the browser reports `Sec-Fetch-Site: same-origin`. | **Verified locally:** a browser same-origin GET omitted `Origin` and sent `Sec-Fetch-Site: same-origin`; the original route rejected it. The route was adjusted for token issuance only. Backend tests verify that same-origin metadata succeeds and no allowed signal is rejected. Phase I CSRF/invalid-Origin tests were reported passing. | Browser/provider behavior is not verified on Render. Older clients without either accepted Origin or Fetch Metadata will be rejected. Mutation authorization still depends on exact production origins and secret configuration. |
| Stored/reflected XSS or SQL injection through user-controlled fields. | React rendering, Express request validation, Prisma services; attacker submits crafted names, addresses, notes or identifiers. | Session theft, unintended actions, or data access; Medium / High. | Strict Zod request schemas, Prisma's parameterized operations, React's normal escaped rendering, Helmet security headers, HttpOnly session cookie, and no raw HTML rendering identified in the frontend review. | **NOT YET RUN:** no dedicated XSS or SQL-injection payload suite or external penetration test was run in Phase K. General malformed-input and validation tests exist, but they are not proof against these classes. | Future unsafe HTML rendering or raw SQL could introduce vulnerabilities; browser CSP/header behavior and adversarial payload coverage remain outstanding. |
| Login abuse, brute force or distributed request flooding. | Authentication routes and rate-limit middleware; attacker sends many login/register/CSRF requests from one or more clients. | Account compromise or service degradation; Medium / High. | Per-IP and per-account in-memory throttling, account lockout fields, generic login errors and password hashing. | Phase I automated rate-limit and lockout tests were reported passing. **NOT YET RUN:** distributed, multi-instance and sustained load tests. | Limits reset on restart and are not shared across instances; hosting proxy IP interpretation is not yet verified. |
| SYSTEM funding account or funding endpoint is abused. | Admin funding route, SYSTEM account and ledger services; attacker compromises an admin or attempts direct runtime-role modification. | Unauthorized issuance or loss of integrity; Low / Critical. | Backend ADMIN authorization, audited/idempotent funding, immutable balanced ledger, database trigger restrictions, and a SYSTEM seed script that verifies account kind/owner/currency and refuses non-dev/test database names. | Phase I records report admin security integrations; the exact retained output for production funding/provisioning is unavailable. Runtime role tests verify SYSTEM-account protections. Production account provisioning and funding are **NOT YET RUN** and intentionally blocked by the current seed guard. | No production-safe SYSTEM provisioning procedure exists. Admin credential compromise and owner-role compromise remain high-impact risks. |
| Compromise of `bv_app` or owner database credentials bypasses application policy. | PostgreSQL roles, migrations and runtime connection strings; attacker obtains a credential. | Data disclosure or ledger/audit integrity compromise; Low / Critical. | `bv_app` is not owner/superuser and has restricted column/table grants; append-only and posting triggers are owner-controlled. Owner credentials are reserved for migrations/bootstrap and are not intended for Render runtime. | User-reported Phase V tests on `balancevault_test` verified intended column grants, no table UPDATE grants for selected tables, denied ledger/audit mutation and trigger-bypass attempts. Phase I security integration reported runtime-role privilege-denial checks. | Owner compromise can alter schema and triggers. Production role/grant setup and provider-managed roles have not been tested. |
| Hosting secrets, cookies or forwarded headers are mishandled. | Render configuration, HTTPS proxy and browser; attacker obtains a secret, spoofs proxy metadata, or exploits a misconfigured cookie. | Database takeover, session theft, incorrect throttling or origin bypass; Medium / Critical. | Blueprint keeps `DATABASE_URL` and `APP_ORIGINS` as unsynced inputs and generates `CSRF_SECRET`; `DIRECT_URL` is not configured in the web service. Production cookies are HttpOnly, SameSite=Lax and Secure. Express trusts exactly one proxy hop for the planned Render topology. | **Verified locally:** unit test asserts production proxy trust is one hop; existing auth tests assert HttpOnly and SameSite=Lax cookie flags. **NOT YET RUN:** Render header sanitization, deployed HTTPS cookies, secret exposure review on a live service, and external trust-proxy behavior. | Proxy trust assumes Render's documented one-hop topology and header handling. Reassess if hosting changes; secrets and cookie behavior require live deployment tests. |
| Neon pooler or database feature mismatch breaks locking, triggers, role boundaries or migration history. | Prisma/PostgreSQL connection path; operator selects unsupported pooler or insufficiently privileged role. | Double spending, migration failure or weakened constraints; Medium / Critical. | Runtime and owner URLs are separate; database protections are versioned in migrations; provider must be checked before use. | **NOT YET RUN:** no Neon database, role, trigger, migration, pooler, lock, concurrency or grant test was performed. | Neon compatibility cannot be assumed. Do not deploy money movement until all database compatibility tests pass using synthetic data. |
| A direct React Router URL or unknown API URL returns the wrong content. | Express static/SPA fallback; unauthenticated caller requests a deep link or nonexistent API path. | Broken navigation or accidental API/HTML confusion; Low / Low. | API routers are mounted first; `/api` receives the JSON 404 handler before static assets and SPA fallback. SPA fallback is limited to HTML GETs without a file extension. | **Verified locally in Phase K:** backend tests confirmed a deep admin URL serves the SPA, a static file is served, unknown `/api` returns JSON 404, and `/health` remains JSON health output. | Test uses a temporary fixture directory, not the live Render build or CDN/proxy. Deployed routing remains **NOT YET RUN**. |

## Verification classification

### Verified controls

- The user-reported Phase V SQL suites and Phase I PostgreSQL checks listed
  above; the database identity used for the reported runtime security tests
  was `balancevault_test` / `bv_app`.
- Backend automated tests reported in the Phase I/Phase J record and targeted
  Phase K tests for static/SPA routing, unknown API 404 isolation, health,
  production proxy-hop setting, and same-origin CSRF token issuance.
- The Phase I record reports bounded real PostgreSQL concurrency results;
  they apply only to that test run and do not establish exhaustive or
  multi-instance safety.

### Not verified / residual risks

- No Render or Neon deployment has been created. There is no public URL.
- Neon roles, migrations, triggers, grants, pooler, locking and concurrency
  compatibility are **NOT YET RUN**.
- Production first-admin bootstrap and SYSTEM funding-account provisioning
  are unavailable: the existing scripts are explicitly restricted to
  `balancevault_test` and development/test databases, respectively.
- Production cookie/HTTPS behavior, actual Render proxy headers, frontend
  authenticated flows, XSS/SQLi payloads, distributed throttling, exhaustive
  fuzzing, multi-process concurrency and external penetration testing are
  **NOT YET RUN**.