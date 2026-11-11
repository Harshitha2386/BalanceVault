class AppError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function notFoundHandler(req, res) {
  res.status(404).json({
    error: {
      code: 'NOT_FOUND',
      message: 'The requested resource was not found.',
      requestId: req.requestId,
    },
  });
}

function errorHandler(error, req, res, next) {
  if (res.headersSent) {
    return next(error);
  }

  let status = error instanceof AppError ? error.status : 500;
  let code = error instanceof AppError ? error.code : 'INTERNAL_ERROR';
  let message = error instanceof AppError ? error.message : 'An unexpected error occurred.';

  if (error && error.type === 'entity.parse.failed') {
    status = 400;
    code = 'INVALID_JSON';
    message = 'The request body must contain valid JSON.';
  } else if (error && error.type === 'entity.too.large') {
    status = 413;
    code = 'PAYLOAD_TOO_LARGE';
    message = 'The request body exceeds the allowed size.';
  }

  if (status === 500) {
    console.error(JSON.stringify({
      level: 'error',
      event: 'request_failed',
      requestId: req.requestId,
    }));
  }

  res.status(status).json({
    error: {
      code,
      message,
      requestId: req.requestId,
    },
  });
}

export { AppError, errorHandler, notFoundHandler };
