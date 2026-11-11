import {
  createAdminFunding,
  createTransfer,
  listOwnTransactions,
  verifyLedgerBalances,
} from '../services/ledger-service.js';

function requestContext(req) {
  return {
    requestId: req.requestId,
    ipAddress: typeof req.ip === 'string' ? req.ip.slice(0, 64) : null,
  };
}

function createLedgerController({ prisma }) {
  return {
    listOwn: async (req, res) => {
      const result = await listOwnTransactions(
        prisma,
        req.auth.user,
        req.validatedQuery,
      );
      return res.status(200).json({ ...result, requestId: req.requestId });
    },

    transfer: async (req, res) => {
      const result = await createTransfer(
        prisma,
        req.auth.user,
        req.validatedBody,
        req.idempotencyKey,
        requestContext(req),
      );
      return res.status(result.replayed ? 200 : 201).json({
        ...result,
        requestId: req.requestId,
      });
    },

    fund: async (req, res) => {
      const result = await createAdminFunding(
        prisma,
        req.auth.user,
        req.validatedParams.id,
        req.validatedBody,
        req.idempotencyKey,
        requestContext(req),
      );
      return res.status(result.replayed ? 200 : 201).json({
        ...result,
        requestId: req.requestId,
      });
    },

    verify: async (req, res) => {
      const result = await verifyLedgerBalances(
        prisma,
        req.auth.user,
        requestContext(req),
      );
      return res.status(200).json({ ...result, requestId: req.requestId });
    },
  };
}

export { createLedgerController };
