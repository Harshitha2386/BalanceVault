const SESSION_COOKIE = 'bv_session';
const CSRF_COOKIE = 'bv_csrf';

function getCookie(req, name) {
  const header = req.headers.cookie;
  if (typeof header !== 'string') {
    return null;
  }

  for (const pair of header.split(';')) {
    const separator = pair.indexOf('=');
    if (separator < 0 || pair.slice(0, separator).trim() !== name) {
      continue;
    }

    try {
      return decodeURIComponent(pair.slice(separator + 1).trim());
    } catch {
      return null;
    }
  }
  return null;
}

function cookieOptions(isProduction, { httpOnly = true, maxAge } = {}) {
  return [
    'Path=/',
    'SameSite=Lax',
    ...(httpOnly ? ['HttpOnly'] : []),
    ...(isProduction ? ['Secure'] : []),
    ...(maxAge === undefined ? [] : [`Max-Age=${maxAge}`]),
  ].join('; ');
}

function setSessionCookie(res, token, isProduction, maxAge) {
  res.append(
    'Set-Cookie',
    `${SESSION_COOKIE}=${encodeURIComponent(token)}; ${cookieOptions(isProduction, { maxAge })}`,
  );
}

function clearAuthCookies(res, isProduction) {
  clearSessionCookie(res, isProduction);
  clearCsrfCookie(res, isProduction);
}

function clearSessionCookie(res, isProduction) {
  res.append(
    'Set-Cookie',
    `${SESSION_COOKIE}=; ${cookieOptions(isProduction, { maxAge: 0 })}`,
  );
}

function clearCsrfCookie(res, isProduction) {
  res.append(
    'Set-Cookie',
    `${CSRF_COOKIE}=; ${cookieOptions(isProduction, { httpOnly: false, maxAge: 0 })}`,
  );
}

function setCsrfCookie(res, nonce, isProduction) {
  res.append(
    'Set-Cookie',
    `${CSRF_COOKIE}=${encodeURIComponent(nonce)}; ${cookieOptions(isProduction, {
      httpOnly: false,
      maxAge: 3600,
    })}`,
  );
}

export {
  CSRF_COOKIE,
  SESSION_COOKIE,
  clearAuthCookies,
  clearCsrfCookie,
  getCookie,
  setCsrfCookie,
  setSessionCookie,
};
