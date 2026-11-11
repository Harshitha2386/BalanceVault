import assert from 'node:assert/strict';
import test from 'node:test';
import {
  bootstrapAdmin,
  BootstrapError,
} from '../src/services/admin-bootstrap-service.js';
import {
  runBootstrapCli,
  safeFailureMessage,
} from '../scripts/bootstrap-admin.js';

const DIRECT_URL = 'postgresql://postgres:ignored@localhost:5432/balancevault_test';
const CREDENTIALS = {
  email: '  ADMIN@EXAMPLE.TEST ',
  fullName: '  First Administrator  ',
  password: 'Synthetic-Admin-Password-948!',
};
const CONFIRMATION = 'balancevault_test';

class BootstrapFakePrisma {
  constructor({ existingAdmins = 0, failAudit = false, identity = {} } = {}) {
    this.admins = Array.from({ length: existingAdmins }, (_, index) => ({
      id: `existing-${index}`,
      role: 'ADMIN',
    }));
    this.users = [];
    this.auditRows = [];
    this.identity = {
      database_name: 'balancevault_test',
      role_name: 'postgres',
      ...identity,
    };
    this.failAudit = failAudit;
    this.locked = false;
    this.transactionCount = 0;
    this.disconnectCount = 0;

    this.user = {
      count: async ({ where }) => {
        assert.equal(this.locked, true);
        assert.deepEqual(where, { role: 'ADMIN' });
        return this.admins.length;
      },
      create: async ({ data, select }) => {
        const row = { ...data };
        this.admins.push(row);
        this.users.push(row);
        return Object.fromEntries(
          Object.keys(select).map((field) => [field, row[field]]),
        );
      },
    };
    this.auditLog = {
      create: async ({ data }) => {
        if (this.failAudit) {
          throw new Error('synthetic audit failure containing a secret');
        }
        this.auditRows.push(data);
        return { id: 1n };
      },
    };
  }

  async $queryRaw() {
    return [this.identity];
  }

  async $executeRaw() {
    this.locked = true;
    return 0;
  }

  async $transaction(callback) {
    this.transactionCount += 1;
    const snapshot = {
      admins: structuredClone(this.admins),
      users: structuredClone(this.users),
      auditRows: structuredClone(this.auditRows),
      locked: this.locked,
    };
    try {
      return await callback(this);
    } catch (error) {
      this.admins = snapshot.admins;
      this.users = snapshot.users;
      this.auditRows = snapshot.auditRows;
      this.locked = snapshot.locked;
      throw error;
    }
  }

  async $disconnect() {
    this.disconnectCount += 1;
  }
}

function captureOutput() {
  return {
    text: '',
    write(value) {
      this.text += value;
    },
  };
}

test('bootstrap creates the first active ADMIN and audit row atomically', async () => {
  const prisma = new BootstrapFakePrisma();
  const result = await bootstrapAdmin({
    prisma,
    directUrl: DIRECT_URL,
    confirmation: CONFIRMATION,
    credentials: CREDENTIALS,
    requestId: '00000000-0000-4000-8000-000000000001',
    passwordHasher: async (password) => `hashed:${password}`,
  });

  assert.deepEqual(result, {
    id: result.id,
    role: 'ADMIN',
    status: 'ACTIVE',
    mustChangePassword: true,
  });
  assert.equal(prisma.users.length, 1);
  assert.equal(prisma.users[0].email, 'admin@example.test');
  assert.equal(prisma.users[0].fullName, 'First Administrator');
  assert.equal(prisma.users[0].passwordHash, `hashed:${CREDENTIALS.password}`);
  assert.equal(prisma.auditRows.length, 1);
  assert.equal(prisma.auditRows[0].actorId, result.id);
  assert.equal(prisma.auditRows[0].action, 'admin.bootstrap.create');
  assert.equal(prisma.auditRows[0].targetId, result.id);
  assert.equal(prisma.auditRows[0].metadata.reasonCode, 'FIRST_ADMIN_BOOTSTRAPPED');
  assert.equal(JSON.stringify(prisma.auditRows[0]).includes(CREDENTIALS.password), false);
});

test('bootstrap refuses an existing ADMIN inside the locked transaction', async () => {
  const prisma = new BootstrapFakePrisma({ existingAdmins: 1 });
  await assert.rejects(
    bootstrapAdmin({
      prisma,
      directUrl: DIRECT_URL,
      confirmation: CONFIRMATION,
      credentials: CREDENTIALS,
    }),
    (error) => error instanceof BootstrapError && error.code === 'ADMIN_ALREADY_EXISTS',
  );
  assert.equal(prisma.transactionCount, 1);
  assert.equal(prisma.users.length, 0);
  assert.equal(prisma.auditRows.length, 0);
});

