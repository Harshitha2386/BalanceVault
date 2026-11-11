import { randomUUID } from 'node:crypto';
import { AppError } from '../middleware/error-handler.js';
import { hashPassword, verifyPassword } from '../auth/password.js';
import { createSessionToken, hashSessionToken } from '../auth/token.js';
import { assertPermission } from '../auth/authorization.js';
import { recordAudit } from './audit-service.js';
import { safeUserSelect } from './session-service.js';

const INVALID_CREDENTIALS = 'Invalid email or password.';
const MAX_FAILED_LOGINS = 5;
const LOCKOUT_MS = 15 * 60 * 1000;
const SESSION_ABSOLUTE_MS = 12 * 60 * 60 * 1000;
const dummyHashPromise = hashPassword('BalanceVault-Dummy-Password-Not-A-User-9!');

function auditContext(req) {
  return {
    requestId: req.requestId,
    ipAddress: typeof req.ip === 'string' ? req.ip.slice(0, 64) : null,
  };
}

async function writeAudit(prisma, actorId, action, outcome, context, reasonCode) {
  await recordAudit(prisma, {
    actorId,
    action,
    outcome,
    ...context,
    metadata: reasonCode ? { reasonCode } : undefined,
  });
}

async function registerUser(prisma, input, context) {
  const passwordHash = await hashPassword(input.password);
  const id = randomUUID();
  const now = new Date();

  const result = await prisma.$transaction(async (tx) => {
    const inserted = await tx.$queryRaw`
      INSERT INTO public."User" (
        "id", "email", "fullName", "passwordHash", "updatedAt"
      )
      VALUES (
        ${id}::uuid,
        ${input.email},
        ${input.fullName},
        ${passwordHash},
        ${now}
      )
      ON CONFLICT ("email") DO NOTHING
      RETURNING "id", "email"
    `;
    if (inserted.length === 0) {
      await recordAudit(tx, {
        actorId: null,
        action: 'auth.register',
        outcome: 'DENIED',
        ...context,
        metadata: { reasonCode: 'EMAIL_UNAVAILABLE' },
      });
      return { duplicate: true };
    }

    const insertedUser = inserted[0];
    const user = await tx.user.findUnique({
      where: { id: insertedUser.id },
      select: safeUserSelect,
    });
    if (!user || user.email !== input.email || user.id !== insertedUser.id) {
      throw new Error('Registration read-back failed.');
    }

    await recordAudit(tx, {
      actorId: user.id,
      action: 'auth.register',
      outcome: 'SUCCESS',
      ...context,
    });
    return { duplicate: false, user };
  });

  if (result.duplicate) {
    throw new AppError(409, 'REGISTRATION_UNAVAILABLE', 'Registration could not be completed.');
  }
  return result.user;
}

async function recordFailedLogin(prisma, userId, context) {
  await prisma.$transaction(async (tx) => {
    const now = new Date();
    const current = await tx.user.findUnique({
      where: { id: userId },
      select: { id: true, status: true, lockedUntil: true },
    });

    if (!current || current.status !== 'ACTIVE') {
      await recordAudit(tx, {
        actorId: userId,
        action: 'auth.login',
        outcome: 'DENIED',
        ...context,
        metadata: { reasonCode: 'INACTIVE_ACCOUNT' },
      });
      return;
    }

    if (current.lockedUntil && new Date(current.lockedUntil) > now) {
      await recordAudit(tx, {
        actorId: userId,
        action: 'auth.login',
        outcome: 'DENIED',
        ...context,
        metadata: { reasonCode: 'ACCOUNT_LOCKED' },
      });
      return;
    }

    if (current.lockedUntil) {
      await tx.user.update({
        where: { id: userId },
        data: { failedLoginCount: 0, lockedUntil: null, updatedAt: now },
        select: { id: true },
      });
    }

    const updated = await tx.user.update({
      where: { id: userId },
      data: { failedLoginCount: { increment: 1 }, updatedAt: now },
      select: { failedLoginCount: true },
    });

    if (updated.failedLoginCount >= MAX_FAILED_LOGINS) {
      await tx.user.update({
        where: { id: userId },
        data: { lockedUntil: new Date(now.getTime() + LOCKOUT_MS), updatedAt: now },
        select: { id: true },
      });
    }

    await recordAudit(tx, {
      actorId: userId,
      action: 'auth.login',
      outcome: 'DENIED',
      ...context,
      metadata: {
        reasonCode: updated.failedLoginCount >= MAX_FAILED_LOGINS
          ? 'ACCOUNT_LOCKED'
          : 'INVALID_CREDENTIALS',
      },
    });
  });
}

