import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

function hashSessionToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

function createSessionToken() {
  return randomBytes(32).toString('base64url');
}

function csrfSignature(secret, sessionId, nonce) {
  return createHmac('sha256', secret)
    .update(`balancevault-csrf:v1:${sessionId || 'anonymous'}:${nonce}`)
    .digest('base64url');
}

function createCsrfToken(secret, sessionId) {
  const nonce = randomBytes(32).toString('base64url');
  return { nonce, token: `${nonce}.${csrfSignature(secret, sessionId, nonce)}` };
}

function isValidCsrfToken(secret, sessionId, nonce, token) {
  if (
    typeof nonce !== 'string'
    || typeof token !== 'string'
    || nonce.length !== 43
    || token.length > 128
  ) {
    return false;
  }

  const [tokenNonce, suppliedSignature, extra] = token.split('.');
  if (tokenNonce !== nonce || !suppliedSignature || extra !== undefined) {
    return false;
  }

  const expected = Buffer.from(csrfSignature(secret, sessionId, nonce));
  const supplied = Buffer.from(suppliedSignature);
  return expected.length === supplied.length && timingSafeEqual(expected, supplied);
}

export {
  createCsrfToken,
  createSessionToken,
  hashSessionToken,
  isValidCsrfToken,
};
