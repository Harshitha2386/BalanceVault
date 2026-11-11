import { Router } from 'express';
import { loginSchema, registrationSchema } from '../auth/validation.js';
import { createAuthController } from '../controllers/auth-controller.js';
import { issueCsrfToken, requireCsrf } from '../middleware/csrf.js';
import {
  requireAllowedOrigin,
  requireAllowedOriginOrSameOriginFetch,
} from '../middleware/origin.js';
import { createRateLimiter, accountRateLimitKey } from '../middleware/rate-limit.js';
import { requirePermission } from '../middleware/authorization.js';
import { requireAuthentication } from '../services/session-service.js';
import { validateBody } from '../middleware/validate-body.js';

function createAuthRouter({ prisma, config, rateLimitOptions = {} }) {
  const router = Router();
  const controller = createAuthController({ prisma, config });
  const origin = requireAllowedOrigin(config);
  const csrfOrigin = requireAllowedOriginOrSameOriginFetch(config);
  const csrf = requireCsrf({ prisma, config });
  const authenticate = requireAuthentication(prisma);

  const registrationIpLimit = createRateLimiter({
    limit: rateLimitOptions.registrationIp ?? 5,
    windowMs: rateLimitOptions.windowMs ?? 15 * 60 * 1000,
    key: (req) => `register:${req.ip || req.socket.remoteAddress || 'unknown'}`,
  });
  const loginIpLimit = createRateLimiter({
    limit: rateLimitOptions.loginIp ?? 30,
    windowMs: rateLimitOptions.windowMs ?? 15 * 60 * 1000,
    key: (req) => `login-ip:${req.ip || req.socket.remoteAddress || 'unknown'}`,
  });
  const loginAccountLimit = createRateLimiter({
    limit: rateLimitOptions.loginAccount ?? 5,
    windowMs: rateLimitOptions.windowMs ?? 15 * 60 * 1000,
    key: (req) => `login-account:${accountRateLimitKey(req.validatedBody.email)}`,
  });
  const csrfIpLimit = createRateLimiter({
    limit: rateLimitOptions.csrfIp ?? 60,
    windowMs: rateLimitOptions.windowMs ?? 15 * 60 * 1000,
    key: (req) => `csrf:${req.ip || req.socket.remoteAddress || 'unknown'}`,
  });

  router.use((req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Pragma', 'no-cache');
    next();
  });
  router.get('/csrf', csrfOrigin, csrfIpLimit, issueCsrfToken({ prisma, config }));
  router.post(
    '/register',
    origin,
    registrationIpLimit,
    validateBody(registrationSchema),
    csrf,
    controller.register,
  );
  router.post(
    '/login',
    origin,
    loginIpLimit,
    validateBody(loginSchema),
    loginAccountLimit,
    csrf,
    controller.login,
  );
  router.post(
    '/logout',
    origin,
    authenticate,
    requirePermission('SESSION_END'),
    csrf,
    controller.logout,
  );
  router.get(
    '/me',
    authenticate,
    requirePermission('PROFILE_READ'),
    controller.me,
  );

  return router;
}

export { createAuthRouter };
