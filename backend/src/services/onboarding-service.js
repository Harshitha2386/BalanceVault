import { randomUUID } from 'node:crypto';
import { assertPermission } from '../auth/authorization.js';
import { AppError } from '../middleware/error-handler.js';
import { recordAudit } from './audit-service.js';
import { provisionApprovedApplicationAccount } from './account-service.js';

const CUSTOMER_APPLICATION_SELECT = {
  id: true,
  status: true,
  legalName: true,
  dateOfBirth: true,
  phone: true,
  addressLine: true,
  city: true,
  country: true,
  reviewedAt: true,
  reviewNote: true,
  createdAt: true,
  updatedAt: true,
};

const ADMIN_APPLICATION_SUMMARY_SELECT = {
  id: true,
  userId: true,
  status: true,
  legalName: true,
  city: true,
  country: true,
  createdAt: true,
  reviewedAt: true,
  user: {
    select: { id: true, email: true, fullName: true },
  },
};

const ADMIN_APPLICATION_DETAIL_SELECT = {
  ...CUSTOMER_APPLICATION_SELECT,
  userId: true,
  reviewedById: true,
  user: {
    select: { id: true, email: true, fullName: true },
  },
  reviewedBy: {
    select: { id: true, fullName: true },
  },
};

function auditApplication(client, context, actorId, action, targetId, outcome = 'SUCCESS', metadata) {
  return recordAudit(client, {
    actorId,
    action,
    outcome,
    requestId: context.requestId,
    ipAddress: context.ipAddress,
    targetType: 'OnboardingApplication',
    targetId,
    metadata,
  });
}

function isActiveApplicationUniqueViolation(error) {
  return error?.code === 'P2002'
    || error?.meta?.code === '23505'
    || error?.code === '23505';
}

async function submitApplication(prisma, actor, input, context) {
  assertPermission(actor, 'CUSTOMER_ONBOARDING_SUBMIT');
  const id = randomUUID();
  const now = new Date();

  const inserted = await prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw`
      INSERT INTO public."OnboardingApplication" (
        "id", "userId", "legalName", "dateOfBirth", "phone",
        "addressLine", "city", "country", "updatedAt"
      )
      VALUES (
        ${id}::uuid, ${actor.id}::uuid, ${input.legalName}, ${input.dateOfBirth}::date,
        ${input.phone}, ${input.addressLine}, ${input.city}, ${input.country}, ${now}
      )
      ON CONFLICT ("userId") WHERE "status" IN (
        'PENDING'::public."ApplicationStatus",
        'APPROVED'::public."ApplicationStatus"
      ) DO NOTHING
      RETURNING "id"
    `;

    if (rows.length === 0) {
      await auditApplication(tx, context, actor.id, 'onboarding.application.submit', null, 'DENIED', {
        reasonCode: 'ACTIVE_APPLICATION_EXISTS',
      });
      return null;
    }

    const application = await tx.onboardingApplication.findUnique({
      where: { id },
      select: CUSTOMER_APPLICATION_SELECT,
    });
    if (!application) {
      throw new Error('Onboarding application read-back failed.');
    }

    await auditApplication(tx, context, actor.id,
      'onboarding.application.submit', id);
    return application;
  }).catch((error) => {
    if (isActiveApplicationUniqueViolation(error)) {
      throw new AppError(409, 'ACTIVE_APPLICATION_EXISTS', 'An active application already exists.');
    }
    throw error;
  });

  if (!inserted) {
    throw new AppError(409, 'ACTIVE_APPLICATION_EXISTS', 'An active application already exists.');
  }
  return inserted;
}

async function listOwnApplications(prisma, actor) {
  assertPermission(actor, 'CUSTOMER_ONBOARDING_READ');
  return prisma.onboardingApplication.findMany({
    where: { userId: actor.id },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: CUSTOMER_APPLICATION_SELECT,
  });
}

async function listApplications(prisma, actor, { status, page, limit }) {
  assertPermission(actor, 'ADMIN_ONBOARDING_READ');
  const where = status ? { status } : {};
  const [applications, total] = await Promise.all([
    prisma.onboardingApplication.findMany({
      where,
      skip: (page - 1) * limit,
      take: limit,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: ADMIN_APPLICATION_SUMMARY_SELECT,
    }),
    prisma.onboardingApplication.count({ where }),
  ]);
  return {
    applications,
    pagination: { page, limit, total },
  };
}

async function getApplication(prisma, actor, id) {
  assertPermission(actor, 'ADMIN_ONBOARDING_READ');
  const application = await prisma.onboardingApplication.findUnique({
    where: { id },
    select: ADMIN_APPLICATION_DETAIL_SELECT,
  });
  if (!application) {
    throw new AppError(404, 'APPLICATION_NOT_FOUND', 'The application was not found.');
  }
  return application;
}

async function decideApplication(prisma, actor, id, input, context) {
  assertPermission(actor, 'ADMIN_ONBOARDING_REVIEW');
  const now = new Date();
  const action = input.decision === 'APPROVED'
    ? 'onboarding.application.approve'
    : 'onboarding.application.reject';

  const result = await prisma.$transaction(async (tx) => {
    const changed = await tx.onboardingApplication.updateMany({
      where: { id, status: 'PENDING' },
      data: {
        status: input.decision,
        reviewedById: actor.id,
        reviewedAt: now,
        reviewNote: input.reviewNote ?? null,
        updatedAt: now,
      },
    });

    if (changed.count !== 1) {
      const current = await tx.onboardingApplication.findUnique({
        where: { id },
        select: { id: true, status: true },
      });
      return { conflict: current ? 'ALREADY_DECIDED' : 'NOT_FOUND' };
    }

    const application = await tx.onboardingApplication.findUnique({
      where: { id },
      select: ADMIN_APPLICATION_DETAIL_SELECT,
    });
    if (!application) {
      throw new Error('Onboarding decision read-back failed.');
    }

    const account = input.decision === 'APPROVED'
      ? await provisionApprovedApplicationAccount(tx, actor, id, context)
      : null;
    await auditApplication(tx, context, actor.id, action, id);
    return { application, account: account?.account ?? null };
  });

  if (result.conflict === 'NOT_FOUND') {
    throw new AppError(404, 'APPLICATION_NOT_FOUND', 'The application was not found.');
  }
  if (result.conflict === 'ALREADY_DECIDED') {
    await recordAudit(prisma, {
      actorId: actor.id,
      action,
      outcome: 'DENIED',
      requestId: context.requestId,
      ipAddress: context.ipAddress,
      targetType: 'OnboardingApplication',
      targetId: id,
      metadata: { reasonCode: 'APPLICATION_NOT_PENDING' },
    });
    throw new AppError(409, 'APPLICATION_ALREADY_DECIDED', 'The application is no longer pending.');
  }
  return result;
}

export {
  CUSTOMER_APPLICATION_SELECT,
  ADMIN_APPLICATION_DETAIL_SELECT,
  ADMIN_APPLICATION_SUMMARY_SELECT,
  decideApplication,
  getApplication,
  listApplications,
  listOwnApplications,
  submitApplication,
};
