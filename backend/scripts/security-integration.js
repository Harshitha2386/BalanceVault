import { createServer } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { createApp } from '../src/app.js';
import { hashPassword } from '../src/auth/password.js';
import { hashSessionToken } from '../src/auth/token.js';
import { getPrismaClient } from '../src/prisma.js';
import {
  changeUserStatus,
  getAdminUser,
  listAdminAuditLogs,
  listAdminUsers,
} from '../src/services/admin-management-service.js';
import {
  createTransfer,
  listOwnTransactions,
} from '../src/services/ledger-service.js';
import { resolveSession } from '../src/services/session-service.js';

const TEST_DATABASE = 'balancevault_test';
const APP_ROLE = 'bv_app';
const ORIGIN = 'http://client.example.test';
const PASSWORD = 'Synthetic-Security-Integration-Password-948!';
const ROLLBACK_MARKER = new Error('SECURITY_INTEGRATION_ROLLBACK');
const databaseUrl = process.env.DATABASE_URL;

function safeErrorCode(error) {
  for (const candidate of [error?.meta?.code, error?.code]) {
    if (typeof candidate === 'string' && /^[A-Z0-9]+$/u.test(candidate)) {
      return candidate;
    }
  }
  return 'unknown';
}

function errorSqlState(error) {
  for (const candidate of [error?.meta?.code, error?.meta?.database_error, error?.message]) {
    const match = String(candidate || '').match(/\b42501\b/u);
    if (match) {
      return match[0];
    }
  }
  return null;
}

