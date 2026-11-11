import { randomBytes, randomUUID } from 'node:crypto';
import { assertPermission, customerResourceWhere } from '../auth/authorization.js';
import { AppError } from '../middleware/error-handler.js';
import { recordAudit } from './audit-service.js';

const ACCOUNT_SELECT = {
  id: true,
  accountNumber: true,
  kind: true,
  status: true,
  currency: true,
  balanceMinor: true,
  createdAt: true,
  updatedAt: true,
};

const ADMIN_ACCOUNT_SELECT = {
  ...ACCOUNT_SELECT,
  owner: {
    select: { id: true, fullName: true, email: true },
  },
};
const ACCOUNT_PROVISION_SELECT = { ...ACCOUNT_SELECT, ownerId: true };

const STATUS_TRANSITIONS = Object.freeze({
  ACTIVE: Object.freeze(['FROZEN', 'CLOSED']),
  FROZEN: Object.freeze(['ACTIVE', 'CLOSED']),
  CLOSED: Object.freeze([]),
});

function toAccountDto(account) {
  if (!account) {
    return null;
  }
  return {
    ...account,
    balanceMinor: account.balanceMinor.toString(),
  };
}

function accountNumber() {
  return `BV${randomBytes(10).toString('hex').toUpperCase()}`;
}

function accountAudit(client, actor, context, action, accountId, outcome = 'SUCCESS', reasonCode) {
  return recordAudit(client, {
    actorId: actor.id,
    action,
    outcome,
    requestId: context.requestId,
    ipAddress: context.ipAddress,
    targetType: 'Account',
    targetId: accountId,
    metadata: reasonCode ? { reasonCode } : undefined,
  });
}

async function provisionApprovedApplicationAccount(tx, actor, applicationId, context) {
  assertPermission(actor, 'ADMIN_ONBOARDING_REVIEW');

  const application = await tx.onboardingApplication.findUnique({
    where: { id: applicationId },
    select: { id: true, userId: true, status: true },
  });
  if (!application) {
    throw new AppError(404, 'APPLICATION_NOT_FOUND', 'The application was not found.');
  }
  if (application.status !== 'APPROVED') {
    throw new AppError(409, 'APPLICATION_NOT_APPROVED', 'Only approved applications can create an account.');
  }

  const existing = await tx.account.findUnique({
    where: { ownerId: application.userId },
    select: ACCOUNT_SELECT,
  });
  if (existing) {
    if (existing.kind !== 'CUSTOMER') {
      throw new AppError(409, 'ACCOUNT_PROVISIONING_CONFLICT', 'The customer account could not be provisioned.');
    }
    return { account: toAccountDto(existing), created: false };
  }

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const id = randomUUID();
    const number = accountNumber();
    const now = new Date();
    const inserted = await tx.$queryRaw`
      INSERT INTO public."Account" (
        "id", "accountNumber", "currency", "ownerId", "updatedAt"
      )
      VALUES (
        ${id}::uuid, ${number}, 'INR', ${application.userId}::uuid, ${now}
      )
      ON CONFLICT DO NOTHING
      RETURNING "id"
    `;

    if (inserted.length === 0) {
      const raced = await tx.account.findUnique({
        where: { ownerId: application.userId },
        select: ACCOUNT_SELECT,
      });
      if (raced) {
        if (raced.kind !== 'CUSTOMER') {
          throw new AppError(409, 'ACCOUNT_PROVISIONING_CONFLICT', 'The customer account could not be provisioned.');
        }
        return { account: toAccountDto(raced), created: false };
      }
      continue;
    }

    const created = await tx.account.findUnique({
      where: { id },
      select: ACCOUNT_PROVISION_SELECT,
    });
    if (
      !created
      || created.ownerId !== application.userId
      || created.kind !== 'CUSTOMER'
      || created.status !== 'ACTIVE'
      || created.currency !== 'INR'
      || created.balanceMinor !== 0n
    ) {
      throw new Error('Provisioned account read-back failed.');
    }

    await accountAudit(tx, actor, context, 'account.provision', id);
    return { account: toAccountDto(created), created: true };
  }

  throw new AppError(503, 'ACCOUNT_NUMBER_UNAVAILABLE', 'A unique account number could not be generated.');
}

async function provisionApprovedApplicationAccountInTransaction(prisma, actor, applicationId, context) {
  return prisma.$transaction((tx) => (
    provisionApprovedApplicationAccount(tx, actor, applicationId, context)
  ));
}

