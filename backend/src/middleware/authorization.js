import {
  PERMISSION_ROLES,
  ROLES,
  assertPermission,
  assertRole,
} from '../auth/authorization.js';
import { recordAudit } from '../services/audit-service.js';
import { resolveSession } from '../services/session-service.js';

function requireRole(...allowedRoles) {
  if (
    allowedRoles.length === 0
    || allowedRoles.some((role) => !Object.values(ROLES).includes(role))
  ) {
    throw new TypeError('requireRole needs one or more valid database roles.');
  }

  return function roleAuthorization(req, res, next) {
    try {
      assertRole(req.auth?.user, allowedRoles);
      return next();
    } catch (error) {
      return next(error);
    }
  };
}

function requirePermission(permission) {
  if (!Object.hasOwn(PERMISSION_ROLES, permission)) {
    throw new TypeError(`Unknown permission: ${permission}`);
  }

  return function permissionAuthorization(req, res, next) {
    try {
      assertPermission(req.auth?.user, permission);
      return next();
    } catch (error) {
      return next(error);
    }
  };
}

function requirePermissionWithAudit({
  prisma,
  permission,
  action,
  targetType,
}) {
  if (!prisma || !action || !targetType || !Object.hasOwn(PERMISSION_ROLES, permission)) {
    throw new TypeError('Audited permission middleware requires a client, permission, action, and target type.');
  }

  return async function auditedPermissionAuthorization(req, res, next) {
    try {
      assertPermission(req.auth?.user, permission);
      return next();
    } catch (error) {
      await recordAudit(prisma, {
        actorId: req.auth?.user?.id ?? null,
        action,
        outcome: 'DENIED',
        requestId: req.requestId,
        ipAddress: typeof req.ip === 'string' ? req.ip.slice(0, 64) : null,
        targetType,
        metadata: { reasonCode: error.code || 'FORBIDDEN' },
      });
      return next(error);
    }
  };
}

function auditUnauthenticatedAttempt(prisma, { action, targetType }) {
  if (!prisma || !action || !targetType) {
    throw new TypeError('Unauthenticated-attempt auditing requires a client, action, and target type.');
  }

  return async function unauthenticatedAttemptAudit(req, res, next) {
    try {
      const session = await resolveSession(req, prisma);
      if (!session) {
        await recordAudit(prisma, {
          actorId: null,
          action,
          outcome: 'DENIED',
          requestId: req.requestId,
          ipAddress: typeof req.ip === 'string' ? req.ip.slice(0, 64) : null,
          targetType,
          metadata: { reasonCode: 'AUTH_REQUIRED' },
        });
      }
      return next();
    } catch (error) {
      return next(error);
    }
  };
}

export {
  auditUnauthenticatedAttempt,
  requirePermission,
  requirePermissionWithAudit,
  requireRole,
};
