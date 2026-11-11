import { AppError } from './error-handler.js';
import { CSRF_COOKIE, getCookie, setCsrfCookie } from '../auth/cookies.js';
import { createCsrfToken, isValidCsrfToken } from '../auth/token.js';
import { resolveSession } from '../services/session-service.js';

function issueCsrfToken({ prisma, config }) {
  return async function csrfTokenController(req, res, next) {
    try {
      const session = await resolveSession(req, prisma);
      const issued = createCsrfToken(config.csrfSecret, session?.id);
      setCsrfCookie(res, issued.nonce, config.nodeEnv === 'production');
      return res.status(200).json({
        csrfToken: issued.token,
        requestId: req.requestId,
      });
    } catch (error) {
      return next(error);
    }
  };
}

function requireCsrf({ prisma, config }) {
  return async function csrfValidation(req, res, next) {
    try {
      const nonce = getCookie(req, CSRF_COOKIE);
      const token = req.get('x-csrf-token');
      const session = req.auth?.session || await resolveSession(req, prisma);
      if (!isValidCsrfToken(config.csrfSecret, session?.id, nonce, token)) {
        throw new AppError(403, 'CSRF_REJECTED', 'The request could not be verified.');
      }
      return next();
    } catch (error) {
      return next(error);
    }
  };
}

export { issueCsrfToken, requireCsrf };