test('invalid credentials are rejected before opening a write transaction', async () => {
  const prisma = new BootstrapFakePrisma();
  await assert.rejects(
    bootstrapAdmin({
      prisma,
      directUrl: DIRECT_URL,
      confirmation: CONFIRMATION,
      credentials: { ...CREDENTIALS, password: 'weak' },
    }),
    (error) => error instanceof BootstrapError && error.code === 'INVALID_CREDENTIALS',
  );
  assert.equal(prisma.transactionCount, 0);
  assert.equal(prisma.users.length, 0);
});

test('identity and explicit target confirmation prevent development-database writes', async () => {
  const prisma = new BootstrapFakePrisma();
  await assert.rejects(
    bootstrapAdmin({
      prisma,
      directUrl: 'postgresql://postgres:ignored@localhost:5432/balancevault_dev',
      confirmation: CONFIRMATION,
      credentials: CREDENTIALS,
    }),
    (error) => error instanceof BootstrapError
      && error.code === 'DIRECT_URL_DATABASE_NOT_ALLOWED',
  );
  await assert.rejects(
    bootstrapAdmin({
      prisma,
      directUrl: DIRECT_URL,
      confirmation: 'balancevault_dev',
      credentials: CREDENTIALS,
    }),
    (error) => error instanceof BootstrapError && error.code === 'DATABASE_CONFIRMATION_REQUIRED',
  );
  await assert.rejects(
    bootstrapAdmin({
      prisma: new BootstrapFakePrisma({ identity: { database_name: 'balancevault_dev' } }),
      directUrl: DIRECT_URL,
      confirmation: CONFIRMATION,
      credentials: CREDENTIALS,
    }),
    (error) => error instanceof BootstrapError && error.code === 'CONNECTED_DATABASE_NOT_ALLOWED',
  );
  assert.equal(prisma.transactionCount, 0);
});

test('audit failure rolls back the new admin user', async () => {
  const prisma = new BootstrapFakePrisma({ failAudit: true });
  await assert.rejects(
    bootstrapAdmin({
      prisma,
      directUrl: DIRECT_URL,
      confirmation: CONFIRMATION,
      credentials: CREDENTIALS,
      passwordHasher: async () => 'synthetic-hash',
    }),
    /synthetic audit failure/u,
  );
  assert.equal(prisma.users.length, 0);
  assert.equal(prisma.admins.length, 0);
  assert.equal(prisma.auditRows.length, 0);
});

test('CLI errors never echo credentials, connection strings, or internal exception details', async () => {
  const secretText = `${CREDENTIALS.password} ${DIRECT_URL}`;
  const prisma = new BootstrapFakePrisma();
  prisma.$queryRaw = async () => {
    throw new Error(`database failure: ${secretText}`);
  };
  const output = captureOutput();
  const errorOutput = captureOutput();
  const exitCode = await runBootstrapCli({
    environment: {
      DIRECT_URL,
      BV_BOOTSTRAP_CONFIRM_DATABASE: CONFIRMATION,
      BV_BOOTSTRAP_EMAIL: CREDENTIALS.email,
      BV_BOOTSTRAP_FULL_NAME: CREDENTIALS.fullName,
      BV_BOOTSTRAP_PASSWORD: CREDENTIALS.password,
    },
    input: { isTTY: false },
    output,
    errorOutput,
    createClient: () => prisma,
  });

  assert.equal(exitCode, 1);
  assert.equal(prisma.transactionCount, 0);
  assert.equal(output.text.includes(secretText), false);
  assert.equal(errorOutput.text.includes(CREDENTIALS.password), false);
  assert.equal(errorOutput.text.includes(DIRECT_URL), false);
  assert.equal(errorOutput.text.includes('database failure'), false);
  assert.equal(prisma.disconnectCount, 1);
  assert.match(safeFailureMessage(new Error(secretText)), /failed safely/u);
});

test('CLI requires explicit test-database confirmation before creating a client', async () => {
  let createdClient = false;
  const errorOutput = captureOutput();
  const exitCode = await runBootstrapCli({
    environment: { DIRECT_URL },
    input: { isTTY: false },
    output: captureOutput(),
    errorOutput,
    createClient: () => {
      createdClient = true;
      return new BootstrapFakePrisma();
    },
  });
  assert.equal(exitCode, 1);
  assert.equal(createdClient, false);
  assert.match(errorOutput.text, /DATABASE_CONFIRMATION_REQUIRED/u);
});

test('preflight verifies identity without reading credentials or opening a write transaction', async () => {
  const prisma = new BootstrapFakePrisma();
  const output = captureOutput();
  const errorOutput = captureOutput();
  const exitCode = await runBootstrapCli({
    environment: {
      DIRECT_URL,
      BV_BOOTSTRAP_CONFIRM_DATABASE: CONFIRMATION,
    },
    input: { isTTY: false },
    output,
    errorOutput,
    preflight: true,
    createClient: () => prisma,
  });
  assert.equal(exitCode, 0);
  assert.match(output.text, /database=balancevault_test role=postgres; no writes performed/u);
  assert.equal(prisma.transactionCount, 0);
  assert.equal(prisma.users.length, 0);
  assert.equal(prisma.auditRows.length, 0);
  assert.equal(prisma.disconnectCount, 1);
});
