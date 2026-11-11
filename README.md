# BalanceVault

BalanceVault is a cybersecurity-focused banking and ledger challenge project.
It demonstrates authenticated customer accounts, onboarding, transfers, and
administrative operations backed by a PostgreSQL ledger. Use synthetic data
only. This project is not a production financial service and must not hold
real money or personal data.

The challenge's official list of ten requirements has not been confirmed.
Project assumptions are recorded in [docs/REQUIREMENTS.md](./docs/REQUIREMENTS.md).

## Status

| Area | Implemented | Verified |
|---|---|---|
| Express API, authentication, sessions, RBAC, onboarding, accounts, transfers, admin actions | Yes | Automated backend tests and selected `balancevault_test` / `bv_app` PostgreSQL integrations; see [backend/README.md](./backend/README.md) and [THREATS.md](./THREATS.md) |
| React/Vite customer and admin screens | Yes | Frontend tests and production build; authenticated browser flows were not fully exercised |
| Same-origin Express hosting of the built frontend | Yes | Static asset, SPA-route, API-404 and health regression tests |
| Render deployment configuration | Prepared in [render.yaml](./render.yaml) | YAML was structurally reviewed; no local YAML parser, Render schema validation or deployment has been run |
| Neon PostgreSQL | Configuration documented | Role, trigger, migration, pooling and runtime compatibility are **NOT YET RUN** |
| Public application URL | Not created | No deployment has succeeded |

Two deployment operations are deliberately not production-enabled yet:

- The existing `npm run bootstrap:admin` command refuses databases other than
  `balancevault_test`. Do not bypass that guard or run the command against
  Neon. A separately reviewed production bootstrap path is required before
  admin access can be initialized.
- `backend/db/seed-system-account.sql` also allows only
  `balancevault_dev` or `balancevault_test`. Production funding must remain
  unavailable until an owner-run, production-safe provisioning procedure is
  reviewed and verified.

## Features

- Account-holder registration and opaque server-side sessions.
- Customer onboarding application, account overview and transaction history.
- INR transfers represented as integer paise, with idempotency and database
  transaction/locking protections.
- Database-backed customer/admin authorization.
- Admin onboarding review, user enable/disable, account status, funding,
  ledger verification and audit-log views.
- Append-only ledger and audit records, database balancing/posting controls,
  restricted runtime-role privileges and trigger-maintained balance cache.
- Responsive React interface using the backend's existing API contracts.

The backend has no password-change endpoint. The frontend discloses this when
`mustChangePassword` is set; it does not invent a password-change API.
Transfers accept a destination account UUID, so the interface asks for that
identifier. See [docs/REQUIREMENTS.md](./docs/REQUIREMENTS.md) for other
assumptions and limitations.

## Technology and architecture

- Node.js 24, JavaScript ES modules, Express 5, Zod and Prisma 6.19.3.
- PostgreSQL; BigInt minor units are serialized as strings at the API boundary.
- React, Vite, Tailwind CSS, React Router and Lucide.
- Render Web Service target for the integrated app; Neon is a proposed,
  unverified PostgreSQL host.

```text
Browser
  └── React/Vite build (served by Express from frontend/dist)
        └── same-origin /api requests
              └── Express routes → middleware → controllers → services
                    └── Prisma → PostgreSQL
```

In local development Vite serves the frontend and proxies `/api` to Express.
In the prepared Render setup one Express service serves both the generated
frontend and API from one origin.

## Repository layout

```text
backend/
  db/                  PostgreSQL role grants, seed scripts and SQL tests
  prisma/              Prisma schema and append-only migrations
  scripts/             Bootstrap and guarded integration runners
  src/                 Express app, routes, middleware and services
  test/                Node test runner tests
frontend/
  src/                 React pages, API client, components and styles
  test/                Frontend unit tests
docs/
  REQUIREMENTS.md      Challenge assumptions and implementation scope
render.yaml            Integrated Render Web Service blueprint
THREATS.md             Threat model and observed security verification
PROMPTS.md             AI-assisted development record
```

## Local setup (Windows CMD)

Use Node.js 24 and npm. Install each locked dependency set from the repository
root:

```cmd
cd /d C:\dev\BalanceVault\backend
npm ci
cd /d C:\dev\BalanceVault\frontend
npm ci
```

Configure `backend\.env` locally with a `DATABASE_URL` for the restricted
`bv_app` role and a `DIRECT_URL` for owner-only Prisma migration operations.
Never display, commit or paste that file. CMD process-level variables override
`.env`; clear any inherited overrides before using local settings:

```cmd
set DATABASE_URL=
set DIRECT_URL=
```

Before any Prisma migration/status command, check its database header and stop
if it is not the intended database. Never run `prisma migrate reset`.

Start the backend in one CMD window:

```cmd
cd /d C:\dev\BalanceVault\backend
set DATABASE_URL=
set DIRECT_URL=
npm start
```

Start Vite in another CMD window:

```cmd
cd /d C:\dev\BalanceVault\frontend
npm run dev
```

Open the Vite URL printed in its terminal (normally
`http://localhost:5173`). Vite proxies `/api` to `http://localhost:3000`.
To use a different backend port:

```cmd
set VITE_API_PROXY_TARGET=http://localhost:3001
npm run dev
```

The API health endpoints are `GET /health` (process health) and `GET /ready`
(read-only database ping).

## Environment variables

| Variable | Required by | Purpose |
|---|---|---|
| `DATABASE_URL` | Backend runtime | PostgreSQL URL for the restricted `bv_app` role. For Neon, use a pooled endpoint only after verifying Prisma interactive transactions and row-lock behavior with the chosen pooler. |
| `DIRECT_URL` | Prisma CLI / owner-only scripts | Direct PostgreSQL URL for schema migrations and separately approved owner operations; never use as the app runtime role. The current bootstrap script is test-database-only. |
| `NODE_ENV` | Backend | `production` enables production cookie settings and production configuration checks. |
| `APP_ORIGINS` | Production backend | Comma-separated exact HTTPS origins; for a single Render service set it to the assigned application origin, with no path or trailing slash. |
| `CSRF_SECRET` | Production backend | At least 32 characters; generate/store through the hosting provider's secret manager. |
| `PORT` | Render / backend | Render supplies the listening port; local default is `3000`. |
| `VITE_API_PROXY_TARGET` | Local frontend only | Optional local Vite proxy target; not a production API URL or secret. |

Connection examples are placeholders, not credentials to copy:

```text
DATABASE_URL=postgresql://<bv_app-role>:<placeholder-password>@<host>:5432/<database>?sslmode=require
DIRECT_URL=postgresql://<owner-role>:<placeholder-password>@<direct-host>:5432/<database>?sslmode=require
APP_ORIGINS=https://<assigned-render-host>
CSRF_SECRET=<random-secret-of-at-least-32-characters>
```

Set secret values only in ignored local environment files or a hosting secret
manager. Do not put credentials in command history, source files, screenshots,
logs or issue reports.

## Database setup and Prisma

`backend/prisma/schema.prisma` uses `DATABASE_URL` for the runtime datasource
and `DIRECT_URL` for direct CLI connections. Migrations contain PostgreSQL
triggers, grants, checks and SQL-managed indexes that are not fully represented
by Prisma's declarative schema. Keep every applied migration immutable; add a
new migration for future schema changes. Do not use `prisma db push` to bypass
the migration history.

For a local development database, the safe sequence is:

1. Create a synthetic-data database and a restricted `bv_app` role. The role
   creation script is `backend/db/01-create-roles.sql`; its comments specify
   the cluster-level owner/superuser step and interactive password setting.
