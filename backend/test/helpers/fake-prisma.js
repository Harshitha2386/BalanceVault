import { randomUUID } from 'node:crypto';

function clone(value) {
  return structuredClone(value);
}

function matchesWhere(value, where) {
  return Object.entries(where).every(([key, expected]) => {
    if (expected && typeof expected === 'object' && 'lte' in expected) {
      return new Date(value[key]) <= new Date(expected.lte);
    }
    return value[key] === expected;
  });
}

function transactionMatchesWhere(transaction, where, entries, accounts) {
  for (const [key, expected] of Object.entries(where || {})) {
    if (key === 'entries' && expected?.some) {
      const filters = expected.some;
      const matchesEntry = entries.some((entry) => {
        if (entry.transactionId !== transaction.id) {
          return false;
        }
        const accountFilter = filters.account || {};
        const account = accounts.get(entry.accountId);
        return account && matchesWhere(account, accountFilter);
      });
      if (!matchesEntry) {
        return false;
      }
    } else if (transaction[key] !== expected) {
      return false;
    }
  }
  return true;
}

class FakePrisma {
  constructor() {
    this.users = new Map();
    this.sessions = new Map();
    this.applications = new Map();
    this.accounts = new Map();
    this.auditRows = [];
    this.ledgerTransactions = new Map();
    this.ledgerEntries = [];
    this.idempotencyRecords = new Map();
    this.transactionTail = Promise.resolve();
    this.failAudit = false;

    this.user = {
      findUnique: async ({ where, select }) => {
        const row = [...this.users.values()].find((user) => matchesWhere(user, where));
        return row ? selectFields(row, select) : null;
      },
      findMany: async ({ where = {}, skip = 0, take, orderBy, select }) => {
        let rows = [...this.users.values()].filter((user) => matchesWhere(user, where));
        if (orderBy) {
          rows.sort((a, b) => (
            new Date(b.createdAt) - new Date(a.createdAt)
            || b.id.localeCompare(a.id)
          ));
        }
        rows = rows.slice(skip, take === undefined ? undefined : skip + take);
        return rows.map((row) => selectFields(row, select));
      },
      count: async ({ where = {} }) => (
        [...this.users.values()].filter((user) => matchesWhere(user, where)).length
      ),
      update: async ({ where, data, select }) => {
        const row = [...this.users.values()].find((user) => matchesWhere(user, where));
        if (!row) {
          throw Object.assign(new Error('missing user'), { code: 'P2025' });
        }
        applyData(row, data);
        return selectFields(row, select);
      },
      updateMany: async ({ where, data }) => {
        const rows = [...this.users.values()].filter((user) => matchesWhere(user, where));
        for (const row of rows) {
          applyData(row, data);
        }
        return { count: rows.length };
      },
    };

    this.session = {
      findUnique: async ({ where, include }) => {
        const row = [...this.sessions.values()].find((session) => matchesWhere(session, where));
        if (!row) {
          return null;
        }
        const result = clone(row);
        if (include?.user) {
          const user = this.users.get(row.userId);
          result.user = user ? selectFields(user, include.user.select) : null;
        }
        return result;
      },
      create: async ({ data }) => {
        if ([...this.sessions.values()].some((row) => row.tokenHash === data.tokenHash)) {
          throw Object.assign(new Error('duplicate session'), { meta: { code: '23505' } });
        }
        const now = new Date();
        const row = {
          id: randomUUID(),
          tokenHash: data.tokenHash,
          userId: data.userId,
          ipAddress: data.ipAddress ?? null,
          userAgent: data.userAgent ?? null,
          createdAt: now,
          lastSeenAt: now,
          expiresAt: data.expiresAt,
          revokedAt: null,
        };
        this.sessions.set(row.id, row);
        return clone(row);
      },
      updateMany: async ({ where, data }) => {
        let count = 0;
        for (const row of this.sessions.values()) {
          if (matchesWhere(row, where)) {
            applyData(row, data);
            count += 1;
          }
        }
        return { count };
      },
      delete: async ({ where }) => {
        const row = [...this.sessions.values()].find((session) => matchesWhere(session, where));
        if (!row) {
          throw Object.assign(new Error('missing session'), { code: 'P2025' });
        }
        this.sessions.delete(row.id);
        return clone(row);
      },
    };

    this.auditLog = {
      create: async ({ data }) => {
        if (this.failAudit) {
          throw new Error('synthetic audit write failure');
        }
        const row = {
          id: BigInt(this.auditRows.length + 1),
          createdAt: new Date(),
          ...clone(data),
        };
        this.auditRows.push(row);
        return { id: row.id };
      },
      count: async ({ where }) => this.auditRows.filter((row) => matchesWhere(row, where)).length,
      findMany: async ({ where = {}, skip = 0, take, orderBy, select }) => {
        let rows = this.auditRows.filter((row) => matchesWhere(row, where));
        if (orderBy) {
          rows = [...rows].sort((a, b) => (
            new Date(b.createdAt) - new Date(a.createdAt)
            || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0)
          ));
        }
        rows = rows.slice(skip, take === undefined ? undefined : skip + take);
        return rows.map((row) => selectFields(row, select));
      },
    };

