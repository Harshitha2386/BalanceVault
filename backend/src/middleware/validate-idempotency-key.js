import { idempotencyKeySchema } from '../ledger/validation.js';
import { AppError } from './error-handler.js';

function validateIdempotencyKey(req, res, next) {
  const result = idempotencyKeySchema.safeParse(req.get('idempotency-key'));
  if (!result.success) {
    return next(new AppError(
      400,
      'INVALID_IDEMPOTENCY_KEY',
      'A valid Idempotency-Key header is required.',
    ));
  }
  req.idempotencyKey = result.data;
  return next();
}

export { validateIdempotencyKey };
