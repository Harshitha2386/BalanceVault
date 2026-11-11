import { randomUUID } from 'node:crypto';
import { getPrismaClient } from '../src/prisma.js';
import { hashSessionToken } from '../src/auth/token.js';
import { loginUser, logoutSession, registerUser } from '../src/services/auth-service.js';

function transactionScopedClient(transaction) {
  return new Proxy(transaction, {
    get(target, property) {
      if (property === '$transaction') {
        return (callback) => callback(transactionScopedClient(target));
      }
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('Auth integration stopped: DATABASE_URL is required.');
  process.exitCode = 1;
} else {
  const prisma = getPrismaClient(databaseUrl);
  const rollbackMarker = new Error('AUTH_INTEGRATION_ROLLBACK');
  const email = `auth-integration+${randomUUID()}@example.test`;
  const password = 'Synthetic-Integration-Password-947!';
  const context = { requestId: randomUUID(), ipAddress: '127.0.0.1' };
  let userId;
  let sessionHash;
  let step = 'checking database and role';

  try {
    const [identity] = await prisma.$queryRaw`
      SELECT current_database() AS database_name, current_user AS role_name
    `;
    console.log(`Runtime connection identity: database=${identity.database_name} role=${identity.role_name}`);
    if (identity.database_name !== 'balancevault_test' || identity.role_name !== 'bv_app') {
      throw new Error('Auth integration stopped: expected balancevault_test as bv_app.');
    }

    try {
      await prisma.$transaction(async (transaction) => {
        const client = transactionScopedClient(transaction);
        step = 'registration through restricted User columns';
        const user = await registerUser(client, {
          email,
          fullName: 'Synthetic Authentication Integration',
          password,
        }, context);
        userId = user.id;
        if (user.role !== 'ACCOUNT_HOLDER' || user.status !== 'ACTIVE') {
          throw new Error('Registration defaults did not match.');
        }

        step = 'duplicate email rejection';
        try {
          await registerUser(client, {
            email,
            fullName: 'Synthetic Authentication Integration',
            password,
          }, context);
          throw new Error('Duplicate registration unexpectedly succeeded.');
        } catch (error) {
          if (error?.code !== 'REGISTRATION_UNAVAILABLE') {
            throw error;
          }
        }

        step = 'login and Session creation';
        const login = await loginUser(client, { email, password }, context, null);
        sessionHash = hashSessionToken(login.token);

        step = 'Session SELECT and authentication';
        const session = await client.session.findUnique({
          where: { tokenHash: sessionHash },
          include: { user: { select: { id: true, status: true } } },
        });
        if (!session || session.user.id !== user.id || session.user.status !== 'ACTIVE') {
          throw new Error('Session authentication read-back failed.');
        }

        step = 'logout and Session revocation';
        await logoutSession(client, session, user, context);
        const revoked = await client.session.findUnique({
          where: { tokenHash: sessionHash },
          select: { revokedAt: true },
        });
        if (!revoked?.revokedAt) {
          throw new Error('Session revocation read-back failed.');
        }

        throw rollbackMarker;
      });
    } catch (error) {
      if (error !== rollbackMarker) {
        const code = error && typeof error.code === 'string'
          ? error.code
          : error && typeof error.meta?.code === 'string'
            ? error.meta.code
            : 'unknown';
        throw new Error(`Auth integration failed at ${step} (Prisma code: ${code}).`);
      }
    }

    const [persistedUser, persistedSession, persistedAuditCount] = await Promise.all([
      prisma.user.findUnique({ where: { id: userId }, select: { id: true } }),
      prisma.session.findUnique({ where: { tokenHash: sessionHash }, select: { id: true } }),
      prisma.auditLog.count({ where: { requestId: context.requestId } }),
    ]);

    if (persistedUser || persistedSession || persistedAuditCount !== 0) {
      throw new Error('Auth integration rollback verification failed.');
    }

    console.log('PASS: registration, login, Session lifecycle and audit writes succeeded.');
    console.log('PASS: synthetic User, Session and AuditLog records were rolled back and are absent.');
  } catch (error) {
    console.error(error.message || 'Auth integration failed without exposing database details.');
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}
