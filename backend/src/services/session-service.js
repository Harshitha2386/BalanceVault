import { AppError } from '../middleware/error-handler.js';
import { getCookie } from '../auth/cookies.js';
import { hashSessionToken } from '../auth/token.js';

const IDLE_TIMEOUT_MS = 30 * 60 * 1000;
const ABSOLUTE_TIMEOUT_MS = 12 * 60 * 60 * 1000;
const TOUCH_INTERVAL_MS = 5 * 60 * 1000;

const safeUserSelect = {
  id: true,
  email: true,
  fullName: true,
  role: true,
  status: true,
  mustChangePassword: true,
  createdAt: true,
};

async function resolveSession(req, prisma, { touch = false } = {}) {
  const rawToken = getCookie(req, 'bv_session');
  if (!rawToken || rawToken.length > 128) {
    return null;
  }

  const session = await prisma.session.findUnique({
    where: { tokenHash: hashSessionToken(rawToken) },
    include: { user: { select: safeUserSelect } },
  });
  if (!session) {
    return null;
  }

  const now = Date.now();
  const lastSeen = new Date(session.lastSeenAt).getTime();
  const createdAt = new Date(session.createdAt).getTime();
  const expiresAt = new Date(session.expiresAt).getTime();
  if (
    session.revokedAt
    || session.user.status !== 'ACTIVE'
    || !Number.isFinite(lastSeen)
    || !Number.isFinite(createdAt)
    || !Number.isFinite(expiresAt)
    || now - lastSeen >= IDLE_TIMEOUT_MS
    || now - createdAt >= ABSOLUTE_TIMEOUT_MS
    || expiresAt <= now
  ) {
    return null;
  }

  if (touch && now - lastSeen >= TOUCH_INTERVAL_MS) {
    await prisma.session.updateMany({
      where: {
        id: session.id,
        revokedAt: null,
        lastSeenAt: { lte: new Date(now - TOUCH_INTERVAL_MS) },
      },
      data: { lastSeenAt: new Date(now) },
    });
  }

  return session;
}

function requireAuthentication(prisma) {
  return async function authentication(req, res, next) {
    try {
      const session = await resolveSession(req, prisma, { touch: true });
      if (!session) {
        throw new AppError(401, 'AUTH_REQUIRED', 'Authentication is required.');
      }
      req.auth = { session, user: session.user };
      return next();
    } catch (error) {
      return next(error);
    }
  };
}

export {
  ABSOLUTE_TIMEOUT_MS,
  IDLE_TIMEOUT_MS,
  requireAuthentication,
  resolveSession,
  safeUserSelect,
};
