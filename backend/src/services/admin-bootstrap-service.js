import { randomUUID } from 'node:crypto';
import { adminBootstrapCredentialsSchema } from '../auth/admin-bootstrap-validation.js';
import { hashPassword } from '../auth/password.js';
import { recordAudit } from './audit-service.js';

const TEST_DATABASE = 'balancevault_test';
const OWNER_ROLE = 'postgres';

class BootstrapError extends Error {
  constructor(code) {
    super(code);
    this.name = 'BootstrapError';
    this.code = code;
  }
}

function assertDirectUrlTarget(directUrl, confirmation) {
  if (typeof directUrl !== 'string' || directUrl.length === 0) {
    throw new BootstrapError('DIRECT_URL_REQUIRED');
  }

  let parsed;
  try {
    parsed = new URL(directUrl);
  } catch {
    throw new BootstrapError('DIRECT_URL_INVALID');
  }

  let databaseName;
  let roleName;
  try {
    databaseName = decodeURIComponent(parsed.pathname.slice(1));
    roleName = decodeURIComponent(parsed.username);
  } catch {
    throw new BootstrapError('DIRECT_URL_INVALID');
  }

  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) {
    throw new BootstrapError('DIRECT_URL_INVALID');
  }
  if (databaseName !== TEST_DATABASE) {
    throw new BootstrapError('DIRECT_URL_DATABASE_NOT_ALLOWED');
  }
  if (roleName !== OWNER_ROLE) {
    throw new BootstrapError('OWNER_ROLE_REQUIRED');
  }
  if (confirmation !== TEST_DATABASE) {
    throw new BootstrapError('DATABASE_CONFIRMATION_REQUIRED');
  }
}

async function verifyDatabaseIdentity(prisma) {
  const [identity] = await prisma.$queryRaw`
    SELECT current_database() AS database_name, current_user AS role_name
  `;
  if (identity?.database_name !== TEST_DATABASE) {
    throw new BootstrapError('CONNECTED_DATABASE_NOT_ALLOWED');
  }
  if (identity?.role_name !== OWNER_ROLE) {
    throw new BootstrapError('CONNECTED_ROLE_NOT_ALLOWED');
  }
  return identity;
}

async function bootstrapAdmin({
  prisma,
  directUrl,
  confirmation,
  credentials,
  requestId = randomUUID(),
  passwordHasher = hashPassword,
}) {
  if (!prisma || typeof prisma.$queryRaw !== 'function') {
    throw new TypeError('bootstrapAdmin requires a direct Prisma client.');
  }
  assertDirectUrlTarget(directUrl, confirmation);
  await verifyDatabaseIdentity(prisma);

  const parsedCredentials = adminBootstrapCredentialsSchema.safeParse(credentials);
  if (!parsedCredentials.success) {
    throw new BootstrapError('INVALID_CREDENTIALS');
  }

  const passwordHash = await passwordHasher(parsedCredentials.data.password);
  const adminId = randomUUID();

  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`
      LOCK TABLE public."User" IN SHARE ROW EXCLUSIVE MODE
    `;

    const adminCount = await tx.user.count({ where: { role: 'ADMIN' } });
    if (adminCount > 0) {
      throw new BootstrapError('ADMIN_ALREADY_EXISTS');
    }

    const user = await tx.user.create({
      data: {
        id: adminId,
        email: parsedCredentials.data.email,
        fullName: parsedCredentials.data.fullName,
        passwordHash,
        role: 'ADMIN',
        status: 'ACTIVE',
        mustChangePassword: true,
      },
      select: { id: true, role: true, status: true, mustChangePassword: true },
    });

    if (
      user.id !== adminId
      || user.role !== 'ADMIN'
      || user.status !== 'ACTIVE'
      || user.mustChangePassword !== true
    ) {
      throw new BootstrapError('ADMIN_READBACK_FAILED');
    }

    await recordAudit(tx, {
      actorId: adminId,
      action: 'admin.bootstrap.create',
      outcome: 'SUCCESS',
      requestId,
      targetType: 'User',
      targetId: adminId,
      metadata: { reasonCode: 'FIRST_ADMIN_BOOTSTRAPPED' },
    });

    return { id: adminId, role: 'ADMIN', status: 'ACTIVE', mustChangePassword: true };
  }, { timeout: 15_000 });
}

export {
  BootstrapError,
  TEST_DATABASE,
  assertDirectUrlTarget,
  bootstrapAdmin,
  verifyDatabaseIdentity,
};