async function listOwnAccounts(prisma, actor) {
  const where = customerResourceWhere(actor, 'accounts');
  const accounts = await prisma.account.findMany({
    where: { ...where, kind: 'CUSTOMER' },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: ACCOUNT_SELECT,
  });
  return accounts.map(toAccountDto);
}

async function getOwnAccount(prisma, actor, id) {
  customerResourceWhere(actor, 'accounts');
  const account = await prisma.account.findFirst({
    where: { id, ownerId: actor.id, kind: 'CUSTOMER' },
    select: ACCOUNT_SELECT,
  });
  if (!account) {
    throw new AppError(404, 'ACCOUNT_NOT_FOUND', 'The account was not found.');
  }
  return toAccountDto(account);
}

async function listAdminAccounts(prisma, actor, { status, kind, page, limit }) {
  assertPermission(actor, 'ADMIN_ACCOUNT_READ');
  const where = {
    ...(status ? { status } : {}),
    ...(kind ? { kind } : {}),
  };
  const [accounts, total] = await Promise.all([
    prisma.account.findMany({
      where,
      skip: (page - 1) * limit,
      take: limit,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: ADMIN_ACCOUNT_SELECT,
    }),
    prisma.account.count({ where }),
  ]);
  return {
    accounts: accounts.map(toAccountDto),
    pagination: { page, limit, total },
  };
}

async function getAdminAccount(prisma, actor, id) {
  assertPermission(actor, 'ADMIN_ACCOUNT_READ');
  const account = await prisma.account.findUnique({
    where: { id },
    select: ADMIN_ACCOUNT_SELECT,
  });
  if (!account) {
    throw new AppError(404, 'ACCOUNT_NOT_FOUND', 'The account was not found.');
  }
  return toAccountDto(account);
}

async function changeAccountStatus(prisma, actor, id, status, context) {
  assertPermission(actor, 'ADMIN_ACCOUNT_STATUS_MANAGE');

  const result = await prisma.$transaction(async (tx) => {
    const account = await tx.account.findUnique({
      where: { id },
      select: { id: true, kind: true, status: true },
    });
    if (!account) {
      return { failure: 'NOT_FOUND' };
    }
    if (account.kind === 'SYSTEM') {
      await accountAudit(tx, actor, context, 'account.status.change', id, 'DENIED', 'SYSTEM_ACCOUNT_PROTECTED');
      return { failure: 'SYSTEM_ACCOUNT' };
    }
    if (!STATUS_TRANSITIONS[account.status]?.includes(status)) {
      await accountAudit(tx, actor, context, 'account.status.change', id, 'DENIED', 'INVALID_STATUS_TRANSITION');
      return { failure: 'INVALID_TRANSITION' };
    }

    const updated = await tx.account.updateMany({
      where: { id, kind: 'CUSTOMER', status: account.status },
      data: { status, updatedAt: new Date() },
    });
    if (updated.count !== 1) {
      await accountAudit(tx, actor, context, 'account.status.change', id, 'DENIED', 'CONCURRENT_STATUS_CHANGE');
      return { failure: 'CONCURRENT_CHANGE' };
    }

    const changedAccount = await tx.account.findUnique({
      where: { id },
      select: ADMIN_ACCOUNT_SELECT,
    });
    await accountAudit(tx, actor, context, 'account.status.change', id);
    return { account: toAccountDto(changedAccount) };
  });

  if (result.failure === 'NOT_FOUND') {
    throw new AppError(404, 'ACCOUNT_NOT_FOUND', 'The account was not found.');
  }
  if (result.failure === 'SYSTEM_ACCOUNT') {
    throw new AppError(409, 'SYSTEM_ACCOUNT_PROTECTED', 'System accounts cannot be changed through this endpoint.');
  }
  if (result.failure === 'INVALID_TRANSITION') {
    throw new AppError(409, 'INVALID_ACCOUNT_STATUS_TRANSITION', 'The account status transition is not allowed.');
  }
  if (result.failure === 'CONCURRENT_CHANGE') {
    throw new AppError(409, 'ACCOUNT_STATUS_CONFLICT', 'The account status changed concurrently.');
  }
  return result.account;
}

export {
  ACCOUNT_SELECT,
  ADMIN_ACCOUNT_SELECT,
  ACCOUNT_PROVISION_SELECT,
  changeAccountStatus,
  getAdminAccount,
  getOwnAccount,
  listAdminAccounts,
  listOwnAccounts,
  provisionApprovedApplicationAccount,
  provisionApprovedApplicationAccountInTransaction,
};
