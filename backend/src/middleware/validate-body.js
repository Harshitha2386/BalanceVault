import { AppError } from './error-handler.js';

function validateBody(schema) {
  return function bodyValidation(req, res, next) {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      return next(new AppError(400, 'INVALID_INPUT', 'The request input is invalid.'));
    }
    req.validatedBody = result.data;
    return next();
  };
}

export { validateBody };