    this.onboardingApplication = {
      findUnique: async ({ where, select }) => {
        const row = [...this.applications.values()].find((application) => (
          matchesWhere(application, where)
        ));
        return row ? shapeApplication(row, select, this.users) : null;
      },
      findMany: async ({ where = {}, skip = 0, take, orderBy, select }) => {
        let rows = [...this.applications.values()]
          .filter((application) => matchesWhere(application, where));
        if (orderBy) {
          rows.sort((a, b) => (
            new Date(b.createdAt) - new Date(a.createdAt)
            || b.id.localeCompare(a.id)
          ));
        }
        rows = rows.slice(skip, take === undefined ? undefined : skip + take);
        return rows.map((row) => shapeApplication(row, select, this.users));
      },
      count: async ({ where = {} }) => (
        [...this.applications.values()].filter((row) => matchesWhere(row, where)).length
      ),
      updateMany: async ({ where, data }) => {
        const rows = [...this.applications.values()].filter((application) => (
          matchesWhere(application, where)
        ));
        for (const row of rows) {
          applyData(row, data);
        }
        return { count: rows.length };
      },
    };

    this.account = {
      findUnique: async ({ where, select }) => {
        const row = [...this.accounts.values()].find((account) => matchesWhere(account, where));
        return row ? shapeAccount(row, select, this.users) : null;
      },
      findFirst: async ({ where, select }) => {
        const row = [...this.accounts.values()].find((account) => matchesWhere(account, where));
        return row ? shapeAccount(row, select, this.users) : null;
      },
      findMany: async ({ where = {}, skip = 0, take, orderBy, select }) => {
        let rows = [...this.accounts.values()].filter((account) => matchesWhere(account, where));
        if (orderBy) {
          rows.sort((a, b) => (
            new Date(b.createdAt) - new Date(a.createdAt)
            || b.id.localeCompare(a.id)
          ));
        }
        rows = rows.slice(skip, take === undefined ? undefined : skip + take);
        return rows.map((row) => shapeAccount(row, select, this.users));
      },
      count: async ({ where = {} }) => (
        [...this.accounts.values()].filter((account) => matchesWhere(account, where)).length
      ),
      updateMany: async ({ where, data }) => {
        const rows = [...this.accounts.values()].filter((account) => matchesWhere(account, where));
        for (const row of rows) {
          applyData(row, data);
        }
        return { count: rows.length };
      },
    };

