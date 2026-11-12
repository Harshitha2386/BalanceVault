import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import test from 'node:test';
import { hashPassword, verifyPassword } from '../src/auth/password.js';
import { hashSessionToken } from '../src/auth/token.js';
import { resolveSession } from '../src/services/session-service.js';
import {
  TEST_ORIGIN,
  authRequest,
  fetchCsrf,
  readCookie,
  withAuthServer,
} from './helpers/auth-test-app.js';

const validPassword = 'Strong-Password-947!';

test('session resolution selects only the session fields used by runtime', async () => {
  const token = randomBytes(32).toString('base64url');
  const now = new Date();
  let query;
  const session = {
    id: 'session-id',
    userId: 'user-id',
    createdAt: now,
    lastSeenAt: now,
    expiresAt: new Date(now.getTime() + 60_000),
    revokedAt: null,
    user: {
      id: 'user-id',
      email: 'holder@example.test',
      fullName: 'Synthetic Account Holder',
      role: 'ACCOUNT_HOLDER',
      status: 'ACTIVE',
      mustChangePassword: false,
      createdAt: now,
    },
  };

  const result = await resolveSession(
    { headers: { cookie: `bv_session=${token}` } },
    {
      session: {
        findUnique: async (args) => {
          query = args;
          return session;
        },
      },
    },
  );

  assert.equal(result, session);
  assert.deepEqual(Object.keys(query.select).sort(), [
    'createdAt',
    'expiresAt',
    'id',
    'lastSeenAt',
    'revokedAt',
    'user',
    'userId',
  ]);
  assert.equal(Object.hasOwn(query.select, 'ipAddress'), false);
  assert.equal(Object.hasOwn(query.select, 'tokenHash'), false);
  assert.equal(Object.hasOwn(query.select, 'userAgent'), false);
});

async function postWithCsrf(baseUrl, path, body, {
  cookies = [],
  origin = TEST_ORIGIN,
  csrfToken,
} = {}) {
  const csrf = csrfToken ? null : await fetchCsrf(baseUrl, cookies);
  const token = csrfToken || csrf.token;
  const csrfCookie = csrf?.csrfCookie;
  return authRequest(baseUrl, path, {
    body,
    origin,
    csrfToken: token,
    cookies: [...cookies, ...(csrfCookie ? [`bv_csrf=${csrfCookie}`] : [])],
  });
}

async function register(baseUrl, email = 'holder@example.test', password = validPassword) {
  const response = await postWithCsrf(baseUrl, 'register', {
    email,
    fullName: 'Synthetic Account Holder',
    password,
  });
  return { response, body: await response.json() };
}

async function login(baseUrl, email = 'holder@example.test', password = validPassword, { cookies = [] } = {}) {
  const response = await postWithCsrf(baseUrl, 'login', { email, password }, { cookies });
  const body = await response.json();
  const sessionCookieValue = readCookie(response.headers.getSetCookie(), 'bv_session');
  return {
    response,
    body,
    sessionCookie: sessionCookieValue
      ? `bv_session=${encodeURIComponent(sessionCookieValue)}`
      : null,
    rawToken: sessionCookieValue,
  };
}

test('registration creates a normalized account with a password hash and safe response', async () => {
  await withAuthServer(async ({ baseUrl, prisma }) => {
    const { response, body } = await register(baseUrl, ' Holder@Example.Test ');
    const user = [...prisma.users.values()][0];

    assert.equal(response.status, 201);
    assert.equal(body.user.email, 'holder@example.test');
    assert.equal(body.user.role, 'ACCOUNT_HOLDER');
    assert.equal(body.user.status, 'ACTIVE');
    assert.equal(user.passwordHash.startsWith('scrypt$'), true);
    assert.notEqual(user.passwordHash, validPassword);
    assert.equal(Object.hasOwn(body.user, 'passwordHash'), false);
    assert.equal(JSON.stringify(body).includes(validPassword), false);
  });
});

test('duplicate registration is rejected without creating another user', async () => {
  await withAuthServer(async ({ baseUrl, prisma }) => {
    assert.equal((await register(baseUrl)).response.status, 201);
    const duplicate = await register(baseUrl, 'HOLDER@example.test');

    assert.equal(duplicate.response.status, 409);
    assert.equal(duplicate.body.error.code, 'REGISTRATION_UNAVAILABLE');
    assert.equal(prisma.users.size, 1);
  });
});

