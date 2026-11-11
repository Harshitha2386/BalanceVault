import { Router } from 'express';
import {
  adminUserIdParamsSchema,
  adminUserListQuerySchema,
  adminUserStatusSchema,
  auditLogQuerySchema,
} from '../admin/validation.js';
import { createAdminManagementController } from '../controllers/admin-management-controller.js';
import { requireCsrf } from '../middleware/csrf.js';
import { requireAllowedOrigin } from '../middleware/origin.js';
import {
  auditUnauthenticatedAttempt,
  requirePermissionWithAudit,
} from '../middleware/authorization.js';
import { createRateLimiter } from '../middleware/rate-limit.js';
import { validateBody } from '../middleware/validate-body.js';
import { validateParams, validateQuery } from '../middleware/validate-request.js';
import { requireAuthentication } from '../services/session-service.js';

function createAdminManagementRouter({ prisma, config }) {
  const router = Router();
  const controller = createAdminManagementController({ prisma });
  const statusChangeLimit = createRateLimiter({
    limit: 20,
    windowMs: 15 * 60 * 1000,
    key: (req) => `admin-user-status:${req.auth?.user.id || req.ip || 'unknown'}`,
  });

  router.use((req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Pragma', 'no-cache');
    next();
  });

  router.get(
    '/users',
    auditUnauthenticatedAttempt(prisma, {
      action: 'admin.users.read',
      targetType: 'User',
    }),
    requireAuthentication(prisma),
    requirePermissionWithAudit({
      prisma,
      permission: 'ADMIN_USERS_READ',
      action: 'admin.users.read',
      targetType: 'User',
    }),
    validateQuery(adminUserListQuerySchema),
    controller.listUsers,
  );
  router.get(
    '/users/:id',
    auditUnauthenticatedAttempt(prisma, {
      action: 'admin.users.read',
      targetType: 'User',
    }),
    requireAuthentication(prisma),
    requirePermissionWithAudit({
      prisma,
      permission: 'ADMIN_USERS_READ',
      action: 'admin.users.read',
      targetType: 'User',
    }),
    validateParams(adminUserIdParamsSchema),
    controller.getUser,
  );
  router.patch(
    '/users/:id/status',
    auditUnauthenticatedAttempt(prisma, {
      action: 'admin.user.status.change',
      targetType: 'User',
    }),
    requireAuthentication(prisma),
    requirePermissionWithAudit({
      prisma,
      permission: 'ADMIN_USER_ACCESS_MANAGE',
      action: 'admin.user.status.change',
      targetType: 'User',
    }),
    requireAllowedOrigin(config),
    statusChangeLimit,
    validateParams(adminUserIdParamsSchema),
    validateBody(adminUserStatusSchema),
    requireCsrf({ prisma, config }),
    controller.changeUserStatus,
  );
  router.get(
    '/audit',
    auditUnauthenticatedAttempt(prisma, {
      action: 'admin.audit.read',
      targetType: 'AuditLog',
    }),
    requireAuthentication(prisma),
    requirePermissionWithAudit({
      prisma,
      permission: 'ADMIN_AUDIT_READ',
      action: 'admin.audit.read',
      targetType: 'AuditLog',
    }),
    validateQuery(auditLogQuerySchema),
    controller.listAuditLogs,
  );

  return router;
}

export { createAdminManagementRouter };
