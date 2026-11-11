import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { hashPassword } from '../src/auth/password.js';
import {
  changeUserStatus,
  listAdminUsers,
} from '../src/services/admin-management-service.js';
import { FakePrisma } from './helpers/fake-prisma.js';
import {
  TEST_ORIGIN,
  fetchCsrf,
  withAuthServer,
} from './helpers/auth-test-app.js';

const PASSWORD = 'Synthetic-Admin-Password-948!';

function addUser(prisma, {
  id = randomUUID(),
  email = `${id}@example.test`,
  fullName = 'Synthetic Test User',
  role = 'ACCOUNT_HOLDER',
  status = 'ACTIVE',
  createdAt = new Date(),
  passwordHash = 'not-returned',
} = {}) {
  const user = {
    id,
    email,
    fullName,
    passwordHash,
    role,
    status,
    mustChangePassword: false,
    failedLoginCount: 0,
    lockedUntil: null,
    createdAt,
    updatedAt: createdAt,
  };
  prisma.users.set(id, user);
  return user;
}

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
  return fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      origin,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(csrfData ? { 'x-csrf-token': csrfData.token } : {}),
      ...(cookies.length ? { cookie: cookies.join('; ') } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function login(baseUrl, email) {
  const response = await request(baseUrl, '/api/auth/login', {
    method: 'POST',
    body: { email, password: PASSWORD },
  });
  const token = response.headers.getSetCookie()
    .map((header) => header.match(/(?:^|;\s*)bv_session=([^;]+)/u)?.[1])
    .find(Boolean);
  return {
    response,
    cookie: token ? `bv_session=${decodeURIComponent(token)}` : null,
  };
}

async function adminSession(baseUrl, prisma, options = {}) {
  const user = addUser(prisma, {
    role: 'ADMIN',
    passwordHash: await hashPassword(PASSWORD),
    ...options,
  });
  const session = await login(baseUrl, user.email);
  assert.equal(session.response.status, 200);
  return { ...session, user };
}

async function customerSession(baseUrl) {
  const email = `${randomUUID()}@example.test`;
  const csrf = await fetchCsrf(baseUrl);
  const response = await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: {
      origin: TEST_ORIGIN,
      'content-type': 'application/json',
      'x-csrf-token': csrf.token,
      cookie: `bv_csrf=${csrf.csrfCookie}`,
    },
    body: JSON.stringify({ email, fullName: 'Synthetic Customer', password: PASSWORD }),
  });
  assert.equal(response.status, 201);
  const session = await login(baseUrl, email);
  assert.equal(session.response.status, 200);
  return session;
}

test('admin user list is authenticated, role-gated, paginated, and returns safe fields', async () => {
  await withAuthServer(async ({ baseUrl, prisma }) => {
    const admin = await adminSession(baseUrl, prisma);
    for (let index = 0; index < 3; index += 1) {
      addUser(prisma, {
        email: `listed-${index}@example.test`,
        createdAt: new Date(Date.now() + index),
      });
    }

    const anonymous = await request(baseUrl, '/api/admin/users');
    const customer = await customerSession(baseUrl);
    const denied = await request(baseUrl, '/api/admin/users', { cookie: customer.cookie });
    const listed = await request(baseUrl, '/api/admin/users?limit=2&page=1', {
      cookie: admin.cookie,
    });
    const body = await listed.json();

    assert.equal(anonymous.status, 401);
    assert.equal(denied.status, 403);
    assert.equal(listed.status, 200);
    assert.equal(body.pagination.total, 5);
    assert.equal(body.users.length, 2);
    assert.equal(Object.hasOwn(body.users[0], 'passwordHash'), false);
    assert.equal(Object.hasOwn(body.users[0], 'failedLoginCount'), false);
    assert.ok(prisma.auditRows.some((row) => (
      row.action === 'admin.users.read' && row.outcome === 'DENIED' && row.actorId === null
    )));
    assert.ok(prisma.auditRows.some((row) => (
      row.action === 'admin.users.read'
      && row.outcome === 'DENIED'
      && row.metadata?.reasonCode === 'FORBIDDEN'
    )));
  });
});