test('registration database failures stay generic to clients and log safe Prisma diagnostics', async () => {
  await withAuthServer(async ({ baseUrl, prisma }) => {
    prisma.$queryRaw = async () => {
      const error = new Error(
        'permission denied for table "User"; password=private-password; '
        + 'token=private-token; email=holder@example.test',
      );
      error.name = 'PrismaClientKnownRequestError';
      error.code = 'P2010';
      error.meta = { code: '42501' };
      throw error;
    };

    const csrf = await fetchCsrf(baseUrl);
    const loggedErrors = [];
    const originalConsoleError = console.error;
    console.error = (message) => loggedErrors.push(message);

    try {
      const response = await authRequest(baseUrl, 'register', {
        body: {
          email: 'holder@example.test',
          fullName: 'Synthetic Account Holder',
          password: validPassword,
        },
        csrfToken: csrf.token,
        cookies: [`bv_csrf=${csrf.csrfCookie}`],
      });
      const body = await response.json();

      assert.equal(response.status, 500);
      assert.equal(body.error.code, 'INTERNAL_ERROR');
      assert.equal(body.error.message, 'An unexpected error occurred.');

      const diagnostic = JSON.parse(loggedErrors[0]);
      assert.equal(diagnostic.event, 'request_failed');
      assert.equal(diagnostic.requestId, body.error.requestId);
      assert.equal(diagnostic.prismaCode, 'P2010');
      assert.equal(diagnostic.databaseCode, '42501');
      assert.match(diagnostic.errorMessage, /permission denied for table "User"/);
      assert.doesNotMatch(
        JSON.stringify(diagnostic),
        /private-password|private-token|holder@example\.test/,
      );
    } finally {
      console.error = originalConsoleError;
    }
  });
});

test('registration rejects invalid email and weak password', async () => {
  await withAuthServer(async ({ baseUrl, prisma }) => {
    const badEmail = await register(baseUrl, 'not-an-email');
    const weakPassword = await register(baseUrl, 'other@example.test', 'short');

    assert.equal(badEmail.response.status, 400);
    assert.equal(weakPassword.response.status, 400);
    assert.equal(prisma.users.size, 0);
  });
});

test('registration cannot mass-assign privileged fields', async () => {
  await withAuthServer(async ({ baseUrl, prisma }) => {
    const csrf = await fetchCsrf(baseUrl);
    const response = await authRequest(baseUrl, 'register', {
      body: {
        email: 'admin@example.test',
        fullName: 'Synthetic Admin Attempt',
        password: validPassword,
        role: 'ADMIN',
        status: 'ACTIVE',
        id: '00000000-0000-4000-8000-000000000001',
      },
      csrfToken: csrf.token,
      cookies: [`bv_csrf=${csrf.csrfCookie}`],
    });

    assert.equal(response.status, 400);
    assert.equal(prisma.users.size, 0);
  });
});

test('scrypt password verification succeeds only for the correct password', async () => {
  const encoded = await hashPassword(validPassword);
  assert.equal(await verifyPassword(validPassword, encoded), true);
  assert.equal(await verifyPassword('Wrong-Password-947!', encoded), false);
  assert.equal(await verifyPassword(validPassword, 'not-a-valid-hash'), false);
});

test('login creates a hashed session and authenticates a valid session', async () => {
  await withAuthServer(async ({ baseUrl, prisma }) => {
    await register(baseUrl);
    const result = await login(baseUrl);
    const stored = [...prisma.sessions.values()][0];

    assert.equal(result.response.status, 200);
    assert.ok(result.sessionCookie);
    assert.equal(stored.tokenHash, hashSessionToken(result.rawToken));
    assert.notEqual(stored.tokenHash, result.rawToken);
    assert.equal(JSON.stringify(result.body).includes(result.rawToken), false);
    assert.equal(Object.hasOwn(result.body.user, 'passwordHash'), false);
    assert.match(result.response.headers.getSetCookie().join(';'), /HttpOnly/);
    assert.match(result.response.headers.getSetCookie().join(';'), /SameSite=Lax/);

    const me = await authRequest(baseUrl, 'me', {
      method: 'GET',
      cookies: [result.sessionCookie],
    });
    const body = await me.json();
    assert.equal(me.status, 200);
    assert.equal(body.user.email, 'holder@example.test');
    assert.equal(Object.hasOwn(body.user, 'passwordHash'), false);
    assert.equal(Object.hasOwn(body.user, 'tokenHash'), false);
  });
});

test('protected profile returns 401 without a session', async () => {
  await withAuthServer(async ({ baseUrl }) => {
    const response = await authRequest(baseUrl, 'me', { method: 'GET' });
    assert.equal(response.status, 401);
  });
});

