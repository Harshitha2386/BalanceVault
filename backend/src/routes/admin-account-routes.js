import { Router } from 'express';
import {
  accountIdParamsSchema,
  accountListQuerySchema,
  accountStatusSchema,
} from '../accounts/validation.js';
import { fundingBodySchema } from '../ledger/validation.js';
import { createAccountController } from '../controllers/account-controller.js';
import { createLedgerController } from '../controllers/ledger-controller.js';
import { requireCsrf } from '../middleware/csrf.js';
import { requireAllowedOrigin } from '../middleware/origin.js';
import {
  auditUnauthenticatedAttempt,
  requirePermission,
  requirePermissionWithAudit,
} from '../middleware/authorization.js';
import { createRateLimiter } from '../middleware/rate-limit.js';
import { validateBody } from '../middleware/validate-body.js';
import { validateIdempotencyKey } from '../middleware/validate-idempotency-key.js';
import { validateParams, validateQuery } from '../middleware/validate-request.js';
import { requireAuthentication } from '../services/session-service.js';

function createAdminAccountRouter({ prisma, config }) {
  const router = Router();
  const controller = createAccountController({ prisma });
  const ledgerController = createLedgerController({ prisma });
  const rateLimitProvisioning = createRateLimiter({
    limit: 20,
    windowMs: 15 * 60 * 1000,
    key: (req) => `account-status:${req.ip || req.socket.remoteAddress || 'unknown'}`,
  });
  const rateLimitFunding = createRateLimiter({
    limit: 10,
    windowMs: 15 * 60 * 1000,
    key: (req) => `funding:${req.auth?.user.id || req.ip || req.socket.remoteAddress || 'unknown'}`,
  });
  const authenticate = requireAuthentication(prisma);

  router.use((req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Pragma', 'no-cache');
    next();
  });
  router.get(
    '/',
    authenticate,
    requirePermission('ADMIN_ACCOUNT_READ'),
    validateQuery(accountListQuerySchema),
    controller.listAdmin,
  );
  router.get(
    '/:id',
    authenticate,
    requirePermission('ADMIN_ACCOUNT_READ'),
    validateParams(accountIdParamsSchema),
    controller.getAdmin,
  );
  router.patch(
    '/:id/status',
    authenticate,
    requirePermission('ADMIN_ACCOUNT_READ'),
    requireAllowedOrigin(config),
    requirePermission('ADMIN_ACCOUNT_STATUS_MANAGE'),
    rateLimitProvisioning,
    validateParams(accountIdParamsSchema),
    validateBody(accountStatusSchema),
    requireCsrf({ prisma, config }),
    controller.changeStatus,
  );
  router.post(
    '/:id/fund',
    rateLimitFunding,
    auditUnauthenticatedAttempt(prisma, {
      action: 'ledger.funding.create',
      targetType: 'LedgerTransaction',
    }),
    authenticate,
    requirePermissionWithAudit({
      prisma,
      permission: 'ADMIN_FUNDING_CREATE',
      action: 'ledger.funding.create',
      targetType: 'LedgerTransaction',
    }),
    requireAllowedOrigin(config),
    validateParams(accountIdParamsSchema),
    validateBody(fundingBodySchema),
    validateIdempotencyKey,
    requireCsrf({ prisma, config }),
    ledgerController.fund,
  );

  return router;
}

export { createAdminAccountRouter };
