import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { hashPassword } from '../src/auth/password.js';
import {
  TEST_ORIGIN,
  fetchCsrf,
  withAuthServer,
} from './helpers/auth-test-app.js';

const PASSWORD = 'Synthetic-Onboarding-Password-948!';
const APPLICATION = {
  legalName: 'Synthetic Applicant',
  dateOfBirth: '1999-02-14',
  phone: '+1 (555) 010-2040',
  addressLine: '100 Example Street',
  city: 'Example City',
  country: 'us',
};

async function postJson(baseUrl, path, body, {
  cookies = [],
  origin = TEST_ORIGIN,
  csrf = true,
  method = 'POST',
} = {}) {
  const csrfResponse = csrf ? await fetchCsrf(baseUrl, cookies) : null;
  const providedCookies = cookies.filter(Boolean);
  const headers = {
    origin,
    'content-type': 'application/json',
    ...(csrfResponse ? { 'x-csrf-token': csrfResponse.token } : {}),
    ...(providedCookies.length ? { cookie: providedCookies.join('; ') } : {}),
  };
  if (csrfResponse?.csrfCookie) {
    headers.cookie = [...providedCookies, `bv_csrf=${csrfResponse.csrfCookie}`].join('; ');
  }
  return fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: JSON.stringify(body),
  });
}

async function registerCustomer(baseUrl, email = 'applicant@example.test') {
  const response = await postJson(baseUrl, '/api/auth/register', {
    email,
    fullName: 'Synthetic Applicant',
    password: PASSWORD,
  });
  assert.equal(response.status, 201);
  return response.json();
}

async function login(baseUrl, email, cookies = []) {
  const response = await postJson(baseUrl, '/api/auth/login', {
    email,
    password: PASSWORD,
  }, { cookies });
  assert.equal(response.status, 200);
  const headers = response.headers.getSetCookie();
  const value = headers.map((header) => header.match(/(?:^|;\s*)bv_session=([^;]+)/u)?.[1])
    .find(Boolean);
  assert.ok(value);
  return { cookie: `bv_session=${decodeURIComponent(value)}`, body: await response.json() };
}

async function createCustomerSession(baseUrl, email) {
  await registerCustomer(baseUrl, email);
  return login(baseUrl, email);
}

