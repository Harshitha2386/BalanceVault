import {
  changeAccountStatus,
  getAdminAccount,
  getOwnAccount,
  listAdminAccounts,
  listOwnAccounts,
} from '../services/account-service.js';

function requestContext(req) {
  return {
    requestId: req.requestId,
    ipAddress: typeof req.ip === 'string' ? req.ip.slice(0, 64) : null,
  };
}

function createAccountController({ prisma }) {
  return {
    listOwn: async (req, res) => {
      const accounts = await listOwnAccounts(prisma, req.auth.user);
      return res.status(200).json({ accounts, requestId: req.requestId });
    },

    getOwn: async (req, res) => {
      const account = await getOwnAccount(
        prisma,
        req.auth.user,
        req.validatedParams.id,
      );
      return res.status(200).json({ account, requestId: req.requestId });
    },

    listAdmin: async (req, res) => {
      const result = await listAdminAccounts(
        prisma,
        req.auth.user,
        req.validatedQuery,
      );
      return res.status(200).json({ ...result, requestId: req.requestId });
    },

    getAdmin: async (req, res) => {
      const account = await getAdminAccount(
        prisma,
        req.auth.user,
        req.validatedParams.id,
      );
      return res.status(200).json({ account, requestId: req.requestId });
    },

    changeStatus: async (req, res) => {
      const account = await changeAccountStatus(
        prisma,
        req.auth.user,
        req.validatedParams.id,
        req.validatedBody.status,
        requestContext(req),
      );
      return res.status(200).json({ account, requestId: req.requestId });
    },
  };
}

export { createAccountController };