    this.ledgerTransaction = {
      findMany: async ({ where = {}, skip = 0, take, orderBy, select }) => {
        let rows = [...this.ledgerTransactions.values()]
          .filter((transaction) => transactionMatchesWhere(
            transaction,
            where,
            this.ledgerEntries,
            this.accounts,
          ));
        if (orderBy) {
          rows.sort((a, b) => (
            new Date(b.createdAt) - new Date(a.createdAt)
            || b.id.localeCompare(a.id)
          ));
        }
        rows = rows.slice(skip, take === undefined ? undefined : skip + take);
        return rows.map((row) => shapeTransaction(
          row,
          select,
          this.ledgerEntries,
          this.accounts,
        ));
      },
      count: async ({ where = {} }) => (
        [...this.ledgerTransactions.values()].filter((transaction) => (
          transactionMatchesWhere(
            transaction,
            where,
            this.ledgerEntries,
            this.accounts,
          )
        )).length
      ),
      create: async ({ data, select }) => {
        if ([...this.ledgerTransactions.values()].some((row) => row.reference === data.reference)) {
          throw Object.assign(new Error('duplicate reference'), { code: 'P2002' });
        }
        const row = {
          id: data.id ?? randomUUID(),
          reference: data.reference,
          type: data.type,
          description: data.description ?? null,
          createdById: data.createdById ?? null,
          createdAt: data.createdAt ?? new Date(),
        };
        this.ledgerTransactions.set(row.id, row);
        return selectFields(row, select);
      },
    };

    this.ledgerEntry = {
      create: async ({ data, select }) => {
        const account = this.accounts.get(data.accountId);
        if (!account || !this.ledgerTransactions.has(data.transactionId)) {
          throw Object.assign(new Error('missing ledger relation'), { code: 'P2003' });
        }
        const delta = data.direction === 'CREDIT' ? data.amountMinor : -data.amountMinor;
        const newBalance = account.balanceMinor + delta;
        if (account.kind === 'CUSTOMER' && newBalance < 0n) {
          throw Object.assign(new Error('customer balance check'), { code: 'P2004' });
        }
        account.balanceMinor = newBalance;
        const row = {
          id: BigInt(this.ledgerEntries.length + 1),
          transactionId: data.transactionId,
          accountId: data.accountId,
          direction: data.direction,
          amountMinor: data.amountMinor,
          createdAt: new Date(),
        };
        this.ledgerEntries.push(row);
        return selectFields(row, select);
      },
    };