test('admin can read user details but invalid and missing IDs are rejected safely', async () => {
  await withAuthServer(async ({ baseUrl, prisma }) => {
    const admin = await adminSession(baseUrl, prisma);
    const target = addUser(prisma, { email: 'detail@example.test' });
    const details = await request(baseUrl, `/api/admin/users/${target.id}`, {
      cookie: admin.cookie,
    });
    const body = await details.json();
    const invalid = await request(baseUrl, '/api/admin/users/not-a-uuid', {
      cookie: admin.cookie,
    });
    const missing = await request(baseUrl, `/api/admin/users/${randomUUID()}`, {
      cookie: admin.cookie,
    });

    assert.equal(details.status, 200);
    assert.equal(body.user.id, target.id);
    assert.equal(Object.hasOwn(body.user, 'passwordHash'), false);
    assert.equal(invalid.status, 400);
    assert.equal(missing.status, 404);
  });
});

test('customers cannot read another user or attempt to change their status', async () => {
  await withAuthServer(async ({ baseUrl, prisma }) => {
    const customer = await customerSession(baseUrl);
    const target = addUser(prisma, { email: 'id-or-target@example.test' });
    const details = await request(baseUrl, `/api/admin/users/${target.id}`, {
      cookie: customer.cookie,
    });
    const statusChange = await request(baseUrl, `/api/admin/users/${target.id}/status`, {
      method: 'PATCH',
      cookie: customer.cookie,
      body: { status: 'DISABLED' },
    });

    assert.equal(details.status, 403);
    assert.equal(statusChange.status, 403);
    assert.equal(prisma.users.get(target.id).status, 'ACTIVE');
    assert.equal(prisma.users.get(target.id).role, 'ACCOUNT_HOLDER');
    assert.ok(prisma.auditRows.some((row) => (
      row.action === 'admin.user.status.change'
      && row.outcome === 'DENIED'
      && row.metadata?.reasonCode === 'FORBIDDEN'
    )));
  });
});

test('admin services independently reject non-admin callers', async () => {
  const prisma = new FakePrisma();
  const customer = addUser(prisma);

  await assert.rejects(
    listAdminUsers(prisma, customer, { page: 1, limit: 20 }),
    (error) => error.status === 403 && error.code === 'FORBIDDEN',
  );
  await assert.rejects(
    changeUserStatus(prisma, customer, customer.id, 'DISABLED', {
      requestId: randomUUID(),
      ipAddress: null,
    }),
    (error) => error.status === 403 && error.code === 'FORBIDDEN',
  );
  assert.equal(customer.status, 'ACTIVE');
});

test('status changes reject mass assignment and never change a user role', async () => {
  await withAuthServer(async ({ baseUrl, prisma }) => {
    const admin = await adminSession(baseUrl, prisma);
    const customer = addUser(prisma, { email: 'role-protected@example.test' });
    const response = await request(baseUrl, `/api/admin/users/${customer.id}/status`, {
      method: 'PATCH',
      cookie: admin.cookie,
      body: { status: 'DISABLED', role: 'ADMIN' },
    });
    const invalidStatus = await request(baseUrl, `/api/admin/users/${customer.id}/status`, {
      method: 'PATCH',
      cookie: admin.cookie,
      body: { status: 'PENDING' },
    });

    assert.equal(response.status, 400);
    assert.equal(invalidStatus.status, 400);
    assert.equal(prisma.users.get(customer.id).role, 'ACCOUNT_HOLDER');
    assert.equal(prisma.users.get(customer.id).status, 'ACTIVE');
  });
});

