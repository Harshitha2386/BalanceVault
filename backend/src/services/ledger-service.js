import { createHash, randomUUID } from 'node:crypto';
import { assertPermission, customerResourceWhere } from '../auth/authorization.js';
import { MAX_AMOUNT_MINOR } from '../ledger/validation.js';
import { AppError } from '../middleware/error-handler.js';
import { recordAudit } from './audit-service.js';

const TRANSACTION_HISTORY_SELECT = {
  id: true,
  reference: true,
  type: true,
  createdAt: true,
};

function assertAmountMinor(amountMinor) {
  if (
    typeof amountMinor !== 'number'
    || !Number.isSafeInteger(amountMinor)
    || amountMinor <= 0
    || amountMinor > MAX_AMOUNT_MINOR
  ) {
    throw new AppError(400, 'INVALID_AMOUNT', 'The amount must be a positive whole number within the allowed limit.');
  }
}

function requestHash(kind, destinationAccountId, amountMinor) {
  return createHash('sha256')
    .update(JSON.stringify({
      kind,
      destinationAccountId,
      amountMinor: String(amountMinor),
    }))
    .digest('hex');
}

function transactionDto(transaction, amountMinor) {
  return {
    id: transaction.id,
    reference: transaction.reference,
    type: transaction.type,
    amountMinor: String(amountMinor),
    createdAt: transaction.createdAt,
  };
}

function historyDto(transaction) {
  return {
    id: transaction.id,
    reference: transaction.reference,
    type: transaction.type,
    createdAt: transaction.createdAt,
    entries: transaction.entries.map((entry) => ({
      direction: entry.direction,
      amountMinor: entry.amountMinor.toString(),
      currency: entry.account.currency,
    })),
  };
}

function auditContext(context) {
  return {
    requestId: context.requestId,
    ipAddress: context.ipAddress ?? null,
  };
}

async function auditFailure(prisma, actor, context, action, error) {
  await recordAudit(prisma, {
    actorId: actor?.id ?? null,
    action,
    outcome: error instanceof AppError && error.status < 500 ? 'DENIED' : 'FAILURE',
    ...auditContext(context),
    targetType: action === 'ledger.verify' ? 'LedgerVerification' : 'LedgerTransaction',
    targetId: action === 'ledger.verify' ? context.requestId : null,
    metadata: {
      reasonCode: error instanceof AppError
        ? error.code
        : 'LEDGER_OPERATION_FAILED',
    },
  });
}

async function findIdempotencyRecord(client, userId, key) {
  return client.idempotencyRecord.findUnique({
    where: { userId_key: { userId, key } },
    select: {
      requestHash: true,
      transaction: {
        select: {
          id: true,
          reference: true,
          type: true,
          createdAt: true,
          entries: { select: { amountMinor: true } },
        },
      },
    },
  });
}

function resolveIdempotencyRecord(record, expectedHash) {
  if (record.requestHash !== expectedHash) {
    throw new AppError(
      409,
      'IDEMPOTENCY_KEY_REUSED',
      'This Idempotency-Key was already used for a different request.',
    );
  }
  if (!record.transaction || record.transaction.entries.length === 0) {
    throw new AppError(503, 'LEDGER_RESULT_UNAVAILABLE', 'The stored transaction result is unavailable.');
  }
  return {
    transaction: transactionDto(
      record.transaction,
      record.transaction.entries[0].amountMinor,
    ),
    replayed: true,
  };
}

function isUniqueConstraintViolation(error) {
  return error?.code === 'P2002'
    || error?.code === '23505'
    || error?.meta?.code === '23505';
}

async function withIdempotency(prisma, actor, key, expectedHash, operation) {
  try {
    return await prisma.$transaction((tx) => operation(tx));
  } catch (error) {
    if (!isUniqueConstraintViolation(error)) {
      throw error;
    }

    const record = await findIdempotencyRecord(prisma, actor.id, key);
    if (!record) {
      throw error;
    }
    return resolveIdempotencyRecord(record, expectedHash);
  }
}

