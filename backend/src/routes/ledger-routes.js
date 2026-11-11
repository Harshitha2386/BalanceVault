import { Router } from 'express';
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
import { validateQuery } from '../middleware/validate-request.js';
import {
  transactionListQuerySchema,
  transferBodySchema,
} from '../ledger/validation.js';
import { requireAuthentication } from '../services/session-service.js';

function createLedgerRouter({ prisma, config }) {
  const router = Router();
  const controller = createLedgerController({ prisma });
  const authenticate = requireAuthentication(prisma);
  const transferLimit = createRateLimiter({
    limit: 20,
    windowMs: 15 * 60 * 1000,
    key: (req) => `transfer:${req.auth?.user.id || req.ip || req.socket.remoteAddress || 'unknown'}`,
  });

  router.use((req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Pragma', 'no-cache');
    next();
  });
  router.get(
    '/transactions',
    authenticate,
    requirePermission('CUSTOMER_TRANSACTION_READ'),
    validateQuery(transactionListQuerySchema),
    controller.listOwn,
  );
  router.post(
    '/transfers',
    transferLimit,
    auditUnauthenticatedAttempt(prisma, {
      action: 'ledger.transfer.create',
      targetType: 'LedgerTransaction',
    }),
    authenticate,
    requirePermissionWithAudit({
      prisma,
      permission: 'CUSTOMER_TRANSFER_CREATE',
      action: 'ledger.transfer.create',
      targetType: 'LedgerTransaction',
    }),
    requireAllowedOrigin(config),
    validateBody(transferBodySchema),
    validateIdempotencyKey,
    requireCsrf({ prisma, config }),
    controller.transfer,
  );
  return router;
}

export { createLedgerRouter };
