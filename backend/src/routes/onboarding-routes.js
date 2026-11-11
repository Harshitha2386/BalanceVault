import { Router } from 'express';
import { applicationSubmissionSchema } from '../onboarding/validation.js';
import { createOnboardingController } from '../controllers/onboarding-controller.js';
import { requireCsrf } from '../middleware/csrf.js';
import { requireAllowedOrigin } from '../middleware/origin.js';
import { requirePermission } from '../middleware/authorization.js';
import { validateBody } from '../middleware/validate-body.js';
import { requireAuthentication } from '../services/session-service.js';

function createOnboardingRouter({ prisma, config }) {
  const router = Router();
  const controller = createOnboardingController({ prisma });
  const authenticate = requireAuthentication(prisma);

  router.use((req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Pragma', 'no-cache');
    next();
  });
  router.post(
    '/applications',
    requireAllowedOrigin(config),
    authenticate,
    requirePermission('CUSTOMER_ONBOARDING_SUBMIT'),
    validateBody(applicationSubmissionSchema),
    requireCsrf({ prisma, config }),
    controller.submit,
  );
  router.get(
    '/applications/me',
    authenticate,
    requirePermission('CUSTOMER_ONBOARDING_READ'),
    controller.listOwn,
  );

  return router;
}

export { createOnboardingRouter };
