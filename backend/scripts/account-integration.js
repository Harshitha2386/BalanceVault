import { randomBytes, randomUUID } from 'node:crypto';
import { getPrismaClient } from '../src/prisma.js';
import { hashPassword } from '../src/auth/password.js';

const databaseUrl = process.env.DATABASE_URL;
const getSqlState = (error) => {
  const candidates = [
    error?.meta?.code,
    error?.meta?.database_error,
    error?.message,
  ];
  for (const candidate of candidates) {
    const match = String(candidate || '').match(/\b(42501)\b/);
    if (match) {
      return match[1];
    }
  }
  return undefined;
};

if (!databaseUrl) {
  console.error('Account integration stopped: DATABASE_URL is required.');
  process.exitCode = 1;
} else {
  const prisma = getPrismaClient(databaseUrl);
  const rollbackMarker = new Error('ACCOUNT_INTEGRATION_ROLLBACK');
  const userId = randomUUID();
  const applicationId = randomUUID();
  const email = `account-integration+${userId}@example.test`;
  const accountNumber = `BV${randomBytes(10).toString('hex').toUpperCase()}`;
  const passwordHash = await hashPassword('Synthetic-Account-Integration-Password-948!');
  let step = 'checking database identity and account column grants';

  try {
    const [identity] = await prisma.$queryRaw`
      SELECT current_database() AS database_name, current_user AS role_name,
        has_column_privilege(current_user, 'public."Account"', 'id', 'INSERT') AS can_insert_id,
        has_column_privilege(current_user, 'public."Account"', 'accountNumber', 'INSERT') AS can_insert_number,
        has_column_privilege(current_user, 'public."Account"', 'currency', 'INSERT') AS can_insert_currency,
        has_column_privilege(current_user, 'public."Account"', 'ownerId', 'INSERT') AS can_insert_owner,
        has_column_privilege(current_user, 'public."Account"', 'updatedAt', 'INSERT') AS can_insert_updated_at,
        has_column_privilege(current_user, 'public."Account"', 'kind', 'INSERT') AS can_insert_kind,
        has_column_privilege(current_user, 'public."Account"', 'status', 'INSERT') AS can_insert_status,
        has_column_privilege(current_user, 'public."Account"', 'balanceMinor', 'INSERT') AS can_insert_balance
    `;
    console.log(`Runtime connection identity: database=${identity.database_name} role=${identity.role_name}`);
    if (identity.database_name !== 'balancevault_test' || identity.role_name !== 'bv_app') {
      throw new Error('Account integration stopped: expected balancevault_test as bv_app.');
    }

    const intendedColumns = [
      identity.can_insert_id,
      identity.can_insert_number,
      identity.can_insert_currency,
      identity.can_insert_owner,
      identity.can_insert_updated_at,
    ];
    const protectedColumns = [
      identity.can_insert_kind,
      identity.can_insert_status,
      identity.can_insert_balance,
    ];
    if (!intendedColumns.every(Boolean) || protectedColumns.some(Boolean)) {
      throw new Error('Account integration stopped: Account column grants differ from the approved allowlist.');
    }
    console.log('PASS: Account INSERT grants allow only the approved provisioning columns.');

    try {
      await prisma.$transaction(async (tx) => {
        step = 'creating rollback-only synthetic customer and application';
        await tx.$queryRaw`
          INSERT INTO public."User" (
            "id", "email", "fullName", "passwordHash", "updatedAt"
          )
          VALUES (
            ${userId}::uuid,
            ${email},
            'Synthetic Account Integration',
            ${passwordHash},
            ${new Date()}
          )
        `;
        await tx.$queryRaw`
          INSERT INTO public."OnboardingApplication" (
            "id", "userId", "legalName", "dateOfBirth", "phone",
            "addressLine", "city", "country", "updatedAt"
          )
          VALUES (
            ${applicationId}::uuid,
            ${userId}::uuid,
            'Synthetic Account Integration',
            DATE '1998-06-15',
            '+1 (555) 010-2040',
            '100 Synthetic Test Street',
            'Test City',
            'US',
            ${new Date()}
          )
        `;
        await tx.onboardingApplication.updateMany({
          where: { id: applicationId, status: 'PENDING' },
          data: {
            status: 'APPROVED',
            reviewedById: userId,
            reviewedAt: new Date(),
            updatedAt: new Date(),
          },
        });

        step = 'inserting Account through the permitted column list';
        const inserted = await tx.$queryRaw`
          INSERT INTO public."Account" (
            "id", "accountNumber", "currency", "ownerId", "updatedAt"
          )
          VALUES (
            ${randomUUID()}::uuid,
            ${accountNumber},
            'INR',
            ${userId}::uuid,
            ${new Date()}
          )
          RETURNING "id"
        `;
        if (inserted.length !== 1) {
          throw new Error('Account INSERT did not return one row.');
        }

        const account = await tx.account.findUnique({
          where: { ownerId: userId },
          select: {
            id: true,
            accountNumber: true,
            ownerId: true,
            kind: true,
            status: true,
            currency: true,
            balanceMinor: true,
          },
        });
        if (
          !account
          || account.ownerId !== userId
          || account.kind !== 'CUSTOMER'
          || account.status !== 'ACTIVE'
          || account.currency !== 'INR'
          || account.balanceMinor !== 0n
          || account.accountNumber !== accountNumber
        ) {
          throw new Error('Account database defaults or owner read-back did not match.');
        }

        step = 'checking customer status UPDATE grant';
        const statusUpdate = await tx.account.updateMany({
          where: { id: account.id, kind: 'CUSTOMER', status: 'ACTIVE' },
          data: { status: 'FROZEN', updatedAt: new Date() },
        });
        const frozen = await tx.account.findUnique({
          where: { id: account.id },
          select: { status: true },
        });
        if (statusUpdate.count !== 1 || frozen?.status !== 'FROZEN') {
          throw new Error('Permitted customer account status UPDATE did not succeed.');
        }

        throw rollbackMarker;
      });
    } catch (error) {
      if (error !== rollbackMarker) {
        const code = typeof error?.meta?.code === 'string'
          ? error.meta.code
          : typeof error?.code === 'string'
            ? error.code
            : 'unknown';
        throw new Error(`Account integration failed at ${step} (Prisma/SQL code: ${code}).`);
      }
    }

    step = 'checking SYSTEM account update protection';
    const unexpectedSystemUpdate = new Error('SYSTEM_UPDATE_UNEXPECTEDLY_ALLOWED');
    let systemUpdateError;
    let systemAccountExists = false;
    let systemUpdateUnexpectedlyAllowed = false;
    try {
      await prisma.$transaction(async (tx) => {
        const systemAccount = await tx.account.findFirst({
          where: { kind: 'SYSTEM' },
          select: { id: true, status: true },
        });
        if (!systemAccount) {
          return;
        }
        systemAccountExists = true;
        await tx.account.updateMany({
          where: { id: systemAccount.id, kind: 'SYSTEM' },
          data: {
            status: systemAccount.status === 'ACTIVE' ? 'FROZEN' : 'ACTIVE',
            updatedAt: new Date(),
          },
        });
        throw unexpectedSystemUpdate;
      });
    } catch (error) {
      if (error === unexpectedSystemUpdate) {
        systemUpdateUnexpectedlyAllowed = true;
      } else {
        systemUpdateError = error;
      }
    }
    if (systemAccountExists) {
      const systemUpdateSqlState = getSqlState(systemUpdateError);
      if (systemUpdateUnexpectedlyAllowed || systemUpdateSqlState !== '42501') {
        const prismaCode = typeof systemUpdateError?.code === 'string' ? systemUpdateError.code : 'unknown';
        throw new Error(
          `SYSTEM account UPDATE protection was not verified (Prisma=${prismaCode}, SQLSTATE=${systemUpdateSqlState || 'unknown'}, unexpectedlyAllowed=${systemUpdateUnexpectedlyAllowed}).`,
        );
      }
    }

    const [persistedAccount, persistedApplication, persistedUser] = await Promise.all([
      prisma.account.findUnique({ where: { ownerId: userId }, select: { id: true } }),
      prisma.onboardingApplication.findUnique({
        where: { id: applicationId },
        select: { id: true },
      }),
      prisma.user.findUnique({ where: { id: userId }, select: { id: true } }),
    ]);
    if (persistedAccount || persistedApplication || persistedUser) {
      throw new Error('Account integration rollback verification failed.');
    }

    console.log('PASS: restricted Account INSERT defaults and permitted customer status UPDATE succeeded.');
    if (systemAccountExists) {
      console.log('PASS: SYSTEM account status UPDATE was rejected with SQLSTATE 42501 and the transaction rolled back.');
    } else {
      console.log('SKIP: no SYSTEM account exists in balancevault_test for the trigger-denial check.');
    }
    console.log('PASS: synthetic User, OnboardingApplication, and Account records were rolled back and are absent.');
  } catch (error) {
    console.error(error.message || 'Account integration failed without exposing database details.');
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}