async function denyLogin(prisma, userId, context, reasonCode) {
  await writeAudit(prisma, userId, 'auth.login', 'DENIED', context, reasonCode);
  throw new AppError(401, 'INVALID_CREDENTIALS', INVALID_CREDENTIALS);
}

async function loginUser(prisma, input, context, previousSessionToken) {
  const user = await prisma.user.findUnique({
    where: { email: input.email },
    select: {
      ...safeUserSelect,
      passwordHash: true,
      failedLoginCount: true,
      lockedUntil: true,
    },
  });
  const candidateHash = user ? user.passwordHash : await dummyHashPromise;
  const passwordMatches = await verifyPassword(input.password, candidateHash);
  const now = new Date();

  if (!user) {
    await writeAudit(prisma, null, 'auth.login', 'DENIED', context, 'INVALID_CREDENTIALS');
    throw new AppError(401, 'INVALID_CREDENTIALS', INVALID_CREDENTIALS);
  }

  if (user.status !== 'ACTIVE') {
    await denyLogin(prisma, user.id, context, 'INACTIVE_ACCOUNT');
  }
  if (user.lockedUntil && new Date(user.lockedUntil) > now) {
    await denyLogin(prisma, user.id, context, 'ACCOUNT_LOCKED');
  }
  if (!passwordMatches) {
    await recordFailedLogin(prisma, user.id, context);
    throw new AppError(401, 'INVALID_CREDENTIALS', INVALID_CREDENTIALS);
  }

  const token = createSessionToken();
  const tokenHash = hashSessionToken(token);
  const oldTokenHash = previousSessionToken
    ? hashSessionToken(previousSessionToken)
    : null;

  const result = await prisma.$transaction(async (tx) => {
    const current = await tx.user.findUnique({
      where: { id: user.id },
      select: {
        ...safeUserSelect,
        passwordHash: true,
        lockedUntil: true,
      },
    });

    if (
      !current
      || current.status !== 'ACTIVE'
      || current.passwordHash !== user.passwordHash
      || (current.lockedUntil && new Date(current.lockedUntil) > new Date())
    ) {
      await recordAudit(tx, {
        actorId: user.id,
        action: 'auth.login',
        outcome: 'DENIED',
        ...context,
        metadata: { reasonCode: 'ACCOUNT_STATE_CHANGED' },
      });
      return { denied: true };
    }

    const safeUser = await tx.user.update({
      where: { id: user.id },
      data: { failedLoginCount: 0, lockedUntil: null, updatedAt: new Date() },
      select: safeUserSelect,
    });

    if (oldTokenHash) {
      await tx.session.updateMany({
        where: { tokenHash: oldTokenHash, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    }

    const expiresAt = new Date(Date.now() + SESSION_ABSOLUTE_MS);
    await tx.session.create({
      data: { tokenHash, userId: user.id, expiresAt },
      select: { id: true },
    });
    await recordAudit(tx, {
      actorId: user.id,
      action: 'auth.login',
      outcome: 'SUCCESS',
      ...context,
    });

    return { denied: false, token, user: safeUser, expiresAt };
  });

  if (result.denied) {
    throw new AppError(401, 'INVALID_CREDENTIALS', INVALID_CREDENTIALS);
  }
  return result;
}

async function logoutSession(prisma, session, user, context) {
  assertPermission(user, 'SESSION_END');
  if (!session || session.userId !== user.id) {
    throw new AppError(404, 'RESOURCE_NOT_FOUND', 'The requested session was not found.');
  }

  await prisma.$transaction(async (tx) => {
    await tx.session.updateMany({
      where: { id: session.id, userId: user.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    await recordAudit(tx, {
      actorId: user.id,
      action: 'auth.logout',
      outcome: 'SUCCESS',
      ...context,
    });
  });
}

export { loginUser, logoutSession, registerUser };