    this.idempotencyRecord = {
      findUnique: async ({ where, select }) => {
        const compound = where.userId_key;
        const record = this.idempotencyRecords.get(`${compound.userId}:${compound.key}`);
        if (!record) {
          return null;
        }
        if (!select) {
          return clone(record);
        }
        const result = {};
        if (select.requestHash) {
          result.requestHash = record.requestHash;
        }
        if (select.transaction?.select) {
          const transaction = this.ledgerTransactions.get(record.transactionId);
          result.transaction = transaction
            ? shapeTransaction(
              transaction,
              select.transaction.select,
              this.ledgerEntries,
              this.accounts,
            )
            : null;
        }
        return result;
      },
      create: async ({ data, select }) => {
        const key = `${data.userId}:${data.key}`;
        if (this.idempotencyRecords.has(key)) {
          throw Object.assign(new Error('duplicate idempotency key'), { code: 'P2002' });
        }
        const row = { id: randomUUID(), ...clone(data), createdAt: new Date() };
        this.idempotencyRecords.set(key, row);
        return selectFields(row, select);
      },
    };
  }

  async $queryRaw(strings, ...values) {
    const query = strings.join('?');
    if (query.includes('FROM public."Account" AS a') && query.includes('FOR UPDATE')) {
      const ids = new Set(values.map(String));
      return [...this.accounts.values()]
        .filter((account) => ids.has(account.id))
        .sort((left, right) => (left.id < right.id ? -1 : 1))
        .map((account) => ({ id: account.id }));
    }
    if (
      query.includes('FROM public."Account" AS a')
      && query.includes('ledgerBalanceMinor')
      && !query.includes('LEFT JOIN public."LedgerEntry"')
    ) {
      const ids = new Set(values.map(String));
      return [...this.accounts.values()]
        .filter((account) => ids.has(account.id))
        .sort((left, right) => (left.id < right.id ? -1 : 1))
        .map((account) => {
          let ledgerBalance = 0n;
          for (const entry of this.ledgerEntries) {
            if (entry.accountId === account.id) {
              ledgerBalance += entry.direction === 'CREDIT'
                ? entry.amountMinor
                : -entry.amountMinor;
            }
          }
          return {
            id: account.id,
            ownerId: account.ownerId,
            kind: account.kind,
            status: account.status,
            currency: account.currency,
            cachedBalanceMinor: account.balanceMinor.toString(),
            ledgerBalanceMinor: ledgerBalance.toString(),
          };
        });
    }
    if (query.includes('LEFT JOIN public."LedgerEntry"')) {
      return [...this.accounts.values()].map((account) => {
        let ledgerBalance = 0n;
        for (const entry of this.ledgerEntries) {
          if (entry.accountId === account.id) {
            ledgerBalance += entry.direction === 'CREDIT'
              ? entry.amountMinor
              : -entry.amountMinor;
          }
        }
        return {
          accountId: account.id,
          kind: account.kind,
          cachedBalanceMinor: account.balanceMinor.toString(),
          ledgerBalanceMinor: ledgerBalance.toString(),
        };
      });
    }
    if (query.includes('INSERT INTO public."User"')) {
      const [id, email, fullName, passwordHash, updatedAt] = values;
      if ([...this.users.values()].some((row) => row.email === email)) {
        return [];
      }
      this.users.set(id, {
        id,
        email,
        fullName,
        passwordHash,
        role: 'ACCOUNT_HOLDER',
        status: 'ACTIVE',
        mustChangePassword: false,
        failedLoginCount: 0,
        lockedUntil: null,
        createdAt: new Date(),
        updatedAt,
      });
      return [{ id, email }];
    }
    if (query.includes('INSERT INTO public."OnboardingApplication"')) {
      const [id, userId, legalName, dateOfBirth, phone, addressLine, city, country, updatedAt] = values;
      const hasActiveApplication = [...this.applications.values()].some((row) => (
        row.userId === userId && ['PENDING', 'APPROVED'].includes(row.status)
      ));
      if (hasActiveApplication) {
        return [];
      }
      const now = new Date();
      this.applications.set(id, {
        id,
        userId,
        status: 'PENDING',
        legalName,
        dateOfBirth: new Date(dateOfBirth),
        phone,
        addressLine,
        city,
        country,
        reviewedById: null,
        reviewedAt: null,
        reviewNote: null,
        createdAt: now,
        updatedAt,
      });
      return [{ id }];
    }
    if (query.includes('INSERT INTO public."Account"')) {
      const [id, accountNumber, ownerId, updatedAt] = values;
      if ([...this.accounts.values()].some((row) => (
        row.accountNumber === accountNumber || (ownerId && row.ownerId === ownerId)
      ))) {
        return [];
      }
      const now = new Date();
      this.accounts.set(id, {
        id,
        accountNumber,
        kind: 'CUSTOMER',
        status: 'ACTIVE',
        currency: 'INR',
        balanceMinor: 0n,
        ownerId,
        createdAt: now,
        updatedAt,
      });
      return [{ id }];
    }
    return [{ '?column?': 1 }];
  }

  async $transaction(callback) {
    let release;
    const previous = this.transactionTail;
    this.transactionTail = new Promise((resolve) => {
      release = resolve;
    });
    await previous;
    const snapshot = {
      users: clone(this.users),
      sessions: clone(this.sessions),
      applications: clone(this.applications),
      accounts: clone(this.accounts),
      auditRows: clone(this.auditRows),
      ledgerTransactions: clone(this.ledgerTransactions),
      ledgerEntries: clone(this.ledgerEntries),
      idempotencyRecords: clone(this.idempotencyRecords),
    };
    try {
      const result = await callback(this);
      const newTransactionIds = [...this.ledgerTransactions.keys()]
        .filter((id) => !snapshot.ledgerTransactions.has(id));
      for (const id of newTransactionIds) {
        const entries = this.ledgerEntries.filter((entry) => entry.transactionId === id);
        const debits = entries
          .filter((entry) => entry.direction === 'DEBIT')
          .reduce((sum, entry) => sum + entry.amountMinor, 0n);
        const credits = entries
          .filter((entry) => entry.direction === 'CREDIT')
          .reduce((sum, entry) => sum + entry.amountMinor, 0n);
        if (entries.length < 2 || debits !== credits) {
          throw Object.assign(new Error('deferred ledger balance constraint'), { code: 'P2004' });
        }
      }
      return result;
    } catch (error) {
      this.users = snapshot.users;
      this.sessions = snapshot.sessions;
      this.applications = snapshot.applications;
      this.accounts = snapshot.accounts;
      this.auditRows = snapshot.auditRows;
      this.ledgerTransactions = snapshot.ledgerTransactions;
      this.ledgerEntries = snapshot.ledgerEntries;
      this.idempotencyRecords = snapshot.idempotencyRecords;
      throw error;
    } finally {
      release();
    }
  }
}