test('disable revokes sessions immediately, prevents login, and enable permits a fresh login', async () => {
  await withAuthServer(async ({ baseUrl, prisma }) => {
    const admin = await adminSession(baseUrl, prisma);
    const customer = addUser(prisma, {
      email: 'disable-and-enable@example.test',
      passwordHash: await hashPassword(PASSWORD),
    });
    const customerLogin = await login(baseUrl, customer.email);
    assert.equal(customerLogin.response.status, 200);

    const disabled = await request(baseUrl, `/api/admin/users/${customer.id}/status`, {
      method: 'PATCH',
      cookie: admin.cookie,
      body: { status: 'DISABLED' },
    });
    const disabledBody = await disabled.json();
    const revokedImmediately = [...prisma.sessions.values()]
      .filter((session) => session.userId === customer.id)
      .every((session) => session.revokedAt);
    const oldSession = await request(baseUrl, '/api/auth/me', { cookie: customerLogin.cookie });
    const disabledLogin = await login(baseUrl, customer.email);
    const reenabled = await request(baseUrl, `/api/admin/users/${customer.id}/status`, {
      method: 'PATCH',
      cookie: admin.cookie,
      body: { status: 'ACTIVE' },
    });
    const oldSessionAfterEnable = await request(baseUrl, '/api/auth/me', {
      cookie: customerLogin.cookie,
    });
    const newLogin = await login(baseUrl, customer.email);

    assert.equal(disabled.status, 200);
    assert.equal(disabledBody.user.status, 'DISABLED');
    assert.equal(revokedImmediately, true);
    assert.equal(oldSession.status, 401);
    assert.equal(disabledLogin.response.status, 401);
    assert.equal(reenabled.status, 200);
    assert.equal(oldSessionAfterEnable.status, 401);
    assert.equal(newLogin.response.status, 200);
    assert.ok(prisma.auditRows.some((row) => (
      row.action === 'admin.user.status.change'
      && row.targetId === customer.id
      && row.outcome === 'SUCCESS'
    )));
  });
});

test('self-disable and last-active-admin protections are audited', async () => {
  await withAuthServer(async ({ baseUrl, prisma }) => {
    const soloAdmin = await adminSession(baseUrl, prisma);
    const lastAdminResponse = await request(
      baseUrl,
      `/api/admin/users/${soloAdmin.user.id}/status`,
      { method: 'PATCH', cookie: soloAdmin.cookie, body: { status: 'DISABLED' } },
    );
    assert.equal(lastAdminResponse.status, 409);
    assert.equal((await lastAdminResponse.json()).error.code, 'LAST_ACTIVE_ADMIN');
    assert.equal(soloAdmin.user.status, 'ACTIVE');
    assert.ok(prisma.auditRows.some((row) => (
      row.action === 'admin.user.status.change'
      && row.targetId === soloAdmin.user.id
      && row.metadata?.reasonCode === 'LAST_ACTIVE_ADMIN'
    )));

    const otherAdmin = await adminSession(baseUrl, prisma);
    const selfDisable = await request(
      baseUrl,
      `/api/admin/users/${otherAdmin.user.id}/status`,
      { method: 'PATCH', cookie: otherAdmin.cookie, body: { status: 'DISABLED' } },
    );
    assert.equal(selfDisable.status, 409);
    assert.equal((await selfDisable.json()).error.code, 'SELF_DISABLE_DENIED');
    assert.equal(otherAdmin.user.status, 'ACTIVE');
    assert.ok(prisma.auditRows.some((row) => (
      row.action === 'admin.user.status.change'
      && row.targetId === otherAdmin.user.id
      && row.metadata?.reasonCode === 'SELF_DISABLE'
    )));
  });
});

test('concurrent admin status changes cannot disable every active administrator', async () => {
  await withAuthServer(async ({ baseUrl, prisma }) => {
    const first = await adminSession(baseUrl, prisma);
    const second = await adminSession(baseUrl, prisma);
    const results = await Promise.all([
      request(baseUrl, `/api/admin/users/${second.user.id}/status`, {
        method: 'PATCH',
        cookie: first.cookie,
        body: { status: 'DISABLED' },
      }),
      request(baseUrl, `/api/admin/users/${first.user.id}/status`, {
        method: 'PATCH',
        cookie: second.cookie,
        body: { status: 'DISABLED' },
      }),
    ]);
    const activeAdmins = [...prisma.users.values()].filter(
      (user) => user.role === 'ADMIN' && user.status === 'ACTIVE',
    );

    assert.ok(results.some((response) => response.status !== 200));
    assert.ok(activeAdmins.length >= 1);
  });
});

