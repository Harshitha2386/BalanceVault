import { assertPermission } from '../auth/authorization.js';
import { AppError } from '../middleware/error-handler.js';
import { recordAudit } from './audit-service.js';

const ADMIN_USER_SELECT = {
  id: true,
  email: true,
  fullName: true,
  role: true,
  status: true,
  createdAt: true,
  updatedAt: true,
};

const AUDIT_LOG_SELECT = {
  id: true,
  actorId: true,
  action: true,
  targetType: true,
  targetId: true,
  outcome: true,
  metadata: true,
  createdAt: true,
};

function userAudit(tx, actor, context, targetId, outcome, reasonCode) {
  return recordAudit(tx, {
    actorId: actor.id,
    action: 'admin.user.status.change',
    outcome,
    requestId: context.requestId,
    ipAddress: context.ipAddress,
    targetType: 'User',
    targetId,
    metadata: reasonCode ? { reasonCode } : undefined,
  });
}

function auditRead(prisma, actor, context) {
  return recordAudit(prisma, {
    actorId: actor.id,
    action: 'admin.audit.read',
    outcome: 'SUCCESS',
    requestId: context.requestId,
    ipAddress: context.ipAddress,
    targetType: 'AuditLog',
  });
}

async function listAdminUsers(prisma, actor, { status, role, page, limit }) {
  assertPermission(actor, 'ADMIN_USERS_READ');
  const where = {
    ...(status ? { status } : {}),
    ...(role ? { role } : {}),
  };
  const [users, total] = await Promise.all([
    prisma.user.findMany({
      where,
      skip: (page - 1) * limit,
      take: limit,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: ADMIN_USER_SELECT,
    }),
    prisma.user.count({ where }),
  ]);
  return { users, pagination: { page, limit, total } };
}

async function getAdminUser(prisma, actor, id) {
  assertPermission(actor, 'ADMIN_USERS_READ');
  const user = await prisma.user.findUnique({
    where: { id },
    select: ADMIN_USER_SELECT,
  });
  if (!user) {
    throw new AppError(404, 'USER_NOT_FOUND', 'The user was not found.');
  }
  return user;
}

function statusFailure(result) {
  if (result.failure === 'ACTOR_INACTIVE') {
    return new AppError(403, 'FORBIDDEN', 'You are not allowed to perform this action.');
  }
  if (result.failure === 'NOT_FOUND') {
    return new AppError(404, 'USER_NOT_FOUND', 'The user was not found.');
  }
  if (result.failure === 'SELF_DISABLE') {
    return new AppError(409, 'SELF_DISABLE_DENIED', 'Administrators cannot disable their own account.');
  }
  if (result.failure === 'LAST_ACTIVE_ADMIN') {
    return new AppError(409, 'LAST_ACTIVE_ADMIN', 'The last active administrator cannot be disabled.');
  }
  if (result.failure === 'UNCHANGED') {
    return new AppError(409, 'USER_STATUS_UNCHANGED', 'The user already has that status.');
  }
  if (result.failure === 'CONCURRENT_CHANGE') {
    return new AppError(409, 'USER_STATUS_CONFLICT', 'The user status changed concurrently.');
  }
  return null;
}

async function changeUserStatus(prisma, actor, id, status, context) {
  assertPermission(actor, 'ADMIN_USER_ACCESS_MANAGE');

  let result;
  try {
    result = await prisma.$transaction(async (tx) => {
      const currentActor = await tx.user.findUnique({
        where: { id: actor.id },
        select: { id: true, role: true, status: true },
      });
      if (!currentActor || currentActor.role !== 'ADMIN' || currentActor.status !== 'ACTIVE') {
        await userAudit(tx, actor, context, id, 'DENIED', 'ACTOR_INACTIVE');
        return { failure: 'ACTOR_INACTIVE' };
      }

      const user = await tx.user.findUnique({
        where: { id },
        select: { id: true, role: true, status: true },
      });
      if (!user) {
        await userAudit(tx, actor, context, id, 'DENIED', 'USER_NOT_FOUND');
        return { failure: 'NOT_FOUND' };
      }
      if (user.status === status) {
        await userAudit(tx, actor, context, id, 'DENIED', 'USER_STATUS_UNCHANGED');
        return { failure: 'UNCHANGED' };
      }

      if (status === 'DISABLED' && user.role === 'ADMIN' && user.status === 'ACTIVE') {
        const activeAdmins = await tx.user.count({
          where: { role: 'ADMIN', status: 'ACTIVE' },
        });
        if (activeAdmins <= 1) {
          await userAudit(tx, actor, context, id, 'DENIED', 'LAST_ACTIVE_ADMIN');
          return { failure: 'LAST_ACTIVE_ADMIN' };
        }
      }
      if (id === actor.id && status === 'DISABLED') {
        await userAudit(tx, actor, context, id, 'DENIED', 'SELF_DISABLE');
        return { failure: 'SELF_DISABLE' };
      }

      const changed = await tx.user.updateMany({
        where: { id, status: user.status },
        data: { status, updatedAt: new Date() },
      });
      if (changed.count !== 1) {
        await userAudit(tx, actor, context, id, 'DENIED', 'CONCURRENT_CHANGE');
        return { failure: 'CONCURRENT_CHANGE' };
      }

      if (status === 'DISABLED') {
        await tx.session.updateMany({
          where: { userId: id, revokedAt: null },
          data: { revokedAt: new Date() },
        });
      }

      const updatedUser = await tx.user.findUnique({
        where: { id },
        select: ADMIN_USER_SELECT,
      });
      await userAudit(tx, actor, context, id, 'SUCCESS');
      return { user: updatedUser };
    }, { isolationLevel: 'Serializable', timeout: 10_000 });
  } catch (error) {
    if (error?.code !== 'P2034') {
      throw error;
    }
    await recordAudit(prisma, {
      actorId: actor.id,
      action: 'admin.user.status.change',
      outcome: 'FAILURE',
      requestId: context.requestId,
      ipAddress: context.ipAddress,
      targetType: 'User',
      targetId: id,
      metadata: { reasonCode: 'SERIALIZATION_CONFLICT' },
    });
    throw new AppError(409, 'USER_STATUS_CONFLICT', 'The user status changed concurrently.');
  }

  const failure = statusFailure(result);
  if (failure) {
    throw failure;
  }
  return result.user;
}

function toAuditLogDto(row) {
  return {
    ...row,
    id: row.id.toString(),
  };
}

async function listAdminAuditLogs(prisma, actor, filters, context) {
  assertPermission(actor, 'ADMIN_AUDIT_READ');
  const where = {
    ...(filters.action ? { action: filters.action } : {}),
    ...(filters.outcome ? { outcome: filters.outcome } : {}),
    ...(filters.targetType ? { targetType: filters.targetType } : {}),
  };
  const [rows, total] = await Promise.all([
    prisma.auditLog.findMany({
      where,
      skip: (filters.page - 1) * filters.limit,
      take: filters.limit,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: AUDIT_LOG_SELECT,
    }),
    prisma.auditLog.count({ where }),
  ]);
  await auditRead(prisma, actor, context);
  return {
    auditLogs: rows.map(toAuditLogDto),
    pagination: { page: filters.page, limit: filters.limit, total },
  };
}

export {
  ADMIN_USER_SELECT,
  AUDIT_LOG_SELECT,
  changeUserStatus,
  getAdminUser,
  listAdminAuditLogs,
  listAdminUsers,
};