test('CSRF token endpoint accepts browser same-origin fetch metadata without Origin', async () => {
  await withAuthServer(async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/api/auth/csrf`, {
      headers: { 'sec-fetch-site': 'same-origin' },
    });

    assert.equal(response.status, 200);
    assert.equal(typeof (await response.json()).csrfToken, 'string');
  });
});

test('CSRF token endpoint rejects requests without an allowed origin signal', async () => {
  await withAuthServer(async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/api/auth/csrf`);

    assert.equal(response.status, 403);
    assert.equal((await response.json()).error.code, 'ORIGIN_NOT_ALLOWED');
  });
});

test('profile access stays scoped to the authenticated user', async () => {
  await withAuthServer(async ({ baseUrl }) => {
    await register(baseUrl);
    const session = await login(baseUrl);
    const response = await fetch(`${baseUrl}/api/auth/me?userId=another-user`, {
      headers: { cookie: session.sessionCookie },
    });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.user.email, 'holder@example.test');
    assert.notEqual(body.user.id, 'another-user');
  });
});

test('session authorization uses the current database role and status', async () => {
  await withAuthServer(async ({ baseUrl, prisma }) => {
    await register(baseUrl);
    const session = await login(baseUrl);
    const user = [...prisma.users.values()][0];
    user.role = 'ADMIN';

    const currentRole = await authRequest(baseUrl, 'me', {
      method: 'GET',
      cookies: [session.sessionCookie],
    });
    assert.equal((await currentRole.json()).user.role, 'ADMIN');

    user.status = 'DISABLED';
    const disabled = await authRequest(baseUrl, 'me', {
      method: 'GET',
      cookies: [session.sessionCookie],
    });
    assert.equal(disabled.status, 401);
  });
});

test('login rotates a supplied session and revokes the previous token', async () => {
  await withAuthServer(async ({ baseUrl, prisma }) => {
    await register(baseUrl);
    const first = await login(baseUrl);
    const second = await login(baseUrl, 'holder@example.test', validPassword, {
      cookies: [first.sessionCookie],
    });

    assert.equal(first.response.status, 200);
    assert.equal(second.response.status, 200);
    assert.equal(prisma.sessions.size, 2);
    assert.ok([...prisma.sessions.values()][0].revokedAt);

    const oldSession = await authRequest(baseUrl, 'me', {
      method: 'GET',
      cookies: [first.sessionCookie],
    });
    const newSession = await authRequest(baseUrl, 'me', {
      method: 'GET',
      cookies: [second.sessionCookie],
    });
    assert.equal(oldSession.status, 401);
    assert.equal(newSession.status, 200);
  });
});

test('production session cookies use Secure', async () => {
  const secureConfig = {
    nodeEnv: 'production',
    allowedOrigins: [TEST_ORIGIN],
    csrfSecret: 'production-test-csrf-secret-long-enough',
  };
  await withAuthServer(async ({ baseUrl }) => {
    await register(baseUrl);
    const result = await login(baseUrl);
    assert.match(result.response.headers.getSetCookie().join(';'), /Secure/);
  }, { config: secureConfig });
});

test('wrong password and unknown email have the same generic login response', async () => {
  await withAuthServer(async ({ baseUrl }) => {
    await register(baseUrl);
    const wrong = await login(baseUrl, 'holder@example.test', 'Wrong-Password-947!');
    const unknown = await login(baseUrl, 'unknown@example.test', validPassword);

    assert.equal(wrong.response.status, 401);
    assert.equal(unknown.response.status, 401);
    assert.equal(wrong.body.error.code, unknown.body.error.code);
    assert.equal(wrong.body.error.message, unknown.body.error.message);
    assert.equal(wrong.body.error.message, 'Invalid email or password.');
  });
});

test('expired session is rejected', async () => {
  await withAuthServer(async ({ baseUrl, prisma }) => {
    await register(baseUrl);
    const user = [...prisma.users.values()][0];
    const token = randomBytes(32).toString('base64url');
    const now = Date.now();
    prisma.sessions.set('expired-session', {
      id: 'expired-session',
      tokenHash: hashSessionToken(token),
      userId: user.id,
      createdAt: new Date(now - 13 * 60 * 60 * 1000),
      lastSeenAt: new Date(now),
      expiresAt: new Date(now - 1),
      revokedAt: null,
    });

    const response = await authRequest(baseUrl, 'me', {
      method: 'GET',
      cookies: [`bv_session=${token}`],
    });
    assert.equal(response.status, 401);
  });
});

