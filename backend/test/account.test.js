import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { hashPassword } from '../src/auth/password.js';
import {
  provisionApprovedApplicationAccountInTransaction,
} from '../src/services/account-service.js';
import {
  TEST_ORIGIN,
  fetchCsrf,
  withAuthServer,
} from './helpers/auth-test-app.js';

const PASSWORD = 'Synthetic-Account-Password-948!';
const APPLICATION = {
  legalName: 'Synthetic Account Holder',
  dateOfBirth: '1997-08-11',
  phone: '+1 (555) 010-5500',
  addressLine: '11 Example Avenue',
  city: 'Sample City',
  country: 'IN',
};

async function request(baseUrl, path, {
  method = 'GET',
  body,
  cookie,
  origin = TEST_ORIGIN,
  csrf = method === 'POST' || method === 'PATCH',
} = {}) {
  const csrfData = csrf ? await fetchCsrf(baseUrl, cookie ? [cookie] : []) : null;
  const cookies = [cookie, csrfData?.csrfCookie ? `bv_csrf=${csrfData.csrfCookie}` : null]
    .filter(Boolean);
  const headers = {
    origin,
    ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    ...(csrfData ? { 'x-csrf-token': csrfData.token } : {}),
    ...(cookies.length ? { cookie: cookies.join('; ') } : {}),
  };
  return fetch(`${baseUrl}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function register(baseUrl, email) {
  const response = await request(baseUrl, '/api/auth/register', {
    method: 'POST',
    body: { email, fullName: 'Synthetic Customer', password: PASSWORD },
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
  const user = await register(baseUrl, email);
  const session = await login(baseUrl, email);
  return { ...session, user: user.user };
}

async function adminSession(baseUrl, prisma) {
  const id = randomUUID();
  prisma.users.set(id, {
    id,
    email: `admin-${id}@example.test`,
    fullName: 'Synthetic Account Admin',
    passwordHash: await hashPassword(PASSWORD),
    role: 'ADMIN',
    status: 'ACTIVE',
    mustChangePassword: false,
    failedLoginCount: 0,
    lockedUntil: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return login(baseUrl, `admin-${id}@example.test`);
}

async function submitApplication(baseUrl, customer) {
  return request(baseUrl, '/api/onboarding/applications', {
    method: 'POST',
    cookie: customer.cookie,
    body: APPLICATION,
  });
}

async function approveApplication(baseUrl, admin, applicationId) {
  return request(baseUrl, `/api/admin/onboarding/applications/${applicationId}/decision`, {
    method: 'PATCH',
    cookie: admin.cookie,
    body: { decision: 'APPROVED' },
  });
}

async function provisionedFixture(baseUrl, prisma, email) {
  const customer = await customerSession(baseUrl, email);
  const submitted = await submitApplication(baseUrl, customer);
  const application = (await submitted.json()).application;
  const admin = await adminSession(baseUrl, prisma);
  const decision = await approveApplication(baseUrl, admin, application.id);
  assert.equal(decision.status, 200);
  return {
    customer,
    admin,
    application,
    account: (await decision.json()).account,
  };
}

test('only an approved application can provision a customer account', async () => {
  await withAuthServer(async ({ baseUrl, prisma }) => {
    const customer = await customerSession(baseUrl);
    const submission = await submitApplication(baseUrl, customer);
    const pending = (await submission.json()).application;
    const admin = await adminSession(baseUrl, prisma);

    await assert.rejects(
      provisionApprovedApplicationAccountInTransaction(
        prisma,
        admin.body.user,
        pending.id,
        { requestId: randomUUID(), ipAddress: null },
      ),
      (error) => error.code === 'APPLICATION_NOT_APPROVED',
    );
    assert.equal(prisma.accounts.size, 0);

    const decision = await request(baseUrl,
      `/api/admin/onboarding/applications/${pending.id}/decision`, {
        method: 'PATCH',
        cookie: admin.cookie,
        body: { decision: 'REJECTED' },
      });
    assert.equal(decision.status, 200);
    assert.equal(prisma.accounts.size, 0);
  });
});

test('approval atomically provisions an active INR CUSTOMER account with zero cached balance', async () => {
  await withAuthServer(async ({ baseUrl, prisma }) => {
    const fixture = await provisionedFixture(baseUrl, prisma, 'approved@example.test');
    const account = prisma.accounts.get(fixture.account.id);

    assert.equal(fixture.account.kind, 'CUSTOMER');
    assert.equal(fixture.account.status, 'ACTIVE');
    assert.equal(fixture.account.currency, 'INR');
    assert.equal(fixture.account.balanceMinor, '0');
    assert.equal(account.ownerId, fixture.customer.user.id);
    assert.equal(account.kind, 'CUSTOMER');
    assert.equal(prisma.accounts.size, 1);
    assert.match(account.accountNumber, /^BV[0-9A-F]{20}$/u);
  });
});

test('provisioning is idempotent and concurrent retries create one account', async () => {
  await withAuthServer(async ({ baseUrl, prisma }) => {
    const fixture = await provisionedFixture(baseUrl, prisma, 'idempotent@example.test');
    const context = { requestId: randomUUID(), ipAddress: null };
    const results = await Promise.all([
      provisionApprovedApplicationAccountInTransaction(
        prisma, fixture.admin.body.user, fixture.application.id, context,
      ),
      provisionApprovedApplicationAccountInTransaction(
        prisma, fixture.admin.body.user, fixture.application.id, context,
      ),
    ]);

    assert.equal(prisma.accounts.size, 1);
    assert.equal(results[0].account.id, results[1].account.id);
    assert.equal(results.filter((result) => result.created).length, 0);
  });
});

test('account numbers are unique across provisioned customers', async () => {
  await withAuthServer(async ({ baseUrl, prisma }) => {
    const admin = await adminSession(baseUrl, prisma);
    const accountNumbers = [];
    for (let index = 0; index < 4; index += 1) {
      const customer = await customerSession(baseUrl, `number-${index}@example.test`);
      const submitted = await submitApplication(baseUrl, customer);
      const application = (await submitted.json()).application;
      const decision = await approveApplication(baseUrl, admin, application.id);
      assert.equal(decision.status, 200);
      accountNumbers.push((await decision.json()).account.accountNumber);
    }

    assert.equal(new Set(accountNumbers).size, accountNumbers.length);
  });
});

test('account collection requires authentication and lists only owned CUSTOMER accounts', async () => {
  await withAuthServer(async ({ baseUrl, prisma }) => {
    const unauthenticated = await request(baseUrl, '/api/accounts');
    assert.equal(unauthenticated.status, 401);

    const owner = await provisionedFixture(baseUrl, prisma, 'account-owner@example.test');
    const other = await provisionedFixture(baseUrl, prisma, 'account-other@example.test');
    const systemId = randomUUID();
    prisma.accounts.set(systemId, {
      id: systemId,
      accountNumber: 'SYSTEM-SYNTHETIC',
      kind: 'SYSTEM',
      status: 'ACTIVE',
      currency: 'INR',
      balanceMinor: -100n,
      ownerId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const response = await request(baseUrl, '/api/accounts', { cookie: owner.customer.cookie });
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.accounts.length, 1);
    assert.equal(body.accounts[0].id, owner.account.id);
    assert.equal(body.accounts[0].balanceMinor, '0');
    assert.equal(body.accounts.some((account) => account.id === other.account.id), false);
    assert.equal(body.accounts.some((account) => account.id === systemId), false);
    assert.equal(response.headers.get('cache-control'), 'no-store');
  });
});

test('customer account detail returns 404 for another owner and SYSTEM accounts', async () => {
  await withAuthServer(async ({ baseUrl, prisma }) => {
    const owner = await provisionedFixture(baseUrl, prisma, 'detail-owner@example.test');
    const other = await provisionedFixture(baseUrl, prisma, 'detail-other@example.test');
    const systemId = randomUUID();
    prisma.accounts.set(systemId, {
      id: systemId,
      accountNumber: 'SYSTEM-DETAIL',
      kind: 'SYSTEM',
      status: 'ACTIVE',
      currency: 'INR',
      balanceMinor: 0n,
      ownerId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const own = await request(baseUrl, `/api/accounts/${owner.account.id}`, {
      cookie: owner.customer.cookie,
    });
    const foreign = await request(baseUrl, `/api/accounts/${other.account.id}`, {
      cookie: owner.customer.cookie,
    });
    const system = await request(baseUrl, `/api/accounts/${systemId}`, {
      cookie: owner.customer.cookie,
    });
    assert.equal(own.status, 200);
    assert.equal(foreign.status, 404);
    assert.equal(system.status, 404);
  });
});

test('customer cannot access admin account endpoints or change account fields', async () => {
  await withAuthServer(async ({ baseUrl, prisma }) => {
    const fixture = await provisionedFixture(baseUrl, prisma, 'no-escalation@example.test');
    const list = await request(baseUrl, '/api/admin/accounts', {
      cookie: fixture.customer.cookie,
    });
    const detail = await request(baseUrl, `/api/admin/accounts/${fixture.account.id}`, {
      cookie: fixture.customer.cookie,
    });
    const statusChange = await request(baseUrl, `/api/admin/accounts/${fixture.account.id}/status`, {
      method: 'PATCH',
      cookie: fixture.customer.cookie,
      body: { status: 'FROZEN' },
    });
    const unsupported = await request(baseUrl, `/api/accounts/${fixture.account.id}`, {
      method: 'PATCH',
      cookie: fixture.customer.cookie,
      body: { balanceMinor: '1000', kind: 'SYSTEM', ownerId: null, status: 'CLOSED' },
    });

    assert.equal(list.status, 403);
    assert.equal(detail.status, 403);
    assert.equal(statusChange.status, 403);
    assert.equal(unsupported.status, 404);
    assert.equal(prisma.accounts.get(fixture.account.id).balanceMinor, 0n);
    assert.equal(prisma.accounts.get(fixture.account.id).kind, 'CUSTOMER');
    assert.equal(prisma.accounts.get(fixture.account.id).status, 'ACTIVE');
  });
});

test('admin can list accounts with safe filters and read account details', async () => {
  await withAuthServer(async ({ baseUrl, prisma }) => {
    const fixture = await provisionedFixture(baseUrl, prisma, 'admin-list@example.test');
    const list = await request(baseUrl, '/api/admin/accounts?status=ACTIVE&kind=CUSTOMER&limit=1', {
      cookie: fixture.admin.cookie,
    });
    const body = await list.json();
    const detail = await request(baseUrl, `/api/admin/accounts/${fixture.account.id}`, {
      cookie: fixture.admin.cookie,
    });
    const detailBody = await detail.json();

    assert.equal(list.status, 200);
    assert.equal(body.pagination.total, 1);
    assert.equal(body.accounts[0].id, fixture.account.id);
    assert.equal(body.accounts[0].owner.email, 'admin-list@example.test');
    assert.equal(Object.hasOwn(body.accounts[0].owner, 'passwordHash'), false);
    assert.equal(detail.status, 200);
    assert.equal(detailBody.account.balanceMinor, '0');
    assert.equal(Object.hasOwn(detailBody.account, 'ownerId'), false);
  });
});

test('admin status changes enforce allowed transitions and write audit records', async () => {
  await withAuthServer(async ({ baseUrl, prisma }) => {
    const fixture = await provisionedFixture(baseUrl, prisma, 'status-change@example.test');
    const freeze = await request(baseUrl, `/api/admin/accounts/${fixture.account.id}/status`, {
      method: 'PATCH',
      cookie: fixture.admin.cookie,
      body: { status: 'FROZEN' },
    });
    assert.equal(freeze.status, 200);
    assert.equal((await freeze.json()).account.status, 'FROZEN');
    assert.ok(prisma.auditRows.some((row) => (
      row.action === 'account.status.change'
      && row.actorId === fixture.admin.body.user.id
      && row.targetId === fixture.account.id
      && row.targetType === 'Account'
      && row.outcome === 'SUCCESS'
    )));

    const close = await request(baseUrl, `/api/admin/accounts/${fixture.account.id}/status`, {
      method: 'PATCH',
      cookie: fixture.admin.cookie,
      body: { status: 'CLOSED' },
    });
    assert.equal(close.status, 200);

    const reopen = await request(baseUrl, `/api/admin/accounts/${fixture.account.id}/status`, {
      method: 'PATCH',
      cookie: fixture.admin.cookie,
      body: { status: 'ACTIVE' },
    });
    assert.equal(reopen.status, 409);
    assert.equal(prisma.accounts.get(fixture.account.id).status, 'CLOSED');
    assert.ok(prisma.auditRows.some((row) => (
      row.targetId === fixture.account.id
      && row.outcome === 'DENIED'
      && row.metadata?.reasonCode === 'INVALID_STATUS_TRANSITION'
    )));
  });
});

test('SYSTEM account cannot be modified by admin route or underlying service', async () => {
  await withAuthServer(async ({ baseUrl, prisma }) => {
    const admin = await adminSession(baseUrl, prisma);
    const id = randomUUID();
    prisma.accounts.set(id, {
      id,
      accountNumber: 'SYSTEM-PROTECTED',
      kind: 'SYSTEM',
      status: 'ACTIVE',
      currency: 'INR',
      balanceMinor: -1n,
      ownerId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const response = await request(baseUrl, `/api/admin/accounts/${id}/status`, {
      method: 'PATCH',
      cookie: admin.cookie,
      body: { status: 'FROZEN' },
    });
    const body = await response.json();
    assert.equal(response.status, 409);
    assert.equal(body.error.code, 'SYSTEM_ACCOUNT_PROTECTED');
    assert.equal(prisma.accounts.get(id).status, 'ACTIVE');
  });
});

test('account status input rejects mass assignment and invalid IDs or filters', async () => {
  await withAuthServer(async ({ baseUrl, prisma }) => {
    const fixture = await provisionedFixture(baseUrl, prisma, 'invalid-fields@example.test');
    const forged = await request(baseUrl, `/api/admin/accounts/${fixture.account.id}/status`, {
      method: 'PATCH',
      cookie: fixture.admin.cookie,
      body: {
        status: 'FROZEN',
        balanceMinor: '500000',
        kind: 'SYSTEM',
        accountNumber: 'FORGED',
        ownerId: null,
      },
    });
    const invalidStatus = await request(baseUrl, `/api/admin/accounts/${fixture.account.id}/status`, {
      method: 'PATCH',
      cookie: fixture.admin.cookie,
      body: { status: 'PENDING' },
    });
    const invalidId = await request(baseUrl, '/api/admin/accounts/not-a-uuid', {
      cookie: fixture.admin.cookie,
    });
    const invalidFilter = await request(baseUrl, '/api/admin/accounts?kind=OTHER', {
      cookie: fixture.admin.cookie,
    });

    assert.equal(forged.status, 400);
    assert.equal(invalidStatus.status, 400);
    assert.equal(invalidId.status, 400);
    assert.equal(invalidFilter.status, 400);
    assert.equal(prisma.accounts.get(fixture.account.id).balanceMinor, 0n);
    assert.equal(prisma.accounts.get(fixture.account.id).kind, 'CUSTOMER');
  });
});

test('CSRF and Origin checks protect admin account status changes', async () => {
  await withAuthServer(async ({ baseUrl, prisma }) => {
    const fixture = await provisionedFixture(baseUrl, prisma, 'csrf-status@example.test');
    const noCsrf = await request(baseUrl, `/api/admin/accounts/${fixture.account.id}/status`, {
      method: 'PATCH',
      cookie: fixture.admin.cookie,
      csrf: false,
      body: { status: 'FROZEN' },
    });
    const badOrigin = await request(baseUrl, `/api/admin/accounts/${fixture.account.id}/status`, {
      method: 'PATCH',
      cookie: fixture.admin.cookie,
      origin: 'https://attacker.example.test',
      body: { status: 'FROZEN' },
    });
    assert.equal(noCsrf.status, 403);
    assert.equal(badOrigin.status, 403);
    assert.equal(prisma.accounts.get(fixture.account.id).status, 'ACTIVE');
  });
});

test('account response is ledger balance only and serializes minor units as a string', async () => {
  await withAuthServer(async ({ baseUrl, prisma }) => {
    const fixture = await provisionedFixture(baseUrl, prisma, 'balance-string@example.test');
    prisma.accounts.get(fixture.account.id).balanceMinor = 123456n;
    const response = await request(baseUrl, `/api/accounts/${fixture.account.id}`, {
      cookie: fixture.customer.cookie,
    });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.account.balanceMinor, '123456');
    assert.equal(typeof body.account.balanceMinor, 'string');
    assert.equal(Object.hasOwn(body.account, 'ownerId'), false);
  });
});
