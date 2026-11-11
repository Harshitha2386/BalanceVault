# BalanceVault backend

## Run from `backend\` in CMD

```cmd
npm install
npm start
```

Node loads an optional local `.env` file. `DATABASE_URL` must point to the
restricted `bv_app` runtime role; the application does not use `DIRECT_URL`.
`PORT` is optional and defaults to `3000`. Development defaults the allowed
browser origin to `http://localhost:5173` and generates a process-local CSRF
signing key. Production must explicitly configure `APP_ORIGINS` as a
comma-separated list of exact HTTPS origins and `CSRF_SECRET` with at least 32
characters. Never expose or commit these values.
In production the Express app trusts exactly one proxy hop for the planned
Render Web Service topology. This setting must be re-evaluated if the hosting
provider or proxy topology changes. Login throttles remain in-memory and
process-local, so they are not a distributed abuse-control system.

The server exposes:

- `GET /health` — HTTP process health; does not query PostgreSQL.
- `GET /ready` — runs a read-only `SELECT 1` through Prisma.
- `GET /api/auth/csrf` — issues a signed, session-bound CSRF token for an
  allowed Origin.
- `POST /api/auth/register` — validates, hashes and registers an account
  holder; does not create an account or accept privileged fields.
- `POST /api/auth/login` — generic credential errors and opaque server-side
  sessions.
- `POST /api/auth/logout` and `GET /api/auth/me`.
- `POST /api/onboarding/applications` and
  `GET /api/onboarding/applications/me` for customer-owned applications.
- `GET /api/admin/onboarding/applications`,
  `GET /api/admin/onboarding/applications/:id`, and
  `PATCH /api/admin/onboarding/applications/:id/decision` for administrators.
- `GET /api/accounts` and `GET /api/accounts/:id` for owner-scoped customer
  account reads.
- `GET /api/admin/accounts`, `GET /api/admin/accounts/:id`, and
  `PATCH /api/admin/accounts/:id/status` for administrators.
- `GET /api/admin/users` and `GET /api/admin/users/:id` for paginated user
  administration. `PATCH /api/admin/users/:id/status` enables or disables an
  account without changing its role; disabling revokes its active sessions.
- `GET /api/admin/audit` for administrators, with pagination and optional
  action, outcome, and target-type filters.
- `GET /api/transactions` for paginated, owner-scoped transaction history.
- `POST /api/transfers` for customer transfers. Requires `Idempotency-Key`,
  allowed Origin, and CSRF validation. `amountMinor` is a positive integer in
  paise capped at `100000000` per operation; retries with the same key and
  request replay the stored result.
- `POST /api/admin/accounts/:id/fund` for idempotent administrator funding
  from the seeded `BV-SYSTEM-FUNDING-INR` SYSTEM account.
- `POST /api/admin/ledger/verify` for administrators to compare cached
  balances with ledger-derived balances without repairing either.

State-changing auth requests require an allowed `Origin`, the `bv_csrf`
cookie, and the `X-CSRF-Token` header. Session cookies are HttpOnly,
SameSite=Lax, and Secure in production. Passwords use Node's scrypt with
N=32768, r=8 and p=1. Login uses in-memory per-IP/per-account throttles and
the database lockout fields. The in-memory throttle resets on restart and is
not shared across multiple server instances.

The root `frontend\` directory contains the React/Vite client. It calls the
same-origin `/api` path and the Vite development proxy forwards those requests
to `http://localhost:3000` by default. Configure `VITE_API_PROXY_TARGET` when
the backend listens on a different local port. In the prepared integrated
deployment, Express serves `frontend\dist` after mounting the API; React Router
routes fall back to `index.html`, and unknown `/api` routes remain JSON 404s.
The static/SPA behavior is covered by backend tests. No hosted deployment has
been run.

In a second CMD window, start the frontend from the repository root:

```cmd
cd /d C:\dev\BalanceVault\frontend
npm install
npm run dev
```

The frontend includes login and registration, current-session handling,
customer accounts and history, transfers, onboarding, and administrator
workspaces. There is no backend password-change endpoint; the UI informs
`mustChangePassword` users of this limitation rather than sending a fabricated
request. Transfer destinations use the UUID required by the existing API.

Development watch mode:

```cmd
npm run dev
```

Run the built-in tests without connecting to PostgreSQL:

```cmd
npm test
```

