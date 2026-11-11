import http from 'node:http';
import { createApp } from '../../src/app.js';
import { FakePrisma } from './fake-prisma.js';

const TEST_ORIGIN = 'http://client.example.test';
const testConfig = {
  nodeEnv: 'test',
  port: 0,
  databaseUrl: 'postgresql://not-used.example.test/balancevault_test',
  allowedOrigins: [TEST_ORIGIN],
  csrfSecret: 'test-csrf-secret-must-be-at-least-32-bytes',
};

async function withAuthServer(run, { rateLimitOptions, config = testConfig } = {}) {
  const prisma = new FakePrisma();
  const app = createApp({ prisma, config, rateLimitOptions });
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  try {
    const { port } = server.address();
    await run({ baseUrl: `http://127.0.0.1:${port}`, prisma });
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

function readCookie(setCookieHeaders, name) {
  for (const header of setCookieHeaders) {
    const match = header.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
    if (match) {
      return decodeURIComponent(match[1]);
    }
  }
  return null;
}

async function fetchCsrf(baseUrl, extraCookies = []) {
  const response = await fetch(`${baseUrl}/api/auth/csrf`, {
    headers: {
      origin: TEST_ORIGIN,
      ...(extraCookies.length ? { cookie: extraCookies.join('; ') } : {}),
    },
  });
  const body = await response.json();
  const headers = response.headers.getSetCookie();
  return {
    response,
    token: body.csrfToken,
    csrfCookie: readCookie(headers, 'bv_csrf'),
    sessionCookie: readCookie(headers, 'bv_session'),
  };
}

async function authRequest(baseUrl, path, {
  method = 'POST',
  body,
  origin = TEST_ORIGIN,
  csrfToken,
  cookies = [],
} = {}) {
  return fetch(`${baseUrl}/api/auth/${path}`, {
    method,
    headers: {
      origin,
      ...(method === 'POST' ? { 'content-type': 'application/json' } : {}),
      ...(csrfToken ? { 'x-csrf-token': csrfToken } : {}),
      ...(cookies.length ? { cookie: cookies.join('; ') } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

export {
  TEST_ORIGIN,
  authRequest,
  fetchCsrf,
  readCookie,
  testConfig,
  withAuthServer,
};
