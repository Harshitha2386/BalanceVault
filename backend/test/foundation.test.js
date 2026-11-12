import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import express from 'express';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import { requestIdMiddleware } from '../src/middleware/request-id.js';
import { createShutdownHandler, formatStartupError } from '../src/server.js';

const testConfig = {
  nodeEnv: 'test',
  port: 3000,
  databaseUrl: 'postgresql://not-used.example.test/balancevault_test',
  allowedOrigins: ['http://localhost:5173'],
  csrfSecret: 'test-csrf-secret-must-be-at-least-32-bytes',
};

async function withServer(app, run) {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  try {
    const address = server.address();
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

test('health responds without querying the database', async () => {
  let queryCount = 0;
  const app = createApp({
    prisma: { $queryRaw: async () => { queryCount += 1; } },
    config: testConfig,
  });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/health`);
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.status, 'ok');
    assert.equal(response.headers.get('x-request-id'), body.requestId);
    assert.equal(queryCount, 0);
  });
});

test('production trusts only the single configured Render proxy hop', () => {
  const app = createApp({
    prisma: { $queryRaw: async () => [] },
    config: { ...testConfig, nodeEnv: 'production' },
  });

  assert.equal(app.get('trust proxy'), 1);
});

test('serves frontend routes and assets without intercepting unknown API paths', async () => {
  const frontendDist = await mkdtemp(join(tmpdir(), 'balancevault-frontend-'));
  await writeFile(join(frontendDist, 'index.html'), '<!doctype html><title>BalanceVault test</title>');
  await writeFile(join(frontendDist, 'app.js'), 'window.balanceVaultTest = true;');
  const app = createApp({
    prisma: { $queryRaw: async () => [] },
    config: testConfig,
    frontendDist,
  });

  try {
    await withServer(app, async (baseUrl) => {
      const pageResponse = await fetch(`${baseUrl}/admin/users/123`, {
        headers: { accept: 'text/html' },
      });
      const page = await pageResponse.text();
      const assetResponse = await fetch(`${baseUrl}/app.js`);
      const apiResponse = await fetch(`${baseUrl}/api/unknown`, {
        headers: { accept: 'text/html' },
      });
      const apiBody = await apiResponse.json();
      const healthResponse = await fetch(`${baseUrl}/health`);

      assert.equal(pageResponse.status, 200);
      assert.match(page, /BalanceVault test/);
      assert.equal(pageResponse.headers.get('cache-control'), 'no-cache');
      assert.equal(assetResponse.status, 200);
      assert.equal(await assetResponse.text(), 'window.balanceVaultTest = true;');
      assert.equal(apiResponse.status, 404);
      assert.equal(apiBody.error.code, 'NOT_FOUND');
      assert.equal(apiResponse.headers.get('content-type').includes('application/json'), true);
      assert.equal(healthResponse.status, 200);
    });
  } finally {
    await rm(frontendDist, { recursive: true, force: true });
  }
});

test('readiness executes a read-only Prisma query and reports success', async () => {
  let queryCount = 0;
  let queryText;
  const app = createApp({
    prisma: {
      $queryRaw: async (parts) => {
        queryCount += 1;
        queryText = parts.join('?');
        return [{ '?column?': 1 }];
      },
    },
    config: testConfig,
  });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/ready`);
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.status, 'ready');
    assert.equal(queryCount, 1);
    assert.equal(queryText, 'SELECT 1');
  });
});

