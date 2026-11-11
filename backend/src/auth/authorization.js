import { AppError } from '../middleware/error-handler.js';

const ROLES = Object.freeze({
  ACCOUNT_HOLDER: 'ACCOUNT_HOLDER',
  ADMIN: 'ADMIN',
});

const ACCOUNT_AND_ADMIN = Object.freeze([ROLES.ACCOUNT_HOLDER, ROLES.ADMIN]);
const ACCOUNT_HOLDER_ONLY = Object.freeze([ROLES.ACCOUNT_HOLDER]);
const ADMIN_ONLY = Object.freeze([ROLES.ADMIN]);

const PERMISSION_ROLES = Object.freeze({
  PROFILE_READ: ACCOUNT_AND_ADMIN,
  SESSION_END: ACCOUNT_AND_ADMIN,
  CUSTOMER_ACCOUNT_READ: ACCOUNT_HOLDER_ONLY,
  CUSTOMER_TRANSACTION_READ: ACCOUNT_HOLDER_ONLY,
  CUSTOMER_TRANSFER_CREATE: ACCOUNT_HOLDER_ONLY,
  CUSTOMER_ONBOARDING_SUBMIT: ACCOUNT_HOLDER_ONLY,
  CUSTOMER_ONBOARDING_READ: ACCOUNT_HOLDER_ONLY,
  ADMIN_USERS_READ: ADMIN_ONLY,
  ADMIN_ACCOUNT_READ: ADMIN_ONLY,
  ADMIN_ACCOUNT_STATUS_MANAGE: ADMIN_ONLY,
  ADMIN_FUNDING_CREATE: ADMIN_ONLY,
  ADMIN_LEDGER_VERIFY: ADMIN_ONLY,
  ADMIN_ONBOARDING_READ: ADMIN_ONLY,
  ADMIN_ONBOARDING_REVIEW: ADMIN_ONLY,
  ADMIN_USER_ACCESS_MANAGE: ADMIN_ONLY,
  ADMIN_AUDIT_READ: ADMIN_ONLY,
});

const CUSTOMER_RESOURCES = Object.freeze({
  accounts: {
    permission: 'CUSTOMER_ACCOUNT_READ',
    where: (userId) => ({ ownerId: userId }),
  },
  transactions: {
    permission: 'CUSTOMER_TRANSACTION_READ',
    where: (userId) => ({
      entries: {
        some: {
          account: { ownerId: userId },
        },
      },
    }),
  },
  onboarding: {
    permission: 'CUSTOMER_ONBOARDING_READ',
    where: (userId) => ({ userId }),
  },
});

function assertRole(actor, allowedRoles) {
  if (!actor || typeof actor.id !== 'string' || actor.id.length === 0) {
    throw new AppError(401, 'AUTH_REQUIRED', 'Authentication is required.');
  }
  if (!allowedRoles.includes(actor.role)) {
    throw new AppError(403, 'FORBIDDEN', 'You are not allowed to perform this action.');
  }
}

function assertPermission(actor, permission) {
  const allowedRoles = PERMISSION_ROLES[permission];
  if (!allowedRoles) {
    throw new TypeError(`Unknown permission: ${permission}`);
  }
  assertRole(actor, allowedRoles);
}

function customerResourceWhere(actor, resource) {
  const policy = CUSTOMER_RESOURCES[resource];
  if (!policy) {
    throw new TypeError(`Unknown customer resource: ${resource}`);
  }
  assertPermission(actor, policy.permission);
  return policy.where(actor.id);
}

function assertOwnsResource(actor, resource, ownerId) {
  const policy = CUSTOMER_RESOURCES[resource];
  if (!policy) {
    throw new TypeError(`Unknown customer resource: ${resource}`);
  }
  assertPermission(actor, policy.permission);
  if (ownerId !== actor.id) {
    throw new AppError(404, 'RESOURCE_NOT_FOUND', 'The requested resource was not found.');
  }
}

export {
  PERMISSION_ROLES,
  CUSTOMER_RESOURCES,
  ROLES,
  assertOwnsResource,
  assertPermission,
  assertRole,
  customerResourceWhere,
};