test('revoked session is rejected', async () => {
  await withAuthServer(async ({ baseUrl, prisma }) => {
    await register(baseUrl);
    const user = [...prisma.users.values()][0];
    const token = randomBytes(32).toString('base64url');
    const now = new Date();
    prisma.sessions.set('revoked-session', {
      id: 'revoked-session',
      tokenHash: hashSessionToken(token),
      userId: user.id,
      createdAt: now,
      lastSeenAt: now,
      expiresAt: new Date(now.getTime() + 60_000),
      revokedAt: now,
    });

    const response = await authRequest(baseUrl, 'me', {
      method: 'GET',
      cookies: [`bv_session=${token}`],
    });
    assert.equal(response.status, 401);
  });
});

test('idle-expired session is rejected', async () => {
  await withAuthServer(async ({ baseUrl, prisma }) => {
    await register(baseUrl);
    const user = [...prisma.users.values()][0];
    const token = randomBytes(32).toString('base64url');
    const now = Date.now();
    prisma.sessions.set('idle-session', {
      id: 'idle-session',
      tokenHash: hashSessionToken(token),
      userId: user.id,
      createdAt: new Date(now - 40 * 60 * 1000),
      lastSeenAt: new Date(now - 31 * 60 * 1000),
      expiresAt: new Date(now + 60 * 60 * 1000),
      revokedAt: null,
    });

    const response = await authRequest(baseUrl, 'me', {
      method: 'GET',
      cookies: [`bv_session=${token}`],
    });
    assert.equal(response.status, 401);
  });
});

test('absolute session expiry is enforced even with a recent lastSeenAt', async () => {
  await withAuthServer(async ({ baseUrl, prisma }) => {
    await register(baseUrl);
    const user = [...prisma.users.values()][0];
    const token = randomBytes(32).toString('base64url');
    const now = Date.now();
    prisma.sessions.set('absolute-session', {
      id: 'absolute-session',
      tokenHash: hashSessionToken(token),
      userId: user.id,
      createdAt: new Date(now - 13 * 60 * 60 * 1000),
      lastSeenAt: new Date(now),
      expiresAt: new Date(now + 60 * 60 * 1000),
      revokedAt: null,
    });

    const response = await authRequest(baseUrl, 'me', {
      method: 'GET',
      cookies: [`bv_session=${token}`],
    });
    assert.equal(response.status, 401);
  });
});

test('logout revokes the active session and clears cookies', async () => {
  await withAuthServer(async ({ baseUrl, prisma }) => {
    await register(baseUrl);
    const loggedIn = await login(baseUrl);
    const csrf = await fetchCsrf(baseUrl, [loggedIn.sessionCookie]);
    const response = await authRequest(baseUrl, 'logout', {
      cookies: [loggedIn.sessionCookie, `bv_csrf=${csrf.csrfCookie}`],
      csrfToken: csrf.token,
    });

    assert.equal(response.status, 204);
    assert.ok([...prisma.sessions.values()][0].revokedAt);
    assert.equal(response.headers.getSetCookie().length, 2);

    const me = await authRequest(baseUrl, 'me', {
      method: 'GET',
      cookies: [loggedIn.sessionCookie],
    });
    assert.equal(me.status, 401);
  });
});

test('missing CSRF token is rejected', async () => {
  await withAuthServer(async ({ baseUrl, prisma }) => {
    const csrf = await fetchCsrf(baseUrl);
    const response = await authRequest(baseUrl, 'register', {
      body: { email: 'csrf@example.test', fullName: 'CSRF Test', password: validPassword },
      cookies: [`bv_csrf=${csrf.csrfCookie}`],
    });
    assert.equal(response.status, 403);
    assert.equal(prisma.users.size, 0);
  });
});

test('invalid CSRF token is rejected', async () => {
  await withAuthServer(async ({ baseUrl, prisma }) => {
    const csrf = await fetchCsrf(baseUrl);
    const response = await authRequest(baseUrl, 'register', {
      body: { email: 'csrf@example.test', fullName: 'CSRF Test', password: validPassword },
      csrfToken: 'invalid-token',
      cookies: [`bv_csrf=${csrf.csrfCookie}`],
    });
    assert.equal(response.status, 403);
    assert.equal(prisma.users.size, 0);
  });
});

test('unapproved Origin is rejected before registration', async () => {
  await withAuthServer(async ({ baseUrl, prisma }) => {
    const response = await authRequest(baseUrl, 'csrf', { method: 'GET', origin: 'https://attacker.example' });
    assert.equal(response.status, 403);
    assert.equal(prisma.users.size, 0);
  });
});