test('readiness hides database errors and returns unavailable', async () => {
  const app = createApp({
    prisma: { $queryRaw: async () => { throw new Error('private database details'); } },
    config: testConfig,
  });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/ready`);
    const body = await response.json();
    const serialized = JSON.stringify(body);

    assert.equal(response.status, 503);
    assert.equal(body.status, 'not_ready');
    assert.equal(body.error.code, 'DATABASE_UNAVAILABLE');
    assert.equal(serialized.includes('private database details'), false);
  });
});

test('configuration validation rejects invalid values without echoing them', () => {
  const privateValue = 'https://private-user:private-password@example.test/invalid';

  assert.throws(
    () => loadConfig({ DATABASE_URL: privateValue, PORT: 'not-a-port' }),
    (error) => {
      assert.match(error.message, /DATABASE_URL/);
      assert.match(error.message, /PORT/);
      assert.equal(error.message.includes(privateValue), false);
      assert.equal(error.message.includes('private-password'), false);
      return true;
    },
  );
});

test('production configuration requires explicit HTTPS origin and CSRF secret', () => {
  assert.throws(
    () => loadConfig({
      NODE_ENV: 'production',
      DATABASE_URL: 'postgresql://app:secret@localhost:5432/balancevault_test',
    }),
    /APP_ORIGINS, CSRF_SECRET/,
  );
  assert.throws(
    () => loadConfig({
      NODE_ENV: 'production',
      DATABASE_URL: 'postgresql://app:secret@localhost:5432/balancevault_test',
      APP_ORIGINS: 'http://client.example.test',
      CSRF_SECRET: 'a'.repeat(32),
    }),
    /APP_ORIGINS/,
  );
  assert.deepEqual(
    loadConfig({
      NODE_ENV: 'production',
      DATABASE_URL: 'postgresql://app:secret@localhost:5432/balancevault_test',
      APP_ORIGINS: 'https://client.example.test',
      CSRF_SECRET: 'a'.repeat(32),
    }).allowedOrigins,
    ['https://client.example.test'],
  );
});

test('configuration defaults are applied for optional settings', () => {
  assert.deepEqual(loadConfig({
    DATABASE_URL: 'postgresql://app:secret@localhost:5432/balancevault_test',
  }).allowedOrigins, ['http://localhost:5173']);
});

test('startup diagnostics include useful details without exposing secrets', () => {
  const error = new Error(
    'Prisma failed for postgresql://runtime:db-password@db.example.test/balancevault'
      + '; token=inline-token; csrf-key-secret',
  );
  error.name = 'PrismaClientInitializationError';
  error.stack = `${error.name}: ${error.message}\n    at startServer (src/server.js:1:1)`;

  const diagnostic = formatStartupError(error, {
    DATABASE_URL: 'postgresql://runtime:configured-password@db.example.test/balancevault',
    CSRF_SECRET: 'csrf-key-secret',
  });
  const serialized = JSON.stringify(diagnostic);

  assert.equal(diagnostic.errorName, 'PrismaClientInitializationError');
  assert.match(diagnostic.errorMessage, /Prisma failed/);
  assert.match(diagnostic.stack, /at startServer/);
  assert.doesNotMatch(
    serialized,
    /db-password|inline-token|csrf-key-secret|postgresql:\/\//,
  );
});

test('error handler logs safe Prisma diagnostics and returns a generic response', async () => {
  const app = express();
  app.use(requestIdMiddleware);
  app.get('/failure', () => {
    const error = new Error(
      'permission denied for table "AuditLog"; password=private-password; '
      + 'token=private-token; user=alice@example.test; '
      + 'postgresql://runtime:private-db-password@db.example.test/balancevault',
    );
    error.name = 'PrismaClientKnownRequestError';
    error.code = 'P2010';
    error.meta = { code: '42501' };
    throw error;
  });
  app.use(errorHandler);

  const loggedErrors = [];
  const originalConsoleError = console.error;
  console.error = (message) => loggedErrors.push(message);

  try {
    await withServer(app, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/failure`);
      const body = await response.json();
      const serialized = JSON.stringify(body);

      assert.equal(response.status, 500);
      assert.equal(body.error.code, 'INTERNAL_ERROR');
      assert.equal(serialized.includes('private-password'), false);
      assert.equal(serialized.includes('private-token'), false);
      assert.equal(serialized.includes('alice@example.test'), false);
      assert.equal(serialized.includes('stack'), false);

      const diagnostic = JSON.parse(loggedErrors[0]);
      assert.equal(diagnostic.event, 'request_failed');
      assert.equal(diagnostic.requestId, body.error.requestId);
      assert.equal(diagnostic.errorName, 'PrismaClientKnownRequestError');
      assert.equal(diagnostic.prismaCode, 'P2010');
      assert.equal(diagnostic.databaseCode, '42501');
      assert.match(diagnostic.errorMessage, /permission denied for table "AuditLog"/);
      const logged = JSON.stringify(diagnostic);
      assert.doesNotMatch(
        logged,
        /private-password|private-token|alice@example\.test|private-db-password|postgresql:\/\//,
      );
      assert.doesNotMatch(logged, /stack|cookie|requestBody/);
    });
  } finally {
    console.error = originalConsoleError;
  }
});

