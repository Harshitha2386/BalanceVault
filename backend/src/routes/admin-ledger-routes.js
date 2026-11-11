import { Router } from 'express';
import { createLedgerController } from '../controllers/ledger-controller.js';
import { requireCsrf } from '../middleware/csrf.js';
import { requireAllowedOrigin } from '../middleware/origin.js';
import {
  auditUnauthenticatedAttempt,
  requirePermissionWithAudit,
} from '../middleware/authorization.js';
import { createRateLimiter } from '../middleware/rate-limit.js';
import { requireAuthentication } from '../services/session-service.js';

function createAdminLedgerRouter({ prisma, config }) {
  const router = Router();
  const controller = createLedgerController({ prisma });
  const verifyLimit = createRateLimiter({
    limit: 5,
    windowMs: 15 * 60 * 1000,
    key: (req) => `ledger-verify:${req.auth?.user.id || req.ip || req.socket.remoteAddress || 'unknown'}`,
  });

  router.use((req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Pragma', 'no-cache');
    next();
  });
  router.post(
    '/verify',
    verifyLimit,
    auditUnauthenticatedAttempt(prisma, {
      action: 'ledger.verify',
      targetType: 'LedgerVerification',
    }),
    requireAuthentication(prisma),
    requirePermissionWithAudit({
      prisma,
      permission: 'ADMIN_LEDGER_VERIFY',
      action: 'ledger.verify',
      targetType: 'LedgerVerification',
    }),
    requireAllowedOrigin(config),
    requireCsrf({ prisma, config }),
    controller.verify,
  );
  return router;
}

export { createAdminLedgerRouter };
