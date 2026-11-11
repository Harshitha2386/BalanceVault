import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertOwnsResource,
  assertPermission,
  customerResourceWhere,
} from '../src/auth/authorization.js';
import { requirePermission, requireRole } from '../src/middleware/authorization.js';
import { logoutSession } from '../src/services/auth-service.js';

const customer = { id: 'customer-1', role: 'ACCOUNT_HOLDER' };
const admin = { id: 'admin-1', role: 'ADMIN' };

function runMiddleware(middleware, user) {
  return new Promise((resolve) => {
    middleware({ auth: user ? { user } : undefined }, {}, (error) => resolve(error || null));
  });
}

test('role middleware returns 401 when authentication did not run', async () => {
  const error = await runMiddleware(requireRole('ADMIN'), null);
  assert.equal(error.status, 401);
  assert.equal(error.code, 'AUTH_REQUIRED');

  const missingIdentity = await runMiddleware(requireRole('ADMIN'), { role: 'ADMIN' });
  assert.equal(missingIdentity.status, 401);
});

test('role middleware allows only the configured database role', async () => {
  assert.equal(await runMiddleware(requireRole('ACCOUNT_HOLDER'), customer), null);

  const error = await runMiddleware(requireRole('ADMIN'), customer);
  assert.equal(error.status, 403);
  assert.equal(error.code, 'FORBIDDEN');
});

test('role middleware rejects invalid role configuration', () => {
  assert.throws(() => requireRole(), TypeError);
  assert.throws(() => requireRole('SUPERUSER'), TypeError);
});

test('admin permission allows an admin but denies a customer', async () => {
  const middleware = requirePermission('ADMIN_USERS_READ');
  assert.equal(await runMiddleware(middleware, admin), null);

  const error = await runMiddleware(middleware, customer);
  assert.equal(error.status, 403);
});

test('customer cannot approve onboarding applications', async () => {
  const error = await runMiddleware(
    requirePermission('ADMIN_ONBOARDING_REVIEW'),
    customer,
  );
  assert.equal(error.status, 403);
});

test('permission middleware rejects unknown permissions by default', () => {
  assert.throws(() => requirePermission('UNKNOWN_PERMISSION'), TypeError);
  assert.throws(() => assertPermission(admin, 'UNKNOWN_PERMISSION'), TypeError);
});

test('customer resource filters scope accounts to the authenticated owner', () => {
  assert.deepEqual(customerResourceWhere(customer, 'accounts'), {
    ownerId: customer.id,
  });
  assert.deepEqual(customerResourceWhere(customer, 'onboarding'), {
    userId: customer.id,
  });
  assert.deepEqual(customerResourceWhere(customer, 'transactions'), {
    entries: {
      some: {
        account: { ownerId: customer.id },
      },
    },
  });
});

test('ownership policy hides another customer resource with 404', () => {
  assert.equal(assertOwnsResource(customer, 'accounts', customer.id), undefined);
  assert.throws(
    () => assertOwnsResource(customer, 'accounts', 'another-customer'),
    (error) => error.status === 404 && error.code === 'RESOURCE_NOT_FOUND',
  );
});

test('customer policies deny admin and unknown resource access by default', () => {
  assert.throws(
    () => customerResourceWhere(admin, 'accounts'),
    (error) => error.status === 403,
  );
  assert.throws(() => customerResourceWhere(customer, 'system'), TypeError);
});

test('logout service independently checks permission and session ownership', async () => {
  await assert.rejects(
    logoutSession(
      {},
      { id: 'session-1', userId: 'another-customer' },
      customer,
      {},
    ),
    (error) => error.status === 404,
  );
  await assert.rejects(
    logoutSession(
      {},
      { id: 'session-1', userId: customer.id },
      { ...customer, role: 'UNRECOGNIZED' },
      {},
    ),
    (error) => error.status === 403,
  );
});