test('JSON parser rejects malformed and oversized request bodies', async () => {
  const app = createApp({ prisma: { $queryRaw: async () => [] }, config: testConfig });

  await withServer(app, async (baseUrl) => {
    const malformed = await fetch(`${baseUrl}/missing`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{',
    });
    const oversized = await fetch(`${baseUrl}/missing`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ value: 'x'.repeat(20 * 1024) }),
    });

    assert.equal(malformed.status, 400);
    assert.equal((await malformed.json()).error.code, 'INVALID_JSON');
    assert.equal(oversized.status, 413);
    assert.equal((await oversized.json()).error.code, 'PAYLOAD_TOO_LARGE');
  });
});

test('Neon grants cover Prisma AuditLog creates without granting mutation privileges', async () => {
  const grants = await readFile(
    new URL('../db/03-neon-production-grants.sql', import.meta.url),
    'utf8',
  );
  const insertGrant = grants.split(';').find(
    (statement) => /^\s*GRANT INSERT/.test(statement)
      && /ON TABLE public\."AuditLog" TO bv_app/.test(statement),
  );

  assert.ok(insertGrant, 'AuditLog must use a column-scoped INSERT grant');
  assert.deepEqual(
    [...insertGrant.match(/GRANT INSERT\s*\(([\s\S]*?)\)\s*ON TABLE public\."AuditLog"/)[1]
      .matchAll(/"([^"]+)"/g)].map((match) => match[1]),
    [
      'actorId', 'action', 'targetType', 'targetId', 'outcome',
      'requestId', 'ipAddress', 'metadata',
    ],
  );
  for (const column of [
    'actorId', 'action', 'targetType', 'targetId',
    'outcome', 'requestId', 'ipAddress', 'metadata',
  ]) {
    assert.ok(
      grants.includes(`has_column_privilege('bv_app', 'public."AuditLog"', '${column}', 'INSERT')`),
      `postflight must verify AuditLog.${column} INSERT`,
    );
  }
  assert.match(grants, /has_column_privilege\('bv_app', 'public\."AuditLog"', 'id', 'SELECT'\)/);
  assert.match(grants, /has_sequence_privilege\('bv_app', 'public\."AuditLog_id_seq"', 'USAGE'\)/);
  assert.match(grants, /has_database_privilege\('bv_app', current_database\(\), 'CONNECT'\)/);
  assert.match(grants, /has_schema_privilege\('bv_app', 'public', 'USAGE'\)/);
  assert.doesNotMatch(grants, /GRANT INSERT\s+ON TABLE public\."AuditLog"/);
  assert.match(grants, /has_table_privilege\('bv_app', 'public\."AuditLog"', 'UPDATE'\)/);
  assert.match(grants, /has_table_privilege\('bv_app', 'public\."AuditLog"', 'DELETE'\)/);
  assert.match(grants, /has_table_privilege\('bv_app', 'public\."AuditLog"', 'TRUNCATE'\)/);
});

test('graceful shutdown closes HTTP before disconnecting Prisma once', async () => {
  let closeCount = 0;
  let disconnectCount = 0;
  const shutdown = createShutdownHandler({
    close(callback) {
      closeCount += 1;
      callback();
    },
  }, {
    async $disconnect() {
      disconnectCount += 1;
    },
  });

  shutdown();
  shutdown();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(closeCount, 1);
  assert.equal(disconnectCount, 1);
});
