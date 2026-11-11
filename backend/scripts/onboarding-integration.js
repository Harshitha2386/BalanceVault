import { randomUUID } from 'node:crypto';
import { getPrismaClient } from '../src/prisma.js';
import { hashPassword } from '../src/auth/password.js';
import {
  decideApplication,
  getApplication,
  listApplications,
  listOwnApplications,
  submitApplication,
} from '../src/services/onboarding-service.js';

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

function errorCode(error) {
  if (typeof error?.meta?.code === 'string') {
    return error.meta.code;
  }
  return typeof error?.code === 'string' ? error.code : 'unknown';
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('Onboarding integration stopped: DATABASE_URL is required.');
  process.exitCode = 1;
} else {
  const prisma = getPrismaClient(databaseUrl);
  const rollbackMarker = new Error('ONBOARDING_INTEGRATION_ROLLBACK');
  const userId = randomUUID();
  const email = `onboarding-integration+${userId}@example.test`;
  const requestId = randomUUID();
  const context = { requestId, ipAddress: '127.0.0.1' };
  const applicationInput = {
    legalName: 'Synthetic Integration Applicant',
    dateOfBirth: new Date('1998-06-15T00:00:00.000Z'),
    phone: '+1 (555) 010-2040',
    addressLine: '100 Synthetic Test Street',
    city: 'Test City',
    country: 'US',
  };
  let applicationId;
  let activeAdmin;
  let step = 'checking database and role';

  try {
    const [identity] = await prisma.$queryRaw`
      SELECT current_database() AS database_name, current_user AS role_name
    `;
    console.log(`Runtime connection identity: database=${identity.database_name} role=${identity.role_name}`);
    if (identity.database_name !== 'balancevault_test' || identity.role_name !== 'bv_app') {
      throw new Error('Onboarding integration stopped: expected balancevault_test as bv_app.');
    }

    try {
      await prisma.$transaction(async (transaction) => {
        const tx = transactionScopedClient(transaction);
        step = 'creating rollback-only synthetic customer';
        const passwordHash = await hashPassword('Synthetic-Integration-Password-948!');
        const users = await tx.$queryRaw`
          INSERT INTO public."User" (
            "id", "email", "fullName", "passwordHash", "updatedAt"
          )
          VALUES (
            ${userId}::uuid,
            ${email},
            'Synthetic Integration Applicant',
            ${passwordHash},
            ${new Date()}
          )
          RETURNING "id"
        `;
        if (users.length !== 1) {
          throw new Error('Synthetic customer insert did not return one row.');
        }

        const customer = await tx.user.findUnique({
          where: { id: userId },
          select: { id: true, role: true, status: true },
        });
        if (!customer || customer.role !== 'ACCOUNT_HOLDER' || customer.status !== 'ACTIVE') {
          throw new Error('Synthetic customer defaults did not match.');
        }

        step = 'submitting application and reading customer status';
        const application = await submitApplication(
          tx,
          customer,
          applicationInput,
          context,
        );
        applicationId = application.id;
        if (application.status !== 'PENDING') {
          throw new Error('New application did not use the PENDING default.');
        }
        const ownApplications = await listOwnApplications(tx, customer);
        if (ownApplications.length !== 1 || ownApplications[0].id !== applicationId) {
          throw new Error('Customer application ownership read failed.');
        }

        step = 'active-application uniqueness conflict handling';
        try {
          await submitApplication(tx, customer, applicationInput, context);
          throw new Error('Duplicate active application unexpectedly succeeded.');
        } catch (error) {
          if (error?.code !== 'ACTIVE_APPLICATION_EXISTS') {
            throw error;
          }
        }

        activeAdmin = await tx.user.findFirst({
          where: { role: 'ADMIN', status: 'ACTIVE' },
          select: { id: true, role: true },
        });
        if (activeAdmin) {
          step = 'admin list and application detail authorization';
          const listed = await listApplications(tx, activeAdmin, {
            status: 'PENDING',
            page: 1,
            limit: 10,
          });
          const detail = await getApplication(tx, activeAdmin, applicationId);
          if (
            !listed.applications.some((row) => row.id === applicationId)
            || detail.userId !== userId
          ) {
            throw new Error('Admin onboarding read failed.');
          }

          step = 'admin decision and state-transition enforcement';
          const decided = await decideApplication(
            tx,
            activeAdmin,
            applicationId,
            { decision: 'APPROVED', reviewNote: 'Synthetic integration decision.' },
            context,
          );
          if (
            decided.application.status !== 'APPROVED'
            || decided.application.reviewedById !== activeAdmin.id
            || !decided.application.reviewedAt
            || !decided.account
            || decided.account.kind !== 'CUSTOMER'
            || decided.account.status !== 'ACTIVE'
            || decided.account.currency !== 'INR'
            || decided.account.balanceMinor !== '0'
          ) {
            throw new Error('Admin decision did not persist expected review fields.');
          }

          try {
            await decideApplication(
              tx,
              activeAdmin,
              applicationId,
              { decision: 'REJECTED' },
              context,
            );
            throw new Error('A repeated decision unexpectedly succeeded.');
          } catch (error) {
            if (error?.code !== 'APPLICATION_ALREADY_DECIDED') {
              throw error;
            }
          }
        }

        const auditCount = await tx.auditLog.count({ where: { requestId } });
        if (auditCount < (activeAdmin ? 4 : 2)) {
          throw new Error('Expected onboarding audit records were not written.');
        }
        throw rollbackMarker;
      });
    } catch (error) {
      if (error !== rollbackMarker) {
        throw new Error(`Onboarding integration failed at ${step} (Prisma/SQL code: ${errorCode(error)}).`);
      }
    }

    const [persistedUser, persistedApplication, persistedAccount, persistedAuditCount] = await Promise.all([
      prisma.user.findUnique({ where: { id: userId }, select: { id: true } }),
      applicationId
        ? prisma.onboardingApplication.findUnique({
          where: { id: applicationId },
          select: { id: true },
        })
        : Promise.resolve(null),
      prisma.account.findUnique({ where: { ownerId: userId }, select: { id: true } }),
      prisma.auditLog.count({ where: { requestId } }),
    ]);
    if (persistedUser || persistedApplication || persistedAccount || persistedAuditCount !== 0) {
      throw new Error('Onboarding integration rollback verification failed.');
    }

    console.log('PASS: application submission, ownership filtering, duplicate prevention, and audit writes succeeded.');
    if (activeAdmin) {
      console.log('PASS: admin listing, detail, approval, and repeated-decision rejection succeeded.');
    } else {
      console.log('SKIP: admin decision integration requires an existing active ADMIN user.');
    }
    console.log('PASS: synthetic User, OnboardingApplication, Account, and AuditLog records were rolled back and are absent.');
  } catch (error) {
    console.error(error.message || 'Onboarding integration failed without exposing database details.');
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}
