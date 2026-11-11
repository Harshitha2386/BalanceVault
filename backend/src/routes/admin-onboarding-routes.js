import { Router } from 'express';
import {
  applicationDecisionSchema,
  applicationIdParamsSchema,
  applicationListQuerySchema,
} from '../onboarding/validation.js';
import { createOnboardingController } from '../controllers/onboarding-controller.js';
import { requireCsrf } from '../middleware/csrf.js';
import { requireAllowedOrigin } from '../middleware/origin.js';
import { requirePermission } from '../middleware/authorization.js';
import { createRateLimiter } from '../middleware/rate-limit.js';
import { validateBody } from '../middleware/validate-body.js';
import { validateParams, validateQuery } from '../middleware/validate-request.js';
import { requireAuthentication } from '../services/session-service.js';

function createAdminOnboardingRouter({ prisma, config }) {
  const router = Router();
  const controller = createOnboardingController({ prisma });
  const decisionRateLimit = createRateLimiter({
    limit: 20,
    windowMs: 15 * 60 * 1000,
    key: (req) => `onboarding-decision:${req.ip || req.socket.remoteAddress || 'unknown'}`,
  });

  router.use((req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Pragma', 'no-cache');
    next();
  });
  router.use(
    requireAuthentication(prisma),
    requirePermission('ADMIN_ONBOARDING_READ'),
  );
  router.get('/', validateQuery(applicationListQuerySchema), controller.listAdmin);
  router.get(
    '/:id',
    validateParams(applicationIdParamsSchema),
    controller.getAdmin,
  );
  router.patch(
    '/:id/decision',
    requireAllowedOrigin(config),
    requirePermission('ADMIN_ONBOARDING_REVIEW'),
    decisionRateLimit,
    validateParams(applicationIdParamsSchema),
    validateBody(applicationDecisionSchema),
    requireCsrf({ prisma, config }),
    controller.decide,
  );

  return router;
}

export { createAdminOnboardingRouter };