function transactionScopedClient(transaction) {
  return new Proxy(transaction, {
    get(target, property) {
      if (property === '$transaction') {
        return (callback) => callback(transactionScopedClient(target));
      }
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function insertSyntheticUser(tx, id, label, passwordHash) {
  const rows = await tx.$queryRaw`
    INSERT INTO public."User" (
      "id", "email", "fullName", "passwordHash", "updatedAt"
    )
    VALUES (
      ${id}::uuid,
      ${`security-${label}-${id}@example.test`},
      ${`Synthetic Security ${label}`},
      ${passwordHash},
      ${new Date()}
    )
    RETURNING "id"
  `;
  assert(rows.length === 1, 'Synthetic user insert did not return one row.');
}

async function insertSyntheticAccount(tx, id, ownerId) {
  const accountNumber = `BV${randomBytes(10).toString('hex').toUpperCase()}`;
  const rows = await tx.$queryRaw`
    INSERT INTO public."Account" (
      "id", "accountNumber", "currency", "ownerId", "updatedAt"
    )
    VALUES (
      ${id}::uuid,
      ${accountNumber},
      'INR',
      ${ownerId}::uuid,
      ${new Date()}
    )
    RETURNING "id"
  `;
  assert(rows.length === 1, 'Synthetic account insert did not return one row.');
}

async function createSession(tx, userId) {
  const token = randomBytes(32).toString('base64url');
  const session = await tx.session.create({
    data: {
      tokenHash: hashSessionToken(token),
      userId,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    },
    select: { id: true },
  });
  return { id: session.id, token };
}

function cookieFrom(headers, name) {
  for (const value of headers.getSetCookie()) {
    const match = value.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`, 'u'));
    if (match) {
      return decodeURIComponent(match[1]);
    }
  }
  return null;
}

async function csrfFor(baseUrl, sessionToken = null) {
  const response = await fetch(`${baseUrl}/api/auth/csrf`, {
    headers: {
      origin: ORIGIN,
      ...(sessionToken ? { cookie: `bv_session=${sessionToken}` } : {}),
    },
  });
  assert(response.status === 200, 'CSRF bootstrap endpoint did not return 200.');
  const body = await response.json();
  const cookie = cookieFrom(response.headers, 'bv_csrf');
  assert(typeof body.csrfToken === 'string' && cookie, 'CSRF token was not issued.');
  return { token: body.csrfToken, cookie };
}

async function apiRequest(baseUrl, path, {
  method = 'GET',
  sessionToken,
  csrf,
  body,
  origin = ORIGIN,
  idempotencyKey,
} = {}) {
  return fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      origin,
      ...(sessionToken ? { cookie: `bv_session=${sessionToken}${csrf ? `; bv_csrf=${csrf.cookie}` : ''}` } : ''),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(csrf ? { 'x-csrf-token': csrf.token } : {}),
      ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function expectPermissionDenied(tx, name, statement) {
  await tx.$executeRaw`SAVEPOINT security_permission_probe`;
  let denied = false;
  try {
    await statement();
  } catch (error) {
    if (errorSqlState(error) !== '42501') {
      throw error;
    }
    denied = true;
  }
  await tx.$executeRaw`ROLLBACK TO SAVEPOINT security_permission_probe`;
  await tx.$executeRaw`RELEASE SAVEPOINT security_permission_probe`;
  assert(denied, `${name} unexpectedly succeeded for bv_app.`);
}

async function verifyLedgerAndAuditImmutability(prisma) {
  const [privileges] = await prisma.$queryRaw`
    SELECT
      has_table_privilege(current_user, 'public."LedgerEntry"', 'UPDATE') AS entry_update,
      has_table_privilege(current_user, 'public."LedgerEntry"', 'DELETE') AS entry_delete,
      has_table_privilege(current_user, 'public."LedgerTransaction"', 'UPDATE') AS transaction_update,
      has_table_privilege(current_user, 'public."LedgerTransaction"', 'DELETE') AS transaction_delete,
      has_table_privilege(current_user, 'public."AuditLog"', 'UPDATE') AS audit_update,
      has_table_privilege(current_user, 'public."AuditLog"', 'DELETE') AS audit_delete,
      has_table_privilege(current_user, 'public."AuditLog"', 'TRUNCATE') AS audit_truncate,
      has_column_privilege(current_user, 'public."Account"', 'balanceMinor', 'UPDATE') AS balance_update
  `;
  assert(
    !Object.values(privileges).some(Boolean),
    'bv_app unexpectedly has a protected ledger, audit, truncate, or balance-update privilege.',
  );

  await prisma.$transaction(async (tx) => {
    await expectPermissionDenied(tx, 'LedgerEntry UPDATE', () => tx.$executeRaw`
      UPDATE public."LedgerEntry" SET "amountMinor" = "amountMinor" WHERE false
    `);
    await expectPermissionDenied(tx, 'LedgerEntry DELETE', () => tx.$executeRaw`
      DELETE FROM public."LedgerEntry" WHERE false
    `);
    await expectPermissionDenied(tx, 'LedgerTransaction UPDATE', () => tx.$executeRaw`
      UPDATE public."LedgerTransaction" SET "description" = "description" WHERE false
    `);
    await expectPermissionDenied(tx, 'LedgerTransaction DELETE', () => tx.$executeRaw`
      DELETE FROM public."LedgerTransaction" WHERE false
    `);
    await expectPermissionDenied(tx, 'AuditLog UPDATE', () => tx.$executeRaw`
      UPDATE public."AuditLog" SET "action" = "action" WHERE false
    `);
    await expectPermissionDenied(tx, 'AuditLog DELETE', () => tx.$executeRaw`
      DELETE FROM public."AuditLog" WHERE false
    `);
    throw ROLLBACK_MARKER;
  }).catch((error) => {
    if (error !== ROLLBACK_MARKER) {
      throw error;
    }
  });
}

async function runAdminDatabaseChecks(prisma, activeAdmin) {
  if (!activeAdmin) {
    console.log('SKIP: Phase H database integration requires an existing active ADMIN.');
    return;
  }

  const actor = { id: activeAdmin.id, role: 'ADMIN', status: 'ACTIVE' };
  const syntheticUserId = randomUUID();
  const syntheticAccountId = randomUUID();
  const rawToken = randomBytes(32).toString('base64url');
  const sessionHash = hashSessionToken(rawToken);
  const requestId = randomUUID();
  const context = { requestId, ipAddress: null };
  const passwordHash = await hashPassword(PASSWORD);
  const step = { name: 'starting rollback-only admin database checks' };

  try {
    await prisma.$transaction(async (transaction) => {
      const tx = transactionScopedClient(transaction);
      step.name = 'creating rollback-only synthetic customer, account, and session';
      await insertSyntheticUser(tx, syntheticUserId, 'admin-target', passwordHash);
      await insertSyntheticAccount(tx, syntheticAccountId, syntheticUserId);
      await tx.session.create({
        data: {
          tokenHash: sessionHash,
          userId: syntheticUserId,
          expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        },
        select: { id: true },
      });

      step.name = 'querying the admin user list';
      const users = await listAdminUsers(
        tx,
        actor,
        { page: 1, limit: 5 },
      );
      step.name = 'validating the admin user list response';
      assert(
        Array.isArray(users.users)
          && users.users.length <= 5
          && users.pagination.page === 1
          && users.pagination.limit === 5
          && users.pagination.total >= users.users.length,
        'Admin user list returned an invalid paginated response.',
      );
      assert(
        users.users.every((user) => !Object.hasOwn(user, 'passwordHash')),
        'Admin user list exposed a password hash.',
      );
      step.name = 'querying admin user details';
      const userDetails = await getAdminUser(tx, actor, syntheticUserId);
      assert(userDetails.id === syntheticUserId, 'Admin user detail query returned the wrong user.');
      step.name = 'querying the admin audit list';
      const logs = await listAdminAuditLogs(
        tx,
        actor,
        { page: 1, limit: 5 },
        context,
      );
      assert(Array.isArray(logs.auditLogs), 'Admin audit query did not return a list.');
      step.name = 'denying customer admin user-list access';
      let customerDenied = false;
      try {
        await listAdminUsers(
          tx,
          { id: syntheticUserId, role: 'ACCOUNT_HOLDER' },
          { page: 1, limit: 5 },
        );
      } catch (error) {
        customerDenied = error?.code === 'FORBIDDEN';
      }
      assert(customerDenied, 'A customer was not denied direct admin user-list service access.');
      step.name = 'denying customer admin audit access';
      customerDenied = false;
      try {
        await listAdminAuditLogs(
          tx,
          { id: syntheticUserId, role: 'ACCOUNT_HOLDER' },
          { page: 1, limit: 5 },
          context,
        );
      } catch (error) {
        customerDenied = error?.code === 'FORBIDDEN';
      }
      assert(customerDenied, 'A customer was not denied direct admin audit service access.');

      step.name = 'testing database-backed disable, session revocation, and re-enable';
      const disabled = await changeUserStatus(
        tx,
        actor,
        syntheticUserId,
        'DISABLED',
        context,
      );
      assert(disabled.status === 'DISABLED', 'Synthetic customer was not disabled.');
      const revoked = await tx.session.findUnique({
        where: { tokenHash: sessionHash },
        select: { revokedAt: true },
      });
      assert(revoked?.revokedAt, 'Disabling did not revoke the existing session.');
      const session = await resolveSession({
        headers: { cookie: `bv_session=${rawToken}` },
      }, tx);
      assert(session === null, 'A disabled or revoked session remained valid.');
      const reenabled = await changeUserStatus(
        tx,
        actor,
        syntheticUserId,
        'ACTIVE',
        context,
      );
      assert(reenabled.status === 'ACTIVE', 'Synthetic customer could not be re-enabled.');
      const stillRevoked = await tx.session.findUnique({
        where: { tokenHash: sessionHash },
        select: { revokedAt: true },
      });
      assert(stillRevoked?.revokedAt, 'Re-enabling unexpectedly restored the revoked session.');

      step.name = 'checking safe self-disable or last-active-admin refusal';
      const activeAdminCount = await tx.user.count({
        where: { role: 'ADMIN', status: 'ACTIVE' },
      });
      let expectedCode = activeAdminCount === 1 ? 'LAST_ACTIVE_ADMIN' : 'SELF_DISABLE_DENIED';
      try {
        await changeUserStatus(tx, actor, actor.id, 'DISABLED', context);
        throw new Error('Self-disable unexpectedly succeeded.');
      } catch (error) {
        if (error?.code !== expectedCode) {
          throw error;
        }
      }

      step.name = 'checking real PostgreSQL ledger verification read path';
      const { verifyLedgerBalances } = await import('../src/services/ledger-service.js');
      const verification = await verifyLedgerBalances(tx, actor, context);
      assert(
        Number.isSafeInteger(verification.checkedAccountCount),
        'Ledger verification did not return a safe checked-account count.',
      );
      console.log('PASS: Phase H status changes, session revocation, safe self/last-admin refusal, audit SELECT, and ledger verification ran in a rollback-only database transaction.');
      throw ROLLBACK_MARKER;
    }, { timeout: 30_000 });
  } catch (error) {
    if (error !== ROLLBACK_MARKER) {
      throw new Error(
        `Admin database integration failed at ${step.name} (Prisma/SQL code: ${safeErrorCode(error)}).`,
      );
    }
  }

  const [user, session, account, auditCount] = await Promise.all([
    prisma.user.findUnique({ where: { id: syntheticUserId }, select: { id: true } }),
    prisma.session.findUnique({ where: { tokenHash: sessionHash }, select: { id: true } }),
    prisma.account.findUnique({ where: { id: syntheticAccountId }, select: { id: true } }),
    prisma.auditLog.count({ where: { requestId } }),
  ]);
  assert(!user && !session && !account && auditCount === 0, 'Admin integration rollback left synthetic rows behind.');
  console.log('PASS: Phase H synthetic user, session, account, and audit rows were rolled back.');
}

async function createPermanentConcurrencyFixtures(prisma, systemAccount) {
  const userIds = Array.from({ length: 4 }, () => randomUUID());
  const accountIds = Array.from({ length: 4 }, () => randomUUID());
  const passwordHash = await hashPassword(PASSWORD);
  const accountNumbers = accountIds.map(
    () => `BV${randomBytes(10).toString('hex').toUpperCase()}`,
  );

  await prisma.$transaction(async (tx) => {
    for (let index = 0; index < userIds.length; index += 1) {
      await insertSyntheticUser(tx, userIds[index], `concurrency-${index}`, passwordHash);
      const rows = await tx.$queryRaw`
        INSERT INTO public."Account" (
          "id", "accountNumber", "currency", "ownerId", "updatedAt"
        )
        VALUES (
          ${accountIds[index]}::uuid,
          ${accountNumbers[index]},
          'INR',
          ${userIds[index]}::uuid,
          ${new Date()}
        )
        RETURNING "id"
      `;
      assert(rows.length === 1, 'Concurrency account insert did not return one row.');
    }

    await tx.$queryRaw`
      SELECT "id"
      FROM public."Account"
      WHERE "id" IN (
        ${systemAccount.id}::uuid,
        ${accountIds[0]}::uuid,
        ${accountIds[2]}::uuid
      )
      ORDER BY "id"
      FOR UPDATE
    `;
    const transaction = await tx.ledgerTransaction.create({
      data: {
        id: randomUUID(),
        reference: `BV-${randomUUID()}`,
        type: 'FUNDING',
        description: 'Synthetic security concurrency test funding',
        createdById: userIds[0],
      },
      select: { id: true },
    });
    const entries = [
      { accountId: systemAccount.id, direction: 'DEBIT', amountMinor: 2_000n },
      { accountId: accountIds[0], direction: 'CREDIT', amountMinor: 1_000n },
      { accountId: accountIds[2], direction: 'CREDIT', amountMinor: 1_000n },
    ].sort((left, right) => (left.accountId < right.accountId ? -1 : 1));
    for (const entry of entries) {
      await tx.ledgerEntry.create({
        data: {
          transactionId: transaction.id,
          accountId: entry.accountId,
          direction: entry.direction,
          amountMinor: entry.amountMinor,
        },
        select: { id: true },
      });
    }
    await tx.$executeRaw`SET CONSTRAINTS ALL IMMEDIATE`;
  });

  return { userIds, accountIds };
}

async function runRealConcurrencyChecks(prisma, systemAccount) {
  const fixture = await createPermanentConcurrencyFixtures(prisma, systemAccount);
  const context = { requestId: randomUUID(), ipAddress: null };
  const duplicateKey = `security-duplicate-${randomUUID()}`;
  const lowBalanceKeys = Array.from({ length: 20 }, () => `security-low-${randomUUID()}`);
  const actorFor = (index) => ({
    id: fixture.userIds[index],
    role: 'ACCOUNT_HOLDER',
    status: 'ACTIVE',
  });
  let failed = false;

  try {
    const duplicateResults = await Promise.all([
      createTransfer(
        prisma,
        actorFor(0),
        { destinationAccountId: fixture.accountIds[1], amountMinor: 100 },
        duplicateKey,
        { ...context, requestId: randomUUID() },
      ),
      createTransfer(
        prisma,
        actorFor(0),
        { destinationAccountId: fixture.accountIds[1], amountMinor: 100 },
        duplicateKey,
        { ...context, requestId: randomUUID() },
      ),
    ]);
    assert(
      duplicateResults.filter((result) => result.replayed).length === 1,
      'Concurrent duplicate transfer did not return exactly one replay.',
    );
    assert(
      duplicateResults[0].transaction.id === duplicateResults[1].transaction.id,
      'Concurrent duplicate requests returned different transaction IDs.',
    );

    const attempts = await Promise.allSettled(
      lowBalanceKeys.map((key) => createTransfer(
        prisma,
        actorFor(2),
        { destinationAccountId: fixture.accountIds[3], amountMinor: 100 },
        key,
        { ...context, requestId: randomUUID() },
      )),
    );
    const succeeded = attempts.filter((result) => result.status === 'fulfilled');
    const rejected = attempts.filter((result) => result.status === 'rejected');
    assert(succeeded.length === 10, `Expected 10 successful low-balance transfers; got ${succeeded.length}.`);
    assert(
      rejected.length === 10
      && rejected.every((result) => result.reason?.code === 'INSUFFICIENT_FUNDS'),
      'Expected 10 insufficient-funds rejections and no other concurrent transfer errors.',
    );

    const accounts = await prisma.account.findMany({
      where: { id: { in: fixture.accountIds } },
      select: { id: true, balanceMinor: true },
    });
    const balances = new Map(accounts.map((account) => [account.id, account.balanceMinor]));
    assert(
      balances.get(fixture.accountIds[0]) === 900n
      && balances.get(fixture.accountIds[1]) === 100n
      && balances.get(fixture.accountIds[2]) === 0n
      && balances.get(fixture.accountIds[3]) === 1_000n,
      'Concurrent transfer balances did not match the serialized expected result.',
    );

    console.log('PASS: real PostgreSQL concurrent duplicate requests returned one stored transfer result.');
    console.log('PASS: 20 real PostgreSQL transfers against 1,000 paise produced 10 successes, 10 insufficient-funds denials, and no overdraft.');
    console.log('NOTE: append-only test ledger rows remain in balancevault_test; synthetic users were disabled and accounts closed.');
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    await Promise.all([
      prisma.user.updateMany({
        where: { id: { in: fixture.userIds } },
        data: { status: 'DISABLED', updatedAt: new Date() },
      }),
      prisma.account.updateMany({
        where: { id: { in: fixture.accountIds } },
        data: { status: 'CLOSED', updatedAt: new Date() },
      }),
    ]).catch((error) => {
      throw new Error(`Synthetic concurrency fixture cleanup failed (Prisma code: ${safeErrorCode(error)}).`);
    });
    if (failed) {
      console.error('Synthetic concurrency ledger data may remain; fixture users/accounts were closed where possible.');
    }
  }
}

if (!databaseUrl) {
  console.error('Security integration stopped: DATABASE_URL is required.');
  process.exitCode = 1;
} else {
  const prisma = getPrismaClient(databaseUrl);
  try {
    const [identity] = await prisma.$queryRaw`
      SELECT current_database() AS database_name, current_user AS role_name
    `;
    console.log(`Runtime connection identity: database=${identity.database_name} role=${identity.role_name}`);
    if (identity.database_name !== TEST_DATABASE || identity.role_name !== APP_ROLE) {
      throw new Error('Security integration stopped: expected balancevault_test as bv_app.');
    }

    const [activeAdmin, systemAccount] = await Promise.all([
      prisma.user.findFirst({
        where: { role: 'ADMIN', status: 'ACTIVE' },
        select: { id: true, role: true, status: true },
      }),
      prisma.account.findUnique({
        where: { accountNumber: 'BV-SYSTEM-FUNDING-INR' },
        select: { id: true, kind: true, status: true, currency: true },
      }),
    ]);
    if (
      !systemAccount
      || systemAccount.kind !== 'SYSTEM'
      || systemAccount.status !== 'ACTIVE'
      || systemAccount.currency !== 'INR'
    ) {
      throw new Error('Security integration stopped: the active test SYSTEM funding account is unavailable.');
    }

    const adminOnly = process.argv.includes('--admin-only');
    if (!adminOnly) {
      console.log('Checking runtime ledger, audit, and balance-write permission boundaries...');
      await verifyLedgerAndAuditImmutability(prisma);
      console.log('PASS: bv_app cannot UPDATE or DELETE ledger/audit rows, TRUNCATE audit, or UPDATE cached balances.');
    }
    await runAdminDatabaseChecks(prisma, activeAdmin);
    if (!adminOnly) {
      await runRealConcurrencyChecks(prisma, systemAccount);
    }
  } catch (error) {
    console.error(error.message || `Security integration failed (Prisma code: ${safeErrorCode(error)}).`);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}
