import { Router } from 'express';
import { accountIdParamsSchema } from '../accounts/validation.js';
import { createAccountController } from '../controllers/account-controller.js';
import { requirePermission } from '../middleware/authorization.js';
import { validateParams } from '../middleware/validate-request.js';
import { requireAuthentication } from '../services/session-service.js';

function createAccountRouter({ prisma }) {
  const router = Router();
  const controller = createAccountController({ prisma });
  const authenticate = requireAuthentication(prisma);

  router.use((req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Pragma', 'no-cache');
    next();
  });
  router.get(
    '/',
    authenticate,
    requirePermission('CUSTOMER_ACCOUNT_READ'),
    controller.listOwn,
  );
  router.get(
    '/:id',
    authenticate,
    requirePermission('CUSTOMER_ACCOUNT_READ'),
    validateParams(accountIdParamsSchema),
    controller.getOwn,
  );

  return router;
}

export { createAccountRouter };
