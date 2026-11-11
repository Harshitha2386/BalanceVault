import { AppError } from './error-handler.js';

function validateQuery(schema) {
  return function queryValidation(req, res, next) {
    const result = schema.safeParse(req.query);
    if (!result.success) {
      return next(new AppError(400, 'INVALID_INPUT', 'The request input is invalid.'));
    }
    req.validatedQuery = result.data;
    return next();
  };
}

function validateParams(schema) {
  return function paramsValidation(req, res, next) {
    const result = schema.safeParse(req.params);
    if (!result.success) {
      return next(new AppError(400, 'INVALID_RESOURCE_ID', 'The resource ID is invalid.'));
    }
    req.validatedParams = result.data;
    return next();
  };
}

export { validateParams, validateQuery };