test('admin-only audit viewer paginates safely and denies customer access', async () => {
  await withAuthServer(async ({ baseUrl, prisma }) => {
    const admin = await adminSession(baseUrl, prisma);
    const customer = await customerSession(baseUrl);
    for (let index = 1; index <= 3; index += 1) {
      prisma.auditRows.push({
        id: BigInt(100 + index),
        actorId: admin.user.id,
        action: 'synthetic.audit.event',
        targetType: 'User',
        targetId: randomUUID(),
        outcome: 'SUCCESS',
        metadata: { reasonCode: `TEST_${index}` },
        requestId: `request-${index}`,
        ipAddress: '192.0.2.1',
        createdAt: new Date(Date.now() + index),
      });
    }

    const denied = await request(baseUrl, '/api/admin/audit', { cookie: customer.cookie });
    const listed = await request(
      baseUrl,
      '/api/admin/audit?action=synthetic.audit.event&limit=2&page=1',
      { cookie: admin.cookie },
    );
    const body = await listed.json();

    assert.equal(denied.status, 403);
    assert.equal(listed.status, 200);
    assert.equal(body.pagination.total, 3);
    assert.equal(body.auditLogs.length, 2);
    assert.equal(typeof body.auditLogs[0].id, 'string');
    assert.equal(Object.hasOwn(body.auditLogs[0], 'ipAddress'), false);
    assert.equal(Object.hasOwn(body.auditLogs[0], 'requestId'), false);
    assert.ok(prisma.auditRows.some((row) => (
      row.action === 'admin.audit.read' && row.actorId === admin.user.id
    )));
    assert.ok(prisma.auditRows.some((row) => (
      row.action === 'admin.audit.read'
      && row.outcome === 'DENIED'
      && row.metadata?.reasonCode === 'FORBIDDEN'
    )));
  });
});

test('status changes require Origin and CSRF validation', async () => {
  await withAuthServer(async ({ baseUrl, prisma }) => {
    const admin = await adminSession(baseUrl, prisma);
    const customer = addUser(prisma, { email: 'csrf-target@example.test' });
    const withoutCsrf = await request(baseUrl, `/api/admin/users/${customer.id}/status`, {
      method: 'PATCH',
      cookie: admin.cookie,
      csrf: false,
      body: { status: 'DISABLED' },
    });
    const badOrigin = await request(baseUrl, `/api/admin/users/${customer.id}/status`, {
      method: 'PATCH',
      cookie: admin.cookie,
      origin: 'https://attacker.example.test',
      body: { status: 'DISABLED' },
    });

    assert.equal(withoutCsrf.status, 403);
    assert.equal(badOrigin.status, 403);
    assert.equal(prisma.users.get(customer.id).status, 'ACTIVE');
  });
});

test('status change and audit write roll back together when audit storage fails', async () => {
  await withAuthServer(async ({ baseUrl, prisma }) => {
    const admin = await adminSession(baseUrl, prisma);
    const customer = addUser(prisma, {
      email: 'audit-rollback@example.test',
      passwordHash: await hashPassword(PASSWORD),
    });
    const session = await login(baseUrl, customer.email);
    prisma.failAudit = true;

    const response = await request(baseUrl, `/api/admin/users/${customer.id}/status`, {
      method: 'PATCH',
      cookie: admin.cookie,
      body: { status: 'DISABLED' },
    });

    assert.equal(response.status, 500);
    assert.equal(prisma.users.get(customer.id).status, 'ACTIVE');
    assert.ok([...prisma.sessions.values()]
      .filter((row) => row.userId === customer.id)
      .every((row) => row.revokedAt === null));
    assert.ok(session.cookie);
  });
});

test('user and audit query validators reject unknown fields and excessive page sizes', async () => {
  await withAuthServer(async ({ baseUrl, prisma }) => {
    const admin = await adminSession(baseUrl, prisma);
    const badUserQuery = await request(baseUrl, '/api/admin/users?role=ROOT&extra=yes', {
      cookie: admin.cookie,
    });
    const badAuditQuery = await request(baseUrl, '/api/admin/audit?limit=101', {
      cookie: admin.cookie,
    });

    assert.equal(badUserQuery.status, 400);
    assert.equal(badAuditQuery.status, 400);
  });
});