2. Set both local connection URLs in `backend\.env` without committing them.
3. In `backend\`, clear inherited overrides, run `npx prisma migrate status`,
   and confirm the printed database identity before proceeding.
4. Run `npx prisma migrate deploy` with the owner-only `DIRECT_URL`.
5. Apply `backend/db/02-grants.sql` as the database owner to the intended
   database. Review its current safety header and target before execution.
6. Run only the database tests intended for that target and role. Tests that
   commit append-only ledger rows run only against `balancevault_test`.
7. Provision a SYSTEM funding account only with the owner-run script and only
   in a database its explicit guard permits.

For an already-created local development database, the owner commands are:

```cmd
cd /d C:\dev\BalanceVault\backend
psql -U postgres -d postgres -f db\01-create-roles.sql
psql -U postgres -d postgres
```

At the interactive `psql` prompt, set the runtime role's password with
`\password bv_app`, then exit with `\q`. The password is prompted for and is
not part of the command. After configuring the ignored environment file,
confirm Prisma's database header before applying migrations:

```cmd
cd /d C:\dev\BalanceVault\backend
set DATABASE_URL=
set DIRECT_URL=
npx prisma migrate status
```

Only if the reported target is the intended local database, run:

```cmd
npx prisma migrate deploy
psql -U postgres -d balancevault_dev -f db\02-grants.sql
```

The grant command above is only an example for `balancevault_dev`; verify the
target and role first. Passwords are entered at prompts. Do not copy connection
strings into commands or terminal transcripts.

Prisma CLI and client are pinned to 6.19.3. The partial onboarding unique index
and ledger/balance protections are maintained by SQL migration files. Preserve
those files and verify drift against the complete migration history instead
of trying to encode unsupported partial-index semantics in `schema.prisma`.

### Neon status and safe production order

Neon compatibility is **NOT YET VERIFIED**. Before selecting it for any
deployment, verify the current provider's role model, permission to create
required functions/triggers and indexes, supported PostgreSQL behavior, pooler
semantics for interactive transactions and `SELECT ... FOR UPDATE`, and
connection limits. A pooled Neon endpoint is a possible runtime
`DATABASE_URL`; use a direct endpoint for owner-only migrations via
`DIRECT_URL`. Do not assume the pooler preserves this application's locking
and idempotency behavior until the PostgreSQL integration tests have been run
against that provider.

For a future deployment, the intended sequence is: create a separate Neon
project/database; establish the owner and least-privilege runtime role; verify
database identity; apply the versioned migrations as owner; apply the reviewed
least-privilege grants; run provider compatibility checks using synthetic
records; configure only the runtime URL in Render; then use an approved,
production-safe first-admin and SYSTEM-account procedure. The final procedure
does not exist yet. Do not run current test-only bootstrap or seed scripts
against Neon.

## API reference

All application APIs are under `/api`. State-changing requests require an
allowed Origin and the CSRF cookie/header pair. Authentication uses cookies;
the browser client does not store session tokens.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/health` | Process health; no database query |
| `GET` | `/ready` | Database readiness ping |
| `GET` | `/api/auth/csrf` | Issue CSRF token for a browser request |
| `POST` | `/api/auth/register` | Register account holder |
| `POST` | `/api/auth/login` | Authenticate and rotate session |
| `POST` | `/api/auth/logout` | Revoke current session |
| `GET` | `/api/auth/me` | Current user and session profile |
| `POST` | `/api/onboarding/applications` | Submit own onboarding application |
| `GET` | `/api/onboarding/applications/me` | View own application status |
| `GET` | `/api/admin/onboarding/applications` | Paginated admin application list |
| `GET` | `/api/admin/onboarding/applications/:id` | Admin application details |
| `PATCH` | `/api/admin/onboarding/applications/:id/decision` | Approve or reject |
| `GET` | `/api/accounts` | Own accounts |
| `GET` | `/api/accounts/:id` | Own account details |
| `GET` | `/api/transactions` | Paginated own transaction history |
| `POST` | `/api/transfers` | Transfer; requires an idempotency key |
| `GET` | `/api/admin/users` | Paginated user list |
| `GET` | `/api/admin/users/:id` | Admin user details |
| `PATCH` | `/api/admin/users/:id/status` | Enable/disable without changing role |
| `GET` | `/api/admin/accounts` | Paginated admin account list |
| `GET` | `/api/admin/accounts/:id` | Admin account details |
| `PATCH` | `/api/admin/accounts/:id/status` | Change account status |
| `POST` | `/api/admin/accounts/:id/fund` | Audited SYSTEM-account funding |
| `POST` | `/api/admin/ledger/verify` | Compare cached and ledger-derived balances |
| `GET` | `/api/admin/audit` | Paginated audit-log view |