async function lockAccounts(tx, firstId, secondId) {
  const locked = await tx.$queryRaw`
    SELECT a."id"::text AS "id"
    FROM public."Account" AS a
    WHERE a."id" IN (${firstId}::uuid, ${secondId}::uuid)
    ORDER BY a."id"
    FOR UPDATE
  `;
  if (locked.length !== 2) {
    return [];
  }

  return tx.$queryRaw`
    SELECT
      a."id"::text AS "id",
      a."ownerId"::text AS "ownerId",
      a."kind"::text AS "kind",
      a."status"::text AS "status",
      a."currency"::text AS "currency",
      a."balanceMinor"::text AS "cachedBalanceMinor",
      COALESCE((
        SELECT SUM(
          CASE e."direction"
            WHEN 'CREDIT'::public."EntryDirection" THEN e."amountMinor"
            WHEN 'DEBIT'::public."EntryDirection" THEN -e."amountMinor"
          END
        )
        FROM public."LedgerEntry" AS e
        WHERE e."accountId" = a."id"
      ), 0)::text AS "ledgerBalanceMinor"
    FROM public."Account" AS a
    WHERE a."id" IN (${firstId}::uuid, ${secondId}::uuid)
    ORDER BY a."id"
  `;
}

function findLockedAccount(accounts, id) {
  const normalizedId = id.toLowerCase();
  return accounts.find((account) => account.id.toLowerCase() === normalizedId);
}

function assertAccountAvailable(account, { kind, ownerId }) {
  if (!account || account.kind !== kind || (ownerId && account.ownerId !== ownerId)) {
    throw new AppError(404, 'ACCOUNT_NOT_FOUND', 'The account was not found.');
  }
  if (account.status !== 'ACTIVE') {
    throw new AppError(409, 'ACCOUNT_NOT_ACTIVE', 'Both accounts must be active.');
  }
  if (account.cachedBalanceMinor !== account.ledgerBalanceMinor) {
    throw new AppError(
      503,
      'BALANCE_INTEGRITY_MISMATCH',
      'An account balance requires administrative verification.',
    );
  }
}

async function writeLedgerTransaction(tx, {
  actorId,
  type,
  description,
  source,
  destination,
  amountMinor,
}) {
  const id = randomUUID();
  const reference = `BV-${randomUUID()}`;
  const created = await tx.ledgerTransaction.create({
    data: {
      id,
      reference,
      type,
      description,
      createdById: actorId,
    },
    select: { id: true, reference: true, type: true, createdAt: true },
  });

  const entries = [
    { accountId: source.id, direction: 'DEBIT' },
    { accountId: destination.id, direction: 'CREDIT' },
  ].sort((left, right) => (left.accountId < right.accountId ? -1 : 1));

  for (const entry of entries) {
    await tx.ledgerEntry.create({
      data: {
        transactionId: created.id,
        accountId: entry.accountId,
        direction: entry.direction,
        amountMinor,
      },
      select: { id: true },
    });
  }

  return created;
}

