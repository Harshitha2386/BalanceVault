import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { hashPassword } from '../src/auth/password.js';
import {
  TEST_ORIGIN,
  fetchCsrf,
  withAuthServer,
} from './helpers/auth-test-app.js';

const PASSWORD = 'Synthetic-Ledger-Password-948!';

async function request(baseUrl, path, {
  method = 'GET',
  body,
  cookie,
  origin = TEST_ORIGIN,
  csrf = method === 'POST' || method === 'PATCH',
  idempotencyKey,
} = {}) {
  const csrfData = csrf ? await fetchCsrf(baseUrl, cookie ? [cookie] : []) : null;
  const cookies = [cookie, csrfData?.csrfCookie ? `bv_csrf=${csrfData.csrfCookie}` : null]
    .filter(Boolean);
  const headers = {
    origin,
    ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    ...(csrfData ? { 'x-csrf-token': csrfData.token } : {}),
    ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
    ...(cookies.length ? { cookie: cookies.join('; ') } : {}),
  };
  return fetch(`${baseUrl}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function register(baseUrl, email, fullName = 'Synthetic Ledger User') {
  const response = await request(baseUrl, '/api/auth/register', {
    method: 'POST',
    body: { email, fullName, password: PASSWORD },
  });
  assert.equal(response.status, 201);
  return response.json();
}

async function login(baseUrl, email) {
  const response = await request(baseUrl, '/api/auth/login', {
    method: 'POST',
    body: { email, password: PASSWORD },
  });
  assert.equal(response.status, 200);
  const value = response.headers.getSetCookie()
    .map((header) => header.match(/(?:^|;\s*)bv_session=([^;]+)/u)?.[1])
    .find(Boolean);
  assert.ok(value);
  return { cookie: `bv_session=${decodeURIComponent(value)}`, body: await response.json() };
}

async function customerSession(baseUrl, email = `${randomUUID()}@example.test`) {
  const registration = await register(baseUrl, email);
  const session = await login(baseUrl, email);
  return { ...session, user: registration.user };
}

async function adminSession(baseUrl, prisma) {
  const id = randomUUID();
  const email = `admin-${id}@example.test`;
  prisma.users.set(id, {
    id,
    email,
    fullName: 'Synthetic Ledger Admin',
    passwordHash: await hashPassword(PASSWORD),
    role: 'ADMIN',
    status: 'ACTIVE',
    mustChangePassword: false,
    failedLoginCount: 0,
    lockedUntil: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return login(baseUrl, email);
}

function addAccount(prisma, {
  ownerId = null,
  kind = 'CUSTOMER',
  status = 'ACTIVE',
  currency = 'INR',
  balanceMinor = 0n,
  accountNumber,
} = {}) {
  const id = randomUUID();
  const account = {
    id,
    accountNumber: accountNumber || `TEST-${id}`,
    kind,
    status,
    currency,
    balanceMinor,
    ownerId,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  prisma.accounts.set(id, account);
  return account;
}

function seedLedgerTransaction(prisma, type, entries) {
  const id = randomUUID();
  prisma.ledgerTransactions.set(id, {
    id,
    reference: `SEED-${id}`,
    type,
    description: 'Synthetic test fixture',
    createdById: null,
    createdAt: new Date(),
  });
  for (const entry of entries) {
    prisma.ledgerEntries.push({
      id: BigInt(prisma.ledgerEntries.length + 1),
      transactionId: id,
      accountId: entry.accountId,
      direction: entry.direction,
      amountMinor: entry.amountMinor,
      createdAt: new Date(),
    });
  }
  return id;
}

async function transferFixture(baseUrl, prisma, balanceMinor = 1_000n) {
  const owner = await customerSession(baseUrl);
  const recipient = await customerSession(baseUrl);
  const system = addAccount(prisma, {
    kind: 'SYSTEM',
    accountNumber: 'BV-SYSTEM-FUNDING-INR',
  });
  const source = addAccount(prisma, {
    ownerId: owner.user.id,
    balanceMinor,
  });
  const destination = addAccount(prisma, { ownerId: recipient.user.id });
  if (balanceMinor > 0n) {
    system.balanceMinor = -balanceMinor;
    seedLedgerTransaction(prisma, 'FUNDING', [
      { accountId: system.id, direction: 'DEBIT', amountMinor: balanceMinor },
      { accountId: source.id, direction: 'CREDIT', amountMinor: balanceMinor },
    ]);
  }
  return { owner, recipient, system, source, destination };
}

async function fundingFixture(baseUrl, prisma) {
  const admin = await adminSession(baseUrl, prisma);
  const recipient = await customerSession(baseUrl);
  const system = addAccount(prisma, {
    kind: 'SYSTEM',
    accountNumber: 'BV-SYSTEM-FUNDING-INR',
  });
  const destination = addAccount(prisma, { ownerId: recipient.user.id });
  return { admin, recipient, system, destination };
}

test('customer transaction history is owner-scoped and hides counterparty account details', async () => {
  await withAuthServer(async ({ baseUrl, prisma }) => {
    const fixture = await transferFixture(baseUrl, prisma, 1_000n);
    const otherTransaction = randomUUID();
    prisma.ledgerTransactions.set(otherTransaction, {
      id: otherTransaction,
      reference: `OTHER-${otherTransaction}`,
      type: 'TRANSFER',
      createdAt: new Date(Date.now() + 1000),
    });
    prisma.ledgerEntries.push({
      id: BigInt(prisma.ledgerEntries.length + 1),
      transactionId: otherTransaction,
      accountId: fixture.destination.id,
      direction: 'CREDIT',
      amountMinor: 5n,
      createdAt: new Date(),
    });

    const response = await request(baseUrl, '/api/transactions?type=FUNDING', {
      cookie: fixture.owner.cookie,
    });
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.pagination.total, 1);
    assert.equal(body.transactions[0].entries.length, 1);
    assert.equal(body.transactions[0].entries[0].direction, 'CREDIT');
    assert.equal(body.transactions[0].entries[0].amountMinor, '1000');
    assert.equal(Object.hasOwn(body.transactions[0].entries[0], 'accountId'), false);
    assert.equal(Object.hasOwn(body.transactions[0].entries[0], 'accountNumber'), false);

    const unauthenticated = await request(baseUrl, '/api/transactions', { csrf: false });
    assert.equal(unauthenticated.status, 401);
  });
});

test('transfer rejects unauthenticated, forged-source and malformed or excessive requests', async () => {
  await withAuthServer(async ({ baseUrl, prisma }) => {
    const fixture = await transferFixture(baseUrl, prisma);
    const noSession = await request(baseUrl, '/api/transfers', {
      method: 'POST',
      body: { destinationAccountId: fixture.destination.id, amountMinor: 1 },
      idempotencyKey: 'unauthenticated-01',
    });
    const forgedSource = await request(baseUrl, '/api/transfers', {
      method: 'POST',
      cookie: fixture.owner.cookie,
      body: {
        destinationAccountId: fixture.destination.id,
        amountMinor: 1,
        sourceAccountId: fixture.destination.id,
      },
      idempotencyKey: 'forged-source-01',
    });
    assert.equal(noSession.status, 401);
    assert.ok(prisma.auditRows.some((row) => (
      row.action === 'ledger.transfer.create'
      && row.actorId === null
      && row.outcome === 'DENIED'
      && row.metadata?.reasonCode === 'AUTH_REQUIRED'
    )));
    assert.equal(forgedSource.status, 400);

    const invalidAmounts = [0, -1, 1.5, 100_000_001, '10', null];
    for (const amountMinor of invalidAmounts) {
      const response = await request(baseUrl, '/api/transfers', {
        method: 'POST',
        cookie: fixture.owner.cookie,
        body: { destinationAccountId: fixture.destination.id, amountMinor },
        idempotencyKey: `invalid-amount-${String(amountMinor).replace('.', '-')}`,
      });
      assert.equal(response.status, 400, `amount ${String(amountMinor)} must be rejected`);
    }

    const missingKey = await request(baseUrl, '/api/transfers', {
      method: 'POST',
      cookie: fixture.owner.cookie,
      body: { destinationAccountId: fixture.destination.id, amountMinor: 1 },
    });
    assert.equal(missingKey.status, 400);
    assert.equal(prisma.ledgerTransactions.size, 1);
  });
});

test('transfer posts two balanced entries and uses the ledger trigger cache behavior', async () => {
  await withAuthServer(async ({ baseUrl, prisma }) => {
    const fixture = await transferFixture(baseUrl, prisma);
    const response = await request(baseUrl, '/api/transfers', {
      method: 'POST',
      cookie: fixture.owner.cookie,
      body: { destinationAccountId: fixture.destination.id, amountMinor: 250 },
      idempotencyKey: 'transfer-success-01',
    });
    const body = await response.json();
    assert.equal(response.status, 201);
    assert.equal(body.transaction.amountMinor, '250');
    assert.equal(body.transaction.type, 'TRANSFER');
    assert.equal(fixture.source.balanceMinor, 750n);
    assert.equal(fixture.destination.balanceMinor, 250n);
    const posted = [...prisma.ledgerEntries].filter(
      (entry) => entry.transactionId === body.transaction.id,
    );
    assert.equal(posted.length, 2);
    assert.equal(posted.reduce((sum, entry) => (
      sum + (entry.direction === 'DEBIT' ? entry.amountMinor : 0n)
    ), 0n), 250n);
    assert.equal(posted.reduce((sum, entry) => (
      sum + (entry.direction === 'CREDIT' ? entry.amountMinor : 0n)
    ), 0n), 250n);
    assert.ok(prisma.auditRows.some((row) => (
      row.action === 'ledger.transfer.create'
      && row.targetId === body.transaction.id
      && row.outcome === 'SUCCESS'
    )));
  });
});

test('idempotency replays the original result and rejects a different body', async () => {
  await withAuthServer(async ({ baseUrl, prisma }) => {
    const fixture = await transferFixture(baseUrl, prisma);
    const send = (amountMinor) => request(baseUrl, '/api/transfers', {
      method: 'POST',
      cookie: fixture.owner.cookie,
      body: { destinationAccountId: fixture.destination.id, amountMinor },
      idempotencyKey: 'stable-idempotency-key',
    });

    const first = await send(200);
    const firstBody = await first.json();
    const replay = await send(200);
    const replayBody = await replay.json();
    const mismatch = await send(201);
    const mismatchBody = await mismatch.json();

    assert.equal(first.status, 201);
    assert.equal(replay.status, 200);
    assert.equal(replayBody.replayed, true);
    assert.equal(replayBody.transaction.id, firstBody.transaction.id);
    assert.equal(mismatch.status, 409);
    assert.equal(mismatchBody.error.code, 'IDEMPOTENCY_KEY_REUSED');
    assert.equal(prisma.ledgerTransactions.size, 2);
    assert.equal(prisma.idempotencyRecords.size, 1);
    assert.ok(prisma.auditRows.some((row) => (
      row.action === 'ledger.transfer.create'
      && row.outcome === 'DENIED'
      && row.metadata?.reasonCode === 'IDEMPOTENCY_KEY_REUSED'
    )));
  });
});

test('concurrent duplicate requests create exactly one ledger transaction', async () => {
  await withAuthServer(async ({ baseUrl, prisma }) => {
    const fixture = await transferFixture(baseUrl, prisma);
    const send = () => request(baseUrl, '/api/transfers', {
      method: 'POST',
      cookie: fixture.owner.cookie,
      body: { destinationAccountId: fixture.destination.id, amountMinor: 100 },
      idempotencyKey: 'concurrent-duplicate-01',
    });
    const responses = await Promise.all([send(), send()]);
    const bodies = await Promise.all(responses.map((response) => response.json()));

    assert.deepEqual(responses.map((response) => response.status).sort(), [200, 201]);
    assert.equal(bodies[0].transaction.id, bodies[1].transaction.id);
    assert.equal(prisma.ledgerTransactions.size, 2);
    assert.equal(prisma.idempotencyRecords.size, 1);
  });
});

test('insufficient funds, inactive accounts and currency mismatches are rejected', async () => {
  await withAuthServer(async ({ baseUrl, prisma }) => {
    const fixture = await transferFixture(baseUrl, prisma, 100n);
    const send = (destination, amount, key) => request(baseUrl, '/api/transfers', {
      method: 'POST',
      cookie: fixture.owner.cookie,
      body: { destinationAccountId: destination.id, amountMinor: amount },
      idempotencyKey: key,
    });
    const insufficient = await send(fixture.destination, 101, 'insufficient-01');
    const inactiveDestination = addAccount(prisma, {
      ownerId: randomUUID(),
      status: 'FROZEN',
    });
    const inactive = await send(inactiveDestination, 1, 'inactive-01');
    const foreignCurrency = addAccount(prisma, {
      ownerId: randomUUID(),
      currency: 'USD',
    });
    const mismatch = await send(foreignCurrency, 1, 'currency-mismatch-01');
    assert.equal(insufficient.status, 409);
    assert.equal((await insufficient.json()).error.code, 'INSUFFICIENT_FUNDS');
    assert.equal(inactive.status, 409);
    assert.equal((await inactive.json()).error.code, 'ACCOUNT_NOT_ACTIVE');
    assert.equal(mismatch.status, 409);
    assert.equal((await mismatch.json()).error.code, 'CURRENCY_MISMATCH');
    assert.equal(fixture.source.balanceMinor, 100n);
    assert.ok(prisma.auditRows.some((row) => (
      row.action === 'ledger.transfer.create'
      && row.outcome === 'DENIED'
      && row.metadata?.reasonCode === 'INSUFFICIENT_FUNDS'
    )));
  });
});

test('twenty concurrent transfers cannot overdraw a low balance', async () => {
  await withAuthServer(async ({ baseUrl, prisma }) => {
    const fixture = await transferFixture(baseUrl, prisma, 1_000n);
    const responses = await Promise.all(Array.from({ length: 20 }, (_, index) => (
      request(baseUrl, '/api/transfers', {
        method: 'POST',
        cookie: fixture.owner.cookie,
        body: { destinationAccountId: fixture.destination.id, amountMinor: 100 },
        idempotencyKey: `low-balance-${String(index).padStart(2, '0')}`,
      })
    )));
    const statuses = responses.map((response) => response.status);

    assert.equal(statuses.filter((status) => status === 201).length, 10);
    assert.equal(statuses.filter((status) => status === 409).length, 10);
    assert.equal(fixture.source.balanceMinor, 0n);
    assert.equal(fixture.destination.balanceMinor, 1_000n);
    assert.equal(prisma.ledgerEntries.length, 22);
  });
});

test('admin funding uses the SYSTEM account and is idempotent', async () => {
  await withAuthServer(async ({ baseUrl, prisma }) => {
    const fixture = await fundingFixture(baseUrl, prisma);
    const send = () => request(
      baseUrl,
      `/api/admin/accounts/${fixture.destination.id}/fund`,
      {
        method: 'POST',
        cookie: fixture.admin.cookie,
        body: { amountMinor: 500 },
        idempotencyKey: 'admin-funding-0001',
      },
    );
    const first = await send();
    const firstBody = await first.json();
    const replay = await send();
    const replayBody = await replay.json();
    const mismatch = await request(
      baseUrl,
      `/api/admin/accounts/${fixture.destination.id}/fund`,
      {
        method: 'POST',
        cookie: fixture.admin.cookie,
        body: { amountMinor: 501 },
        idempotencyKey: 'admin-funding-0001',
      },
    );
    const systemTarget = await request(
      baseUrl,
      `/api/admin/accounts/${fixture.system.id}/fund`,
      {
        method: 'POST',
        cookie: fixture.admin.cookie,
        body: { amountMinor: 1 },
        idempotencyKey: 'admin-funding-system',
      },
    );

    assert.equal(first.status, 201);
    assert.equal(firstBody.transaction.type, 'FUNDING');
    assert.equal(replay.status, 200);
    assert.equal(replayBody.transaction.id, firstBody.transaction.id);
    assert.equal(mismatch.status, 409);
    assert.equal(fixture.system.balanceMinor, -500n);
    assert.equal(fixture.destination.balanceMinor, 500n);
    assert.equal(systemTarget.status, 400);
    assert.ok(prisma.auditRows.some((row) => (
      row.action === 'ledger.funding.create'
      && row.targetId === firstBody.transaction.id
      && row.outcome === 'SUCCESS'
    )));
  });
});

test('customers cannot access funding or ledger verification and state changes require CSRF and Origin', async () => {
  await withAuthServer(async ({ baseUrl, prisma }) => {
    const fixture = await fundingFixture(baseUrl, prisma);
    const customerFunding = await request(
      baseUrl,
      `/api/admin/accounts/${fixture.destination.id}/fund`,
      {
        method: 'POST',
        cookie: fixture.recipient.cookie,
        body: { amountMinor: 10 },
        idempotencyKey: 'customer-funding-01',
      },
    );
    const customerVerify = await request(baseUrl, '/api/admin/ledger/verify', {
      method: 'POST',
      cookie: fixture.recipient.cookie,
    });
    const noCsrf = await request(baseUrl, '/api/transfers', {
      method: 'POST',
      cookie: fixture.recipient.cookie,
      csrf: false,
      body: { destinationAccountId: fixture.destination.id, amountMinor: 1 },
      idempotencyKey: 'missing-csrf-01',
    });
    const badOrigin = await request(baseUrl, '/api/admin/ledger/verify', {
      method: 'POST',
      cookie: fixture.admin.cookie,
      origin: 'https://attacker.example.test',
    });

    assert.equal(customerFunding.status, 403);
    assert.equal(customerVerify.status, 403);
    assert.ok(prisma.auditRows.some((row) => (
      row.action === 'ledger.funding.create'
      && row.actorId === fixture.recipient.user.id
      && row.outcome === 'DENIED'
    )));
    assert.equal(noCsrf.status, 403);
    assert.equal(badOrigin.status, 403);
    assert.equal(prisma.ledgerEntries.length, 0);
  });
});

test('admin ledger verification reports drift and never repairs balances', async () => {
  await withAuthServer(async ({ baseUrl, prisma }) => {
    const fixture = await transferFixture(baseUrl, prisma, 1_000n);
    const admin = await adminSession(baseUrl, prisma);
    fixture.source.balanceMinor += 7n;
    const before = [...prisma.accounts.values()].map(({ id, balanceMinor }) => [id, balanceMinor]);

    const response = await request(baseUrl, '/api/admin/ledger/verify', {
      method: 'POST',
      cookie: admin.cookie,
    });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.consistent, false);
    assert.equal(body.checkedAccountCount, 3);
    assert.equal(body.discrepancyCount, 1);
    assert.deepEqual(body.discrepancies[0], {
      accountId: fixture.source.id,
      kind: 'CUSTOMER',
      ledgerBalanceMinor: '1000',
      cachedBalanceMinor: '1007',
    });
    assert.deepEqual(
      [...prisma.accounts.values()].map(({ id, balanceMinor }) => [id, balanceMinor]),
      before,
    );
    assert.ok(prisma.auditRows.some((row) => (
      row.action === 'ledger.verify'
      && row.targetType === 'LedgerVerification'
      && row.outcome === 'SUCCESS'
      && row.metadata?.reasonCode === 'BALANCE_DISCREPANCIES_FOUND'
    )));
  });
});
