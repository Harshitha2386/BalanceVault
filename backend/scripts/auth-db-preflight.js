import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { getPrismaClient } from '../src/prisma.js';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('Preflight stopped: DATABASE_URL is required.');
  process.exitCode = 1;
} else {
  const prisma = getPrismaClient(databaseUrl);
  let step = 'checking database and role';
  const userId = randomUUID();
  const email = `auth-preflight+${userId}@example.test`;
  const rawToken = randomBytes(32);
  const tokenHash = createHash('sha256').update(rawToken).digest('hex');
  const rollbackMarker = new Error('AUTH_PREFLIGHT_ROLLBACK');

  try {
    const [connection] = await prisma.$queryRaw`
      SELECT current_database() AS database_name, current_user AS role_name
    `;

    console.log(`Runtime connection identity: database=${connection.database_name} role=${connection.role_name}`);

    if (connection.database_name !== 'balancevault_test') {
      throw new Error('Preflight stopped: active database is not balancevault_test.');
    }
    if (connection.role_name !== 'bv_app') {
      throw new Error('Preflight stopped: runtime role is not bv_app.');
    }

    console.log('Verified runtime connection is restricted to the test database and application role.');

    try {
      await prisma.$transaction(async (tx) => {
        step = 'User INSERT and SELECT';
        const insertedRows = await tx.$executeRaw`
          INSERT INTO public."User" (
            "id", "email", "fullName", "passwordHash", "updatedAt"
          )
          VALUES (
            ${userId}::uuid,
            ${email},
            ${'Synthetic Auth Preflight'},
            ${'temporary-preflight-placeholder'},
            ${new Date()}
          )
        `;

        if (insertedRows !== 1) {
          throw new Error('User preflight insert did not insert exactly one row.');
        }

        const user = await tx.user.findUnique({
          where: { id: userId },
          select: {
            id: true,
            email: true,
            role: true,
            status: true,
            failedLoginCount: true,
          },
        });

        if (
          !user
          || user.email !== email
          || user.role !== 'ACCOUNT_HOLDER'
          || user.status !== 'ACTIVE'
          || user.failedLoginCount !== 0
        ) {
          throw new Error('User preflight read-back or database defaults did not match.');
        }

        step = 'User lockout UPDATE';
        await tx.user.update({
          where: { id: user.id },
          data: {
            failedLoginCount: 1,
            lockedUntil: new Date(Date.now() + 60_000),
          },
          select: { id: true },
        });

        step = 'Session INSERT and SELECT';
        const session = await tx.session.create({
          data: {
            tokenHash,
            userId: user.id,
            expiresAt: new Date(Date.now() + 60_000),
          },
          select: { id: true, tokenHash: true, userId: true },
        });

        if (session.tokenHash !== tokenHash || session.userId !== user.id) {
          throw new Error('Session preflight read-back did not match.');
        }

        step = 'Session lastSeenAt and revokedAt UPDATE';
        await tx.session.update({
          where: { id: session.id },
          data: { lastSeenAt: new Date(), revokedAt: new Date() },
          select: { id: true },
        });

        step = 'Session DELETE permission';
        await tx.session.delete({ where: { id: session.id } });

        throw rollbackMarker;
      });
    } catch (error) {
      if (error !== rollbackMarker) {
        const code = error && typeof error.code === 'string'
          ? error.code
          : error && typeof error.meta?.code === 'string'
            ? error.meta.code
            : 'unknown';
        throw new Error(`Preflight failed at ${step} (Prisma code: ${code}).`);
      }
    }

    const [persistedUser, persistedSession] = await Promise.all([
      prisma.user.findUnique({
        where: { id: userId },
        select: { id: true },
      }),
      prisma.session.findUnique({
        where: { tokenHash },
        select: { id: true },
      }),
    ]);

    if (persistedUser || persistedSession) {
      throw new Error('Preflight rollback verification failed: synthetic records remain.');
    }

    console.log('PASS: User defaults and Session lifecycle permissions work.');
    console.log('PASS: synthetic User and Session records were rolled back and are absent.');
  } catch (error) {
    console.error(error.message || 'Preflight failed without exposing database details.');
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}
