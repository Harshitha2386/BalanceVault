import {
  changeUserStatus,
  getAdminUser,
  listAdminAuditLogs,
  listAdminUsers,
} from '../services/admin-management-service.js';

function requestContext(req) {
  return {
    requestId: req.requestId,
    ipAddress: typeof req.ip === 'string' ? req.ip.slice(0, 64) : null,
  };
}

function createAdminManagementController({ prisma }) {
  return {
    listUsers: async (req, res) => {
      const result = await listAdminUsers(
        prisma,
        req.auth.user,
        req.validatedQuery,
      );
      return res.status(200).json({ ...result, requestId: req.requestId });
    },

    getUser: async (req, res) => {
      const user = await getAdminUser(prisma, req.auth.user, req.validatedParams.id);
      return res.status(200).json({ user, requestId: req.requestId });
    },

    changeUserStatus: async (req, res) => {
      const user = await changeUserStatus(
        prisma,
        req.auth.user,
        req.validatedParams.id,
        req.validatedBody.status,
        requestContext(req),
      );
      return res.status(200).json({ user, requestId: req.requestId });
    },

    listAuditLogs: async (req, res) => {
      const result = await listAdminAuditLogs(
        prisma,
        req.auth.user,
        req.validatedQuery,
        requestContext(req),
      );
      return res.status(200).json({ ...result, requestId: req.requestId });
    },
  };
}

export { createAdminManagementController };