Authorization is enforced by backend authentication and database-backed role
checks; React route guards are only a user-experience feature. See
[backend/README.md](./backend/README.md) for request behavior and test commands.

## Security and integrity

- Opaque random session cookies are HttpOnly, SameSite=Lax and Secure in
  production; only a hash of the session token is stored.
- Mutations require the expected CSRF token and an exact allowed Origin.
  Same-origin browser CSRF-token retrieval also accepts the browser's
  `Sec-Fetch-Site: same-origin` signal because same-origin GET requests omit
  the `Origin` header in Chromium.
- Role and status are re-read from the database; customer queries scope by
  ownership; request schemas reject unexpected fields.
- Amounts are integer paise, the transfer service uses database transactions,
  row locking and idempotency, and ledger entries are the source of truth.
- PostgreSQL migrations enforce ledger balancing/posting windows, append-only
  ledger/audit data, balance checks and least-privilege runtime grants.
- Security is not certified: hosting, production configuration, Neon
  compatibility, proxy behavior, external penetration testing and several
  deployment-specific checks remain outstanding. Full details and actual test
  outcomes are in [THREATS.md](./THREATS.md).

Login throttling is in-memory and process-local; it resets on restart and is
not shared across multiple instances. The Render configuration trusts one
managed proxy hop in production; re-evaluate that setting if the hosting
topology changes.

## Tests and checks

From `frontend\`:

```cmd
npm test
npm run build
npm ls --depth=0
```

From `backend\`:

```cmd
npm test
npm ls --depth=0
```

Guarded PostgreSQL integration commands and their database side effects are
documented in [backend/README.md](./backend/README.md). Never run integration
tests against `balancevault_dev` if they append ledger/audit records. Do not
run database checks without first clearing inherited `DATABASE_URL` and
`DIRECT_URL` overrides and verifying the printed database and role.

## Integrated Render deployment

[render.yaml](./render.yaml) describes one Node Web Service. Its build installs
the locked frontend and backend dependencies and builds `frontend/dist`; its
start command runs the existing Express server. Express serves static assets
and React Router paths after API routes, and unknown `/api` paths stay JSON
404s. The Vite proxy remains for local development.

To prepare a future deployment:

1. Create/connect a GitHub repository only after reviewing tracked files and
   secrets. No remote is currently configured in this worktree; see
   [GitHub readiness](#github-readiness).
2. Create and validate the Neon database and roles using the safe procedure
   above. No production migration is run by this project setup.
3. Import the repository into Render and review the blueprint's build/start
   commands and plan before creating the service.
4. In Render, set `DATABASE_URL` to the restricted runtime-role URL,
   `APP_ORIGINS` to the exact assigned HTTPS origin, and keep the generated
   `CSRF_SECRET` private. `DIRECT_URL` is intentionally not configured in the
   web service.
5. Do not declare the application ready for administrator use until a
   separately approved production first-admin flow exists. Do not enable
   funding until production SYSTEM-account provisioning has been verified.
6. After a successful deploy, test `/health`, `/ready`, same-origin cookies,
   CSRF, authentication, authorization, transfers and audit behavior with
   synthetic data only. Record the resulting real URL and test evidence then.

The blueprint has not been deployed or validated by Render. Current Render
plan availability, pricing, cold-start behavior and resource limits must be
checked in the provider dashboard before creating resources. Neon support for
the database security features is also unverified.

## GitHub readiness

The current checkout has branch `main`, latest commit `c5a718f`, and no Git
remote configured at inspection time. The worktree contains existing
uncommitted and untracked Phase B–J work; review and commit intentionally in
small units before publishing. Do not push this working tree as-is.

After you create the GitHub repository and decide its visibility, you can
connect it from CMD with your own destination:

```cmd
cd /d C:\dev\BalanceVault
git remote add origin https://github.com/<owner>/<repository>.git
git remote -v
```

Then review `git status`, secret scanning and the destination before you decide
whether to commit/push. No remote was added, and no push was performed during
this preparation.

## AI usage

AI assistance used during this project: Claude (Free), ChatGPT and GitHub
Copilot. The task-by-task prompt record distinguishes known evidence from
historical details that were not retained: [PROMPTS.md](./PROMPTS.md).
