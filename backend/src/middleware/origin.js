import { AppError } from './error-handler.js';

function requireAllowedOrigin(config) {
  return function originValidation(req, res, next) {
    const origin = req.get('origin');
    if (typeof origin !== 'string' || !config.allowedOrigins.includes(origin)) {
      return next(new AppError(403, 'ORIGIN_NOT_ALLOWED', 'The request origin is not allowed.'));
    }
    return next();
  };
}

function requireAllowedOriginOrSameOriginFetch(config) {
  return function sameOriginValidation(req, res, next) {
    const origin = req.get('origin');
    if (typeof origin === 'string' && config.allowedOrigins.includes(origin)) {
      return next();
    }
    if (!origin && req.get('sec-fetch-site') === 'same-origin') {
      return next();
    }
    return next(new AppError(403, 'ORIGIN_NOT_ALLOWED', 'The request origin is not allowed.'));
  };
}

export { requireAllowedOrigin, requireAllowedOriginOrSameOriginFetch };