async function createAdminSession(baseUrl, prisma) {
  const id = randomUUID();
  prisma.users.set(id, {
    id,
    email: 'admin@example.test',
    fullName: 'Synthetic Administrator',
    passwordHash: await hashPassword(PASSWORD),
    role: 'ADMIN',
    status: 'ACTIVE',
    mustChangePassword: false,
    failedLoginCount: 0,
    lockedUntil: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return login(baseUrl, 'admin@example.test');
}

async function submit(baseUrl, sessionCookie, body = APPLICATION, options = {}) {
  return postJson(baseUrl, '/api/onboarding/applications', body, {
    cookies: [sessionCookie],
    ...options,
  });
}

async function decide(baseUrl, sessionCookie, id, body, options = {}) {
  return postJson(baseUrl, `/api/admin/onboarding/applications/${id}/decision`, body, {
    cookies: [sessionCookie],
    method: 'PATCH',
    ...options,
  });
}

test('authenticated customer submits a pending application with server-owned fields', async () => {
  await withAuthServer(async ({ baseUrl, prisma }) => {
    const customer = await createCustomerSession(baseUrl, 'first@example.test');
    const response = await submit(baseUrl, customer.cookie);
    const body = await response.json();
    const stored = [...prisma.applications.values()][0];

    assert.equal(response.status, 201);
    assert.equal(body.application.status, 'PENDING');
    assert.equal(body.application.country, 'US');
    assert.equal(stored.userId, customer.body.user.id);
    assert.equal(stored.status, 'PENDING');
    assert.equal(stored.reviewedById, null);
  });
});

test('unauthenticated onboarding submission returns 401', async () => {
  await withAuthServer(async ({ baseUrl }) => {
    const response = await submit(baseUrl, null, APPLICATION, { csrf: false });
    assert.equal(response.status, 401);
  });
});

test('submission rejects invalid fields and unknown privileged fields', async () => {
  await withAuthServer(async ({ baseUrl, prisma }) => {
    const customer = await createCustomerSession(baseUrl, 'validation@example.test');
    const invalid = await submit(baseUrl, customer.cookie, {
      ...APPLICATION,
      dateOfBirth: '2021-02-30',
    });
    const massAssigned = await submit(baseUrl, customer.cookie, {
      ...APPLICATION,
      userId: '00000000-0000-4000-8000-000000000001',
      status: 'APPROVED',
      reviewedById: '00000000-0000-4000-8000-000000000002',
      reviewedAt: '2026-01-01T00:00:00.000Z',
    });

    assert.equal(invalid.status, 400);
    assert.equal(massAssigned.status, 400);
    assert.equal(prisma.applications.size, 0);
  });
});

test('duplicate active application is rejected and audited', async () => {
  await withAuthServer(async ({ baseUrl, prisma }) => {
    const customer = await createCustomerSession(baseUrl, 'duplicate@example.test');
    assert.equal((await submit(baseUrl, customer.cookie)).status, 201);

    const duplicate = await submit(baseUrl, customer.cookie);
    const body = await duplicate.json();
    assert.equal(duplicate.status, 409);
    assert.equal(body.error.code, 'ACTIVE_APPLICATION_EXISTS');
    assert.equal(prisma.applications.size, 1);
    assert.ok(prisma.auditRows.some((row) => (
      row.action === 'onboarding.application.submit'
      && row.outcome === 'DENIED'
      && row.metadata?.reasonCode === 'ACTIVE_APPLICATION_EXISTS'
    )));
  });
});

test('customer status endpoint returns only the current user applications', async () => {
  await withAuthServer(async ({ baseUrl }) => {
    const first = await createCustomerSession(baseUrl, 'owner@example.test');
    const second = await createCustomerSession(baseUrl, 'other@example.test');
    const firstSubmit = await submit(baseUrl, first.cookie);
    const secondSubmit = await submit(baseUrl, second.cookie);
    const firstId = (await firstSubmit.json()).application.id;
    const secondId = (await secondSubmit.json()).application.id;

    const own = await fetch(`${baseUrl}/api/onboarding/applications/me`, {
      headers: { cookie: first.cookie },
    });
    const body = await own.json();
    assert.equal(own.status, 200);
    assert.equal(own.headers.get('cache-control'), 'no-store');
    assert.deepEqual(body.applications.map((application) => application.id), [firstId]);
    assert.notEqual(body.applications[0].id, secondId);
  });
});

test('customer is denied access to admin listing and decision endpoints', async () => {
  await withAuthServer(async ({ baseUrl }) => {
    const customer = await createCustomerSession(baseUrl, 'customer@example.test');
    const list = await fetch(`${baseUrl}/api/admin/onboarding/applications`, {
      headers: { cookie: customer.cookie },
    });
    const decision = await decide(baseUrl, customer.cookie,
      '00000000-0000-4000-8000-000000000001', { decision: 'APPROVED' });

    assert.equal(list.status, 403);
    assert.equal(decision.status, 403);
  });
});

test('admin can filter and paginate applications and view selected applicant details', async () => {
  await withAuthServer(async ({ baseUrl, prisma }) => {
    const customer = await createCustomerSession(baseUrl, 'listed@example.test');
    const submitted = await submit(baseUrl, customer.cookie);
    const id = (await submitted.json()).application.id;
    const admin = await createAdminSession(baseUrl, prisma);

    const list = await fetch(
      `${baseUrl}/api/admin/onboarding/applications?status=PENDING&page=1&limit=1`,
      { headers: { cookie: admin.cookie } },
    );
    const listed = await list.json();
    assert.equal(list.status, 200);
    assert.equal(list.headers.get('cache-control'), 'no-store');
    assert.equal(listed.applications.length, 1);
    assert.equal(listed.applications[0].id, id);
    assert.equal(listed.pagination.total, 1);
    assert.equal(listed.applications[0].user.email, 'listed@example.test');
    assert.equal(Object.hasOwn(listed.applications[0].user, 'passwordHash'), false);

    const detail = await fetch(`${baseUrl}/api/admin/onboarding/applications/${id}`, {
      headers: { cookie: admin.cookie },
    });
    const details = await detail.json();
    assert.equal(detail.status, 200);
    assert.equal(details.application.id, id);
    assert.equal(details.application.user.id, customer.body.user.id);
    assert.equal(Object.hasOwn(details.application.user, 'passwordHash'), false);
  });
});

test('admin can approve or reject pending applications and audit each decision', async () => {
  await withAuthServer(async ({ baseUrl, prisma }) => {
    const firstCustomer = await createCustomerSession(baseUrl, 'approve@example.test');
    const secondCustomer = await createCustomerSession(baseUrl, 'reject@example.test');
    const approvedResponse = await submit(baseUrl, firstCustomer.cookie);
    const rejectedResponse = await submit(baseUrl, secondCustomer.cookie);
    const approvedId = (await approvedResponse.json()).application.id;
    const rejectedId = (await rejectedResponse.json()).application.id;
    const admin = await createAdminSession(baseUrl, prisma);

    const approval = await decide(baseUrl, admin.cookie, approvedId, {
      decision: 'APPROVED',
      reviewNote: 'Synthetic review accepted.',
    });
    const rejection = await decide(baseUrl, admin.cookie, rejectedId, {
      decision: 'REJECTED',
      reviewNote: 'Synthetic review requires correction.',
    });
    const approved = await approval.json();
    const rejected = await rejection.json();

    assert.equal(approval.status, 200);
    assert.equal(rejection.status, 200);
    assert.equal(approved.application.status, 'APPROVED');
    assert.equal(rejected.application.status, 'REJECTED');
    assert.equal(approved.account.kind, 'CUSTOMER');
    assert.equal(approved.account.status, 'ACTIVE');
    assert.equal(approved.account.currency, 'INR');
    assert.equal(approved.account.balanceMinor, '0');
    assert.equal(rejected.account, null);
    assert.equal(approved.application.reviewedById, admin.body.user.id);
    assert.equal(approved.application.reviewNote, 'Synthetic review accepted.');
    assert.ok(approved.application.reviewedAt);
    assert.ok(prisma.auditRows.some((row) => (
      row.action === 'onboarding.application.approve'
      && row.actorId === admin.body.user.id
      && row.targetId === approvedId
      && row.targetType === 'OnboardingApplication'
    )));
    assert.ok(prisma.auditRows.some((row) => (
      row.action === 'account.provision'
      && row.actorId === admin.body.user.id
      && row.targetType === 'Account'
    )));
    assert.ok(prisma.auditRows.some((row) => (
      row.action === 'onboarding.application.reject'
      && row.actorId === admin.body.user.id
      && row.targetId === rejectedId
    )));
    assert.equal(prisma.auditRows.some((row) => (
      JSON.stringify({ ...row, id: String(row.id) }).includes(PASSWORD)
    )), false);
  });
});

test('customer cannot submit an admin decision and decision input is strict', async () => {
  await withAuthServer(async ({ baseUrl, prisma }) => {
    const customer = await createCustomerSession(baseUrl, 'decision-fields@example.test');
    const applicationResponse = await submit(baseUrl, customer.cookie);
    const id = (await applicationResponse.json()).application.id;
    const admin = await createAdminSession(baseUrl, prisma);

    const forged = await decide(baseUrl, admin.cookie, id, {
      decision: 'APPROVED',
      reviewedById: customer.body.user.id,
      reviewedAt: '2026-01-01T00:00:00.000Z',
      status: 'REJECTED',
    });
    assert.equal(forged.status, 400);

    const customerDecision = await decide(baseUrl, customer.cookie, id, {
      decision: 'APPROVED',
    });
    assert.equal(customerDecision.status, 403);
    assert.equal(prisma.applications.get(id).status, 'PENDING');
  });
});

test('already-decided applications reject repeated decisions with 409', async () => {
  await withAuthServer(async ({ baseUrl, prisma }) => {
    const customer = await createCustomerSession(baseUrl, 'repeat@example.test');
    const applicationResponse = await submit(baseUrl, customer.cookie);
    const id = (await applicationResponse.json()).application.id;
    const admin = await createAdminSession(baseUrl, prisma);

    assert.equal((await decide(baseUrl, admin.cookie, id, {
      decision: 'APPROVED',
    })).status, 200);
    const repeated = await decide(baseUrl, admin.cookie, id, { decision: 'REJECTED' });
    const body = await repeated.json();
    assert.equal(repeated.status, 409);
    assert.equal(body.error.code, 'APPLICATION_ALREADY_DECIDED');
  });
});

test('concurrent decisions allow exactly one state transition', async () => {
  await withAuthServer(async ({ baseUrl, prisma }) => {
    const customer = await createCustomerSession(baseUrl, 'race@example.test');
    const applicationResponse = await submit(baseUrl, customer.cookie);
    const id = (await applicationResponse.json()).application.id;
    const admin = await createAdminSession(baseUrl, prisma);

    const [approve, reject] = await Promise.all([
      decide(baseUrl, admin.cookie, id, { decision: 'APPROVED' }),
      decide(baseUrl, admin.cookie, id, { decision: 'REJECTED' }),
    ]);
    const statuses = [approve.status, reject.status].sort();
    assert.deepEqual(statuses, [200, 409]);
    assert.ok(['APPROVED', 'REJECTED'].includes(prisma.applications.get(id).status));
  });
});

test('invalid IDs, CSRF failures, and disallowed Origins are rejected safely', async () => {
  await withAuthServer(async ({ baseUrl, prisma }) => {
    const customer = await createCustomerSession(baseUrl, 'edge@example.test');
    const admin = await createAdminSession(baseUrl, prisma);
    const applicationResponse = await submit(baseUrl, customer.cookie);
    const applicationId = (await applicationResponse.json()).application.id;
    const invalidId = await fetch(`${baseUrl}/api/admin/onboarding/applications/not-a-uuid`, {
      headers: { cookie: admin.cookie },
    });
    assert.equal(invalidId.status, 400);

    const noCsrf = await submit(baseUrl, customer.cookie, APPLICATION, { csrf: false });
    assert.equal(noCsrf.status, 403);

    const badOrigin = await submit(baseUrl, customer.cookie, APPLICATION, {
      origin: 'https://attacker.example.test',
    });
    assert.equal(badOrigin.status, 403);

    const noAdminCsrf = await decide(baseUrl, admin.cookie, applicationId, {
      decision: 'APPROVED',
    }, { csrf: false });
    const badAdminOrigin = await decide(baseUrl, admin.cookie, applicationId, {
      decision: 'APPROVED',
    }, { origin: 'https://attacker.example.test' });
    assert.equal(noAdminCsrf.status, 403);
    assert.equal(badAdminOrigin.status, 403);
  });
});

test('invalid pagination and filters are rejected', async () => {
  await withAuthServer(async ({ baseUrl, prisma }) => {
    const admin = await createAdminSession(baseUrl, prisma);
    const response = await fetch(
      `${baseUrl}/api/admin/onboarding/applications?status=UNKNOWN&limit=1000`,
      { headers: { cookie: admin.cookie } },
    );
    assert.equal(response.status, 400);
  });
});