async function createTransferInTransaction(tx, actor, input, key, context) {
  assertPermission(actor, 'CUSTOMER_TRANSFER_CREATE');
  assertAmountMinor(input.amountMinor);
  const expectedHash = requestHash(
    'TRANSFER',
    input.destinationAccountId,
    input.amountMinor,
  );
  const existing = await findIdempotencyRecord(tx, actor.id, key);
  if (existing) {
    return resolveIdempotencyRecord(existing, expectedHash);
  }

  const sourceReference = await tx.account.findUnique({
    where: { ownerId: actor.id },
    select: { id: true },
  });
  if (!sourceReference) {
    throw new AppError(404, 'SOURCE_ACCOUNT_NOT_FOUND', 'The source account was not found.');
  }
  if (sourceReference.id.toLowerCase() === input.destinationAccountId.toLowerCase()) {
    throw new AppError(400, 'INVALID_TRANSFER_DESTINATION', 'A transfer must use a different account.');
  }

  const locked = await lockAccounts(tx, sourceReference.id, input.destinationAccountId);
  const source = findLockedAccount(locked, sourceReference.id);
  const destination = findLockedAccount(locked, input.destinationAccountId);
  assertAccountAvailable(source, { kind: 'CUSTOMER', ownerId: actor.id });
  assertAccountAvailable(destination, { kind: 'CUSTOMER' });
  if (source.currency !== destination.currency) {
    throw new AppError(409, 'CURRENCY_MISMATCH', 'Both accounts must use the same currency.');
  }
  if (BigInt(source.ledgerBalanceMinor) < BigInt(input.amountMinor)) {
    throw new AppError(409, 'INSUFFICIENT_FUNDS', 'The source account has insufficient funds.');
  }

  const created = await writeLedgerTransaction(tx, {
    actorId: actor.id,
    type: 'TRANSFER',
    description: 'Customer transfer',
    source,
    destination,
    amountMinor: BigInt(input.amountMinor),
  });
  await tx.idempotencyRecord.create({
    data: {
      userId: actor.id,
      key,
      requestHash: expectedHash,
      transactionId: created.id,
    },
    select: { id: true },
  });
  await recordAudit(tx, {
    actorId: actor.id,
    action: 'ledger.transfer.create',
    outcome: 'SUCCESS',
    ...auditContext(context),
    targetType: 'LedgerTransaction',
    targetId: created.id,
  });
  return { transaction: transactionDto(created, input.amountMinor), replayed: false };
}

async function createFundingInTransaction(tx, actor, accountId, input, key, context) {
  assertPermission(actor, 'ADMIN_FUNDING_CREATE');
  assertAmountMinor(input.amountMinor);
  const normalizedAccountId = accountId.toLowerCase();
  const expectedHash = requestHash('FUNDING', normalizedAccountId, input.amountMinor);
  const existing = await findIdempotencyRecord(tx, actor.id, key);
  if (existing) {
    return resolveIdempotencyRecord(existing, expectedHash);
  }

  const systemAccount = await tx.account.findUnique({
    where: { accountNumber: 'BV-SYSTEM-FUNDING-INR' },
    select: { id: true, kind: true, status: true },
  });
  if (!systemAccount || systemAccount.kind !== 'SYSTEM') {
    throw new AppError(
      503,
      'SYSTEM_ACCOUNT_UNAVAILABLE',
      'The configured funding account is unavailable.',
    );
  }
  if (systemAccount.id.toLowerCase() === normalizedAccountId) {
    throw new AppError(400, 'INVALID_FUNDING_DESTINATION', 'Funding must target a customer account.');
  }

  const locked = await lockAccounts(tx, systemAccount.id, normalizedAccountId);
  const source = findLockedAccount(locked, systemAccount.id);
  const destination = findLockedAccount(locked, normalizedAccountId);
  assertAccountAvailable(source, { kind: 'SYSTEM' });
  assertAccountAvailable(destination, { kind: 'CUSTOMER' });
  if (source.currency !== destination.currency) {
    throw new AppError(409, 'CURRENCY_MISMATCH', 'Both accounts must use the same currency.');
  }

  const created = await writeLedgerTransaction(tx, {
    actorId: actor.id,
    type: 'FUNDING',
    description: 'Administrative customer funding',
    source,
    destination,
    amountMinor: BigInt(input.amountMinor),
  });
  await tx.idempotencyRecord.create({
    data: {
      userId: actor.id,
      key,
      requestHash: expectedHash,
      transactionId: created.id,
    },
    select: { id: true },
  });
  await recordAudit(tx, {
    actorId: actor.id,
    action: 'ledger.funding.create',
    outcome: 'SUCCESS',
    ...auditContext(context),
    targetType: 'LedgerTransaction',
    targetId: created.id,
  });
  return { transaction: transactionDto(created, input.amountMinor), replayed: false };
}

async function runAuditedOperation(prisma, actor, context, action, operation) {
  try {
    return await operation();
  } catch (error) {
    await auditFailure(prisma, actor, context, action, error);
    throw error;
  }
}