function applyData(row, data) {
  for (const [key, value] of Object.entries(data)) {
    row[key] = value && typeof value === 'object' && 'increment' in value
      ? row[key] + value.increment
      : clone(value);
  }
}

function selectFields(row, select) {
  if (!select) {
    return clone(row);
  }
  return Object.fromEntries(
    Object.entries(select).filter(([, included]) => included).map(([key]) => [key, clone(row[key])]),
  );
}

function shapeApplication(row, select, users) {
  if (!select) {
    return clone(row);
  }
  const result = {};
  for (const [key, selection] of Object.entries(select)) {
    if (selection === true) {
      result[key] = clone(row[key]);
    } else if (selection && typeof selection === 'object' && selection.select) {
      const related = key === 'user'
        ? users.get(row.userId)
        : key === 'reviewedBy'
          ? users.get(row.reviewedById)
          : null;
      result[key] = related ? selectFields(related, selection.select) : null;
    }
  }
  return result;
}

function shapeAccount(row, select, users) {
  if (!select) {
    return clone(row);
  }
  const result = {};
  for (const [key, selection] of Object.entries(select)) {
    if (selection === true) {
      result[key] = clone(row[key]);
    } else if (key === 'owner' && selection?.select) {
      const owner = row.ownerId ? users.get(row.ownerId) : null;
      result.owner = owner ? selectFields(owner, selection.select) : null;
    }
  }
  return result;
}

function shapeTransaction(row, select, entries, accounts) {
  if (!select) {
    return clone(row);
  }
  const result = {};
  for (const [key, selection] of Object.entries(select)) {
    if (selection === true) {
      result[key] = clone(row[key]);
    } else if (key === 'entries' && selection?.select) {
      result.entries = entries
        .filter((entry) => entry.transactionId === row.id)
        .filter((entry) => {
          const accountFilter = selection.where?.account;
          return !accountFilter || matchesWhere(accounts.get(entry.accountId), accountFilter);
        })
        .map((entry) => {
          const shaped = {};
          for (const [entryKey, include] of Object.entries(selection.select)) {
            if (include === true) {
              shaped[entryKey] = clone(entry[entryKey]);
            } else if (entryKey === 'account' && include?.select) {
              shaped.account = selectFields(accounts.get(entry.accountId), include.select);
            }
          }
          return shaped;
        });
    }
  }
  return result;
}

export { FakePrisma };
