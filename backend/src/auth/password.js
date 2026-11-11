import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback);
const SCRYPT_OPTIONS = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const KEY_LENGTH = 64;

async function deriveKey(password, salt, options = SCRYPT_OPTIONS) {
  return scrypt(password, salt, KEY_LENGTH, options);
}

async function hashPassword(password) {
  const salt = randomBytes(16);
  const key = await deriveKey(password.normalize('NFKC'), salt);
  return [
    'scrypt',
    SCRYPT_OPTIONS.N,
    SCRYPT_OPTIONS.r,
    SCRYPT_OPTIONS.p,
    salt.toString('base64url'),
    Buffer.from(key).toString('base64url'),
  ].join('$');
}

async function verifyPassword(password, encodedHash) {
  const parts = typeof encodedHash === 'string' ? encodedHash.split('$') : [];
  if (parts.length !== 6 || parts[0] !== 'scrypt') {
    return false;
  }

  const [, nText, rText, pText, saltText, keyText] = parts;
  const options = { N: Number(nText), r: Number(rText), p: Number(pText), maxmem: 64 * 1024 * 1024 };
  const salt = Buffer.from(saltText, 'base64url');
  const expected = Buffer.from(keyText, 'base64url');

  if (
    !Number.isSafeInteger(options.N)
    || options.N !== SCRYPT_OPTIONS.N
    || options.r !== SCRYPT_OPTIONS.r
    || options.p !== SCRYPT_OPTIONS.p
    || salt.length !== 16
    || expected.length !== KEY_LENGTH
  ) {
    return false;
  }

  const actual = Buffer.from(await deriveKey(password.normalize('NFKC'), salt, options));
  return timingSafeEqual(actual, expected);
}

export { hashPassword, verifyPassword };