async function createTransfer(prisma, actor, input, key, context) {
  return runAuditedOperation(prisma, actor, context, 'ledger.transfer.create', () => (
    withIdempotency(
      prisma,
      actor,
      key,
      requestHash('TRANSFER', input.destinationAccountId, input.amountMinor),
      (tx) => createTransferInTransaction(tx, actor, input, key, context),
    )
  ));
}

async function createAdminFunding(prisma, actor, accountId, input, key, context) {
  const normalizedAccountId = accountId.toLowerCase();
  return runAuditedOperation(prisma, actor, context, 'ledger.funding.create', () => (
    withIdempotency(
      prisma,
      actor,
      key,
      requestHash('FUNDING', normalizedAccountId, input.amountMinor),
      (tx) => createFundingInTransaction(tx, actor, normalizedAccountId, input, key, context),
    )
  ));
}

async function listOwnTransactions(prisma, actor, { type, page, limit }) {
  const ownerWhere = customerResourceWhere(actor, 'transactions');
  const where = {
    ...ownerWhere,
    ...(type ? { type } : {}),
  };
  const select = {
    ...TRANSACTION_HISTORY_SELECT,
    entries: {
      where: { account: { ownerId: actor.id, kind: 'CUSTOMER' } },
      select: {
        direction: true,
        amountMinor: true,
        account: { select: { currency: true } },
      },
    },
  };
  const [transactions, total] = await Promise.all([
    prisma.ledgerTransaction.findMany({
      where,
      skip: (page - 1) * limit,
      take: limit,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select,
    }),
    prisma.ledgerTransaction.count({ where }),
  ]);
  return {
    transactions: transactions.map(historyDto),
    pagination: { page, limit, total },
  };
}

async function computeLedgerBalanceDiscrepancies(prisma) {
  const rows = await prisma.$queryRaw`
    SELECT
      a."id"::text AS "accountId",
      a."kind"::text AS "kind",
      a."balanceMinor"::text AS "cachedBalanceMinor",
      COALESCE(SUM(
        CASE e."direction"
          WHEN 'CREDIT'::public."EntryDirection" THEN e."amountMinor"
          WHEN 'DEBIT'::public."EntryDirection" THEN -e."amountMinor"
        END
      ), 0)::text AS "ledgerBalanceMinor"
    FROM public."Account" AS a
    LEFT JOIN public."LedgerEntry" AS e ON e."accountId" = a."id"
    GROUP BY a."id"
    ORDER BY a."id"
  `;
  const discrepancies = rows
    .filter((row) => BigInt(row.cachedBalanceMinor) !== BigInt(row.ledgerBalanceMinor))
    .map((row) => ({
      accountId: row.accountId,
      kind: row.kind,
      ledgerBalanceMinor: row.ledgerBalanceMinor,
      cachedBalanceMinor: row.cachedBalanceMinor,
    }));
  return { checkedAccountCount: rows.length, discrepancies };
}

async function verifyLedgerBalances(prisma, actor, context) {
  return runAuditedOperation(prisma, actor, context, 'ledger.verify', async () => {
    assertPermission(actor, 'ADMIN_LEDGER_VERIFY');
    const { checkedAccountCount, discrepancies } = await computeLedgerBalanceDiscrepancies(prisma);
    await recordAudit(prisma, {
      actorId: actor.id,
      action: 'ledger.verify',
      outcome: 'SUCCESS',
      ...auditContext(context),
      targetType: 'LedgerVerification',
      targetId: context.requestId,
      metadata: discrepancies.length > 0
        ? { reasonCode: 'BALANCE_DISCREPANCIES_FOUND' }
        : { reasonCode: 'BALANCES_MATCH' },
    });
    return {
      consistent: discrepancies.length === 0,
      checkedAccountCount,
      discrepancyCount: discrepancies.length,
      discrepancies,
      checkedAt: new Date().toISOString(),
    };
  });
}

export {
  createAdminFunding,
  createFundingInTransaction,
  createTransfer,
  createTransferInTransaction,
  computeLedgerBalanceDiscrepancies,
  listOwnTransactions,
  verifyLedgerBalances,
};
