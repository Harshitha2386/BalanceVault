# Requirements and implementation assumptions

The challenge's official list of ten requirements has not been confirmed.
This project therefore does not claim that its route list or feature set is an
official requirement checklist.

## Current working assumptions

- The existing Express API contracts are authoritative for frontend requests.
- Only the routes currently implemented by the backend are exposed in the UI;
  the frontend does not invent an API for password changes.
- Transfer inputs are entered in rupees and converted as integer paise. The
  backend transfer contract identifies a destination by account UUID, so the
  UI asks for that UUID rather than pretending it can resolve account numbers.
- Customer and administrator capabilities are presented by database-backed
  roles, while all sensitive access control remains enforced by the backend.
- The deployment target is one Render Web Service serving the built React app
  and Express API from the same origin; this is configuration intent, not a
  deployed or provider-verified result.
- Neon is a candidate PostgreSQL host only. Role, trigger, grants, pooler,
  migration and interactive-transaction compatibility must be verified before
  use.
- Production first-admin creation and SYSTEM funding-account provisioning
  require separately reviewed owner-run procedures; current scripts are
  guarded to test/development databases.
- Balances and transaction history are read from the API; no demo balances,
  sample transactions, or synthetic dashboard totals are fabricated.
- Only synthetic records should be used for demonstrations and testing.

Revisit these assumptions when the official challenge brief is available.
