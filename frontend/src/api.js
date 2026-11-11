const API_BASE = '/api';
let csrfRequest;

const statusMessages = {
  401: 'Your session has expired. Please sign in again.',
  403: 'You do not have permission to perform this action.',
  404: 'The requested record could not be found.',
  409: 'The request conflicts with the current state. Review the details and try again.',
};

class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

async function request(path, { method = 'GET', body, headers = {} } = {}) {
  const normalizedMethod = method.toUpperCase();
  const isMutation = !['GET', 'HEAD', 'OPTIONS'].includes(normalizedMethod);
  const requestHeaders = { Accept: 'application/json', ...headers };
  if (body !== undefined) requestHeaders['Content-Type'] = 'application/json';

  if (isMutation) {
    if (!csrfRequest) {
      csrfRequest = fetch(`${API_BASE}/auth/csrf`, {
        credentials: 'include',
        headers: { Accept: 'application/json' },
      }).then(async (response) => {
        const payload = await response.json().catch(() => ({}));
        if (!response.ok || typeof payload.csrfToken !== 'string') {
          throw new ApiError(
            response.status,
            payload.error?.code || 'CSRF_UNAVAILABLE',
            payload.error?.message || 'Could not verify this request. Refresh and try again.',
          );
        }
        return payload.csrfToken;
      });
    }
    try {
      requestHeaders['X-CSRF-Token'] = await csrfRequest;
    } finally {
      csrfRequest = undefined;
    }
  }

  let response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      method: normalizedMethod,
      credentials: 'include',
      headers: requestHeaders,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    throw new ApiError(0, 'NETWORK_ERROR', 'The server could not be reached. Check that the backend is running.');
  }

  if (response.status === 204) return null;
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (
      response.status === 401
      && !path.endsWith('/auth/login')
      && !path.endsWith('/auth/register')
    ) {
      window.dispatchEvent(new Event('balancevault:unauthorized'));
    }
    const message = payload.error?.message
      || statusMessages[response.status]
      || 'The request could not be completed.';
    throw new ApiError(response.status, payload.error?.code || 'REQUEST_FAILED', message);
  }
  return payload;
}

const api = {
  get: (path) => request(path),
  post: (path, body, extraHeaders) => request(path, {
    method: 'POST',
    body,
    headers: extraHeaders,
  }),
  patch: (path, body) => request(path, { method: 'PATCH', body }),
};

export { ApiError, api };