The automated test suite uses isolated in-memory Prisma fakes. Guarded
database integration checks require `balancevault_test` and `bv_app`.
Authentication, onboarding, account, ledger, and the admin-only security
integration checks use rollback-only synthetic records:

```cmd
npm run db:auth-preflight
npm run db:auth-integration
npm run db:onboarding-integration
npm run db:account-integration
npm run db:ledger-integration
npm run db:security-integration -- --admin-only
```

The full security integration command also runs real PostgreSQL concurrent
transfer tests. Since ledger and audit rows are append-only, that mode leaves
synthetic ledger, audit, and idempotency records in `balancevault_test`; it
disables the synthetic users and closes their accounts. Never run this mode
against `balancevault_dev`. Clear inherited overrides in CMD before an
integration run (`set DATABASE_URL=` and `set DIRECT_URL=`), and verify the
script's printed identity is `balancevault_test` / `bv_app`.

First-admin bootstrap is restricted to `balancevault_test` and connects only
through `DIRECT_URL` as `postgres`. Clear inherited `DATABASE_URL` and
`DIRECT_URL` overrides in CMD, set
`BV_BOOTSTRAP_CONFIRM_DATABASE=balancevault_test`, and run the read-only
identity check before the write command:

```cmd
set DATABASE_URL=
set DIRECT_URL=
set BV_BOOTSTRAP_CONFIRM_DATABASE=balancevault_test
npm run bootstrap:admin:preflight
```

Only after verifying the output identifies `balancevault_test` and `postgres`,
run `npm run bootstrap:admin`. The script asks for email and full name and
reads the password without echoing it; alternatively, provide all three
`BV_BOOTSTRAP_EMAIL`, `BV_BOOTSTRAP_FULL_NAME`, and `BV_BOOTSTRAP_PASSWORD`
environment variables. It refuses to write if an ADMIN already exists.
Never put credentials into source control or command history.
This bootstrap command is intentionally not a production bootstrap: it rejects
every database other than `balancevault_test`. Do not bypass its guard or use
it against a hosted database. A separately reviewed production bootstrap
procedure remains required.

Authorization uses only the database `Role` values (`ACCOUNT_HOLDER` and
`ADMIN`). Authentication resolves the current user on every request; separate
role and permission middleware then deny access unless a route explicitly
allows it. Customer resource policies build owner-scoped Prisma filters for
accounts, transactions, and onboarding records, and return 404 for a resource
owned by another customer. Onboarding endpoints are implemented; account and
ledger endpoints are implemented. Admin user status changes update only the
granted `User.status` column, revoke sessions in the same serializable
transaction, and preserve at least one active ADMIN. Audit records remain
append-only, and the admin audit endpoint omits IP addresses and request IDs.
Onboarding writes use
the existing restricted insert-column set,
and active-application duplicates are handled by the existing partial unique
index. Admin decisions update only pending applications and write an audit row
in the same transaction; approval provisions the initial customer account
within that transaction. The account integration script verifies the
restricted account INSERT grants and database defaults in a rollback-only
transaction. Transfer and funding posting use the existing append-only ledger,
deferred balancing, posting-window, and trigger-maintained balance controls.
The ledger integration script guards for `balancevault_test` as `bv_app` and
rolls back synthetic rows; its admin funding and verification branches require
an active ADMIN fixture in that test database.

Security verification history includes 106 passing automated tests during
Phase I. After Phase K added same-origin CSRF and integrated static-hosting
regressions, the complete backend suite passed 110 tests. The earlier Phase I
record also documents guarded runtime-role PostgreSQL integrations and real
PostgreSQL concurrency checks for duplicate idempotency requests and
low-balance transfers. The security integration's retained synthetic ledger
rows are expected and cannot be deleted under the append-only policy.
Deployment proxy trust, hosting support, production configuration, and
deployed end-to-end behavior have not been verified. This project is not a
production financial service; use synthetic data only.

The Express app can serve the production Vite build from `frontend\dist`.
`GET /health` remains process-only, while `GET /ready` performs the database
ping. Production database role/trigger compatibility, Render proxy behavior,
Neon pooling, secure cookies in a deployed browser, and production bootstrap
and SYSTEM-account provisioning are **NOT YET RUN**. The existing SYSTEM
account SQL seed also refuses database names outside `balancevault_dev` and
`balancevault_test`.