test('CSRF token is bound to the session that requested it', async () => {
  await withAuthServer(async ({ baseUrl }) => {
    await register(baseUrl);
    const first = await login(baseUrl);
    const second = await login(baseUrl);
    const csrf = await fetchCsrf(baseUrl, [first.sessionCookie]);
    const response = await authRequest(baseUrl, 'logout', {
      cookies: [second.sessionCookie, `bv_csrf=${csrf.csrfCookie}`],
      csrfToken: csrf.token,
    });
    assert.equal(response.status, 403);
  });
});

test('registration rate limit rejects repeated requests', async () => {
  await withAuthServer(async ({ baseUrl }) => {
    assert.equal((await register(baseUrl, 'one@example.test')).response.status, 201);
    const blocked = await register(baseUrl, 'two@example.test');
    assert.equal(blocked.response.status, 429);
    assert.equal(blocked.response.headers.has('retry-after'), true);
  }, { rateLimitOptions: { registrationIp: 1 } });
});

test('login rate limit is enforced per account', async () => {
  await withAuthServer(async ({ baseUrl }) => {
    await register(baseUrl);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      assert.equal((await login(baseUrl, 'holder@example.test', 'Wrong-Password-947!')).response.status, 401);
    }
    assert.equal((await login(baseUrl, 'holder@example.test', 'Wrong-Password-947!')).response.status, 429);
  });
});

test('repeated bad passwords lock an account, and a successful login recovers after expiry', async () => {
  await withAuthServer(async ({ baseUrl, prisma }) => {
    await register(baseUrl);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      assert.equal((await login(baseUrl, 'holder@example.test', 'Wrong-Password-947!')).response.status, 401);
    }

    const user = [...prisma.users.values()][0];
    assert.equal(user.failedLoginCount, 5);
    assert.ok(new Date(user.lockedUntil).getTime() > Date.now());
    assert.equal((await login(baseUrl)).response.status, 401);

    user.lockedUntil = new Date(Date.now() - 1);
    const recovered = await login(baseUrl);
    assert.equal(recovered.response.status, 200);
    assert.equal(user.failedLoginCount, 0);
    assert.equal(user.lockedUntil, null);
  }, { rateLimitOptions: { loginAccount: 20 } });
});

test('disabled users cannot authenticate', async () => {
  await withAuthServer(async ({ baseUrl, prisma }) => {
    await register(baseUrl);
    [...prisma.users.values()][0].status = 'DISABLED';
    const result = await login(baseUrl);
    assert.equal(result.response.status, 401);
    assert.equal(result.body.error.message, 'Invalid email or password.');
    assert.equal(prisma.sessions.size, 0);
  });
});

test('responses and cookies do not reveal password hashes or session hashes', async () => {
  await withAuthServer(async ({ baseUrl, prisma }) => {
    await register(baseUrl);
    const result = await login(baseUrl);
    const text = JSON.stringify(result.body);
    const setCookie = result.response.headers.getSetCookie().join(';');
    const user = [...prisma.users.values()][0];
    const session = [...prisma.sessions.values()][0];

    assert.equal(text.includes(user.passwordHash), false);
    assert.equal(text.includes(session.tokenHash), false);
    assert.equal(setCookie.includes(session.tokenHash), false);
  });
});

test('email normalization is stable for login', async () => {
  await withAuthServer(async ({ baseUrl }) => {
    await register(baseUrl);
    const result = await login(baseUrl, ' HOLDER@EXAMPLE.TEST ');
    assert.equal(result.response.status, 200);
  });
});

test('login without CSRF token is rejected', async () => {
  await withAuthServer(async ({ baseUrl }) => {
    await register(baseUrl);
    const csrf = await fetchCsrf(baseUrl);
    const response = await authRequest(baseUrl, 'login', {
      body: { email: 'holder@example.test', password: validPassword },
      cookies: [`bv_csrf=${csrf.csrfCookie}`],
    });
    assert.equal(response.status, 403);
  });
});

test('session tokens are random and stored only as SHA-256 digests', async () => {
  await withAuthServer(async ({ baseUrl, prisma }) => {
    await register(baseUrl);
    const first = await login(baseUrl);
    const second = await login(baseUrl, 'holder@example.test', validPassword, {
      cookies: [first.sessionCookie],
    });
    assert.notEqual(first.rawToken, second.rawToken);
    assert.ok([...prisma.sessions.values()].find(
      (session) => session.tokenHash === hashSessionToken(first.rawToken),
    ).revokedAt);
    for (const session of prisma.sessions.values()) {
      assert.match(session.tokenHash, /^[a-f0-9]{64}$/u);
      assert.equal(session.tokenHash, createHash('sha256').update(
        session.tokenHash === hashSessionToken(first.rawToken) ? first.rawToken : second.rawToken,
      ).digest('hex'));
    }
  });
});
