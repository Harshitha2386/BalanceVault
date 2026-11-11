import { randomBytes, randomUUID } from 'node:crypto';
import { hashPassword } from '../src/auth/password.js';
import { getPrismaClient } from '../src/prisma.js';
import {
  computeLedgerBalanceDiscrepancies,
  createFundingInTransaction,
  createTransferInTransaction,
  listOwnTransactions,
  verifyLedgerBalances,
} from '../src/services/ledger-service.js';

const databaseUrl = process.env.DATABASE_URL;
const rollbackMarker = new Error('LEDGER_INTEGRATION_ROLLBACK');

function safeErrorCode(error) {
  for (const candidate of [error?.meta?.code, error?.code]) {
    if (typeof candidate === 'string' && /^[A-Z0-9]+$/u.test(candidate)) {
      return candidate;
    }
  }
  return 'unknown';
}

if (!databaseUrl) {
  console.error('Ledger integration stopped: DATABASE_URL is required.');
  process.exitCode = 1;
} else {
  const prisma = getPrismaClient(databaseUrl);
  const syntheticUserIds = [randomUUID(), randomUUID(), randomUUID()];
  const syntheticAccountIds = [randomUUID(), randomUUID(), randomUUID()];
  const syntheticAccountNumbers = syntheticAccountIds.map(
    () => `BV${randomBytes(10).toString('hex').toUpperCase()}`,
  );
  const transferKey = `integration-${randomUUID()}`;
  const fundingKey = `integration-${randomUUID()}`;
  const context = { requestId: randomUUID(), ipAddress: null };
  let step = 'checking database identity and ledger grants';

  try {
    const [identity] = await prisma.$queryRaw`
      SELECT current_database() AS database_name, current_user AS role_name,
        has_table_privilege(current_user, 'public."LedgerTransaction"', 'INSERT') AS can_insert_transactions,
        has_table_privilege(current_user, 'public."LedgerEntry"', 'INSERT') AS can_insert_entries,
        has_table_privilege(current_user, 'public."IdempotencyRecord"', 'INSERT') AS can_insert_idempotency,
        has_table_privilege(current_user, 'public."AuditLog"', 'INSERT') AS can_insert_audit,
        has_column_privilege(current_user, 'public."Account"', 'status', 'UPDATE') AS can_update_status,
        has_column_privilege(current_user, 'public."Account"', 'balanceMinor', 'UPDATE') AS can_update_balance
    `;
    console.log(`Runtime connection identity: database=${identity.database_name} role=${identity.role_name}`);
    if (identity.database_name !== 'balancevault_test' || identity.role_name !== 'bv_app') {
      throw new Error('Ledger integration stopped: expected balancevault_test as bv_app.');
    }
    if (
      !identity.can_insert_transactions
      || !identity.can_insert_entries
      || !identity.can_insert_idempotency
      || !identity.can_insert_audit
      || !identity.can_update_status
      || identity.can_update_balance
    ) {
      throw new Error('Ledger integration stopped: required least-privilege grants do not match.');
    }
    console.log('PASS: ledger, idempotency, and audit INSERT grants are present; balance UPDATE remains denied.');

    const [systemSummary] = await prisma.$queryRaw`
      SELECT
        COUNT(*)::integer AS total_count,
        COUNT(*) FILTER (WHERE "status" = 'ACTIVE'::public."AccountStatus")::integer AS active_count
      FROM public."Account"
      WHERE "kind" = 'SYSTEM'::public."AccountKind"
    `;
    console.log(
      `SYSTEM account summary: total=${systemSummary.total_count} active=${systemSummary.active_count}`,
    );
    const systemAccount = await prisma.account.findUnique({
      where: { accountNumber: 'BV-SYSTEM-FUNDING-INR' },
      select: { id: true, kind: true, status: true, currency: true, balanceMinor: true },
    });
    if (
      !systemAccount
      || systemAccount.kind !== 'SYSTEM'
      || systemAccount.status !== 'ACTIVE'
      || systemAccount.currency !== 'INR'
    ) {
      throw new Error('Ledger integration stopped: the seeded ACTIVE SYSTEM funding account is unavailable; no seed or database change was attempted.');
    }

    const admin = await prisma.user.findFirst({
      where: { role: 'ADMIN', status: 'ACTIVE' },
      select: { id: true, role: true, status: true },
    });
    const passwordHash = await hashPassword('Synthetic-Ledger-Integration-Password-948!');

    let transactionError = null;
    try {
      await prisma.$transaction(async (tx) => {
        step = 'creating rollback-only synthetic customers and accounts';
        for (let index = 0; index < syntheticUserIds.length; index += 1) {
          await tx.$queryRaw`
            INSERT INTO public."User" (
              "id", "email", "fullName", "passwordHash", "updatedAt"
            )
            VALUES (
              ${syntheticUserIds[index]}::uuid,
              ${`ledger-integration-${syntheticUserIds[index]}@example.test`},
              'Synthetic Ledger Integration',
              ${passwordHash},
              ${new Date()}
            )
          `;
          await tx.$queryRaw`
            INSERT INTO public."Account" (
              "id", "accountNumber", "currency", "ownerId", "updatedAt"
            )
            VALUES (
              ${syntheticAccountIds[index]}::uuid,
              ${syntheticAccountNumbers[index]},
              'INR',
              ${syntheticUserIds[index]}::uuid,
              ${new Date()}
            )
          `;
        }

        step = 'posting synthetic initial funds and validating account locks';
        await tx.$queryRaw`
          SELECT "id"
          FROM public."Account"
          WHERE "id" IN (${systemAccount.id}::uuid, ${syntheticAccountIds[0]}::uuid)
          ORDER BY "id"
          FOR UPDATE
        `;
        const openingId = randomUUID();
        await tx.ledgerTransaction.create({
          data: {
            id: openingId,
            reference: `BV-${randomUUID()}`,
            type: 'FUNDING',
            description: 'Synthetic integration opening funds',
            createdById: syntheticUserIds[0],
          },
          select: { id: true },
        });
        const openingEntries = [
          { accountId: systemAccount.id, direction: 'DEBIT' },
          { accountId: syntheticAccountIds[0], direction: 'CREDIT' },
        ].sort((left, right) => (left.accountId < right.accountId ? -1 : 1));
        for (const entry of openingEntries) {
          await tx.ledgerEntry.create({
            data: {
              transactionId: openingId,
              accountId: entry.accountId,
              direction: entry.direction,
              amountMinor: 100_000n,
            },
            select: { id: true },
          });
        }

        step = 'executing transfer service, replay, and mismatch checks';
        const customer = {
          id: syntheticUserIds[0],
          role: 'ACCOUNT_HOLDER',
          status: 'ACTIVE',
        };
        const transferInput = {
          destinationAccountId: syntheticAccountIds[1],
          amountMinor: 5_000,
        };
        const firstTransfer = await createTransferInTransaction(
          tx,
          customer,
          transferInput,
          transferKey,
          context,
        );
        const replay = await createTransferInTransaction(
          tx,
          customer,
          transferInput,
          transferKey,
          context,
        );
        if (
          firstTransfer.replayed
          || !replay.replayed
          || firstTransfer.transaction.id !== replay.transaction.id
        ) {
          throw new Error('Transfer idempotency read-back did not match.');
        }
        const history = await listOwnTransactions(tx, customer, { page: 1, limit: 10 });
        if (
          history.pagination.total !== 2
          || !history.transactions.some((transaction) => (
            transaction.id === firstTransfer.transaction.id
            && transaction.entries.length === 1
            && transaction.entries[0].direction === 'DEBIT'
          ))
        ) {
          throw new Error('Owner-scoped transaction history did not include only the customer entry.');
        }

        let mismatchRejected = false;
        try {
          await createTransferInTransaction(
            tx,
            customer,
            { ...transferInput, amountMinor: 5_001 },
            transferKey,
            context,
          );
        } catch (error) {
          mismatchRejected = error?.code === 'IDEMPOTENCY_KEY_REUSED';
        }
        if (!mismatchRejected) {
          throw new Error('A different request body reused an idempotency key.');
        }

        let fundingVerified = false;
        let balanceVerificationResult = null;
        if (admin) {
          step = 'executing admin funding and balance-verification services';
          const fundingInput = { amountMinor: 400 };
          const firstFunding = await createFundingInTransaction(
            tx,
            admin,
            syntheticAccountIds[2],
            fundingInput,
            fundingKey,
            context,
          );
          const fundingReplay = await createFundingInTransaction(
            tx,
            admin,
            syntheticAccountIds[2],
            fundingInput,
            fundingKey,
            context,
          );
          if (
            firstFunding.replayed
            || !fundingReplay.replayed
            || firstFunding.transaction.id !== fundingReplay.transaction.id
          ) {
            throw new Error('Funding idempotency read-back did not match.');
          }
          fundingVerified = true;
          balanceVerificationResult = await verifyLedgerBalances(tx, admin, context);
          if (!balanceVerificationResult.consistent) {
            throw new Error('Ledger verification found a mismatch after balanced synthetic postings.');
          }
        }

        step = 'checking deferred balancing and trigger-updated cached balances';
        await tx.$executeRaw`SET CONSTRAINTS ALL IMMEDIATE`;
        console.log('PASS: deferred ledger balancing constraints accepted all synthetic postings.');
        const verification = await computeLedgerBalanceDiscrepancies(tx);
        const testDiscrepancies = verification.discrepancies.filter((item) => (
          syntheticAccountIds.includes(item.accountId)
        ));
        if (testDiscrepancies.length !== 0) {
          throw new Error('Ledger-derived and trigger-maintained balances differ for synthetic accounts.');
        }
        console.log('PASS: ledger verification SQL reported no discrepancy for synthetic accounts.');
        const accountRows = await tx.account.findMany({
          where: { id: { in: [systemAccount.id, ...syntheticAccountIds] } },
          select: { id: true, balanceMinor: true },
        });
        const balances = new Map(accountRows.map((row) => [row.id, row.balanceMinor]));
        if (
          balances.get(syntheticAccountIds[0]) !== 95_000n
          || balances.get(syntheticAccountIds[1]) !== 5_000n
          || (admin && balances.get(syntheticAccountIds[2]) !== 400n)
          || balances.get(systemAccount.id) !== systemAccount.balanceMinor - 100_000n - (admin ? 400n : 0n)
        ) {
          throw new Error('Ledger posting produced unexpected trigger-maintained balances.');
        }

        console.log('PASS: synthetic transfer posted balanced entries, replayed idempotently, and rejected a body mismatch.');
        if (admin) {
          console.log('PASS: active ADMIN funding replay and permission-checked ledger verification completed inside the rollback-only transaction.');
        } else {
          console.log('SKIP: admin funding endpoint/service integration; no active ADMIN is available in balancevault_test.');
        }
        console.log('PASS: deferred balancing constraints and trigger-maintained balances matched expected values.');
        throw rollbackMarker;
      }, { timeout: 30_000 });
    } catch (error) {
      if (error !== rollbackMarker) {
        transactionError = error;
      }
    }

    step = 'verifying synthetic test data was rolled back';
    const remaining = await prisma.$queryRaw`
      SELECT
        EXISTS (
          SELECT 1 FROM public."User"
          WHERE "id" IN (
            ${syntheticUserIds[0]}::uuid,
            ${syntheticUserIds[1]}::uuid,
            ${syntheticUserIds[2]}::uuid
          )
        ) AS user_exists,
        EXISTS (
          SELECT 1 FROM public."Account"
          WHERE "id" IN (
            ${syntheticAccountIds[0]}::uuid,
            ${syntheticAccountIds[1]}::uuid,
            ${syntheticAccountIds[2]}::uuid
          )
        ) AS account_exists
    `;
    if (remaining[0].user_exists || remaining[0].account_exists) {
      throw new Error('Ledger integration rollback verification failed.');
    }
    console.log('PASS: all synthetic users, accounts, ledger rows, idempotency records, and audit rows were rolled back.');
    if (transactionError) {
      throw new Error(
        `Ledger integration failed at ${step} (Prisma/SQL code: ${safeErrorCode(transactionError)}).`,
      );
    }
    if (!admin) {
      console.log('Admin funding service integration: NOT RUN (no active ADMIN in test database).');
    }
  } catch (error) {
    console.error(error.message || 'Ledger integration failed without exposing database details.');
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}
