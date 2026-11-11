import {
  decideApplication,
  getApplication,
  listApplications,
  listOwnApplications,
  submitApplication,
} from '../services/onboarding-service.js';

function requestContext(req) {
  return {
    requestId: req.requestId,
    ipAddress: typeof req.ip === 'string' ? req.ip.slice(0, 64) : null,
  };
}

function createOnboardingController({ prisma }) {
  return {
    submit: async (req, res) => {
      const application = await submitApplication(
        prisma,
        req.auth.user,
        req.validatedBody,
        requestContext(req),
      );
      return res.status(201).json({ application, requestId: req.requestId });
    },

    listOwn: async (req, res) => {
      const applications = await listOwnApplications(prisma, req.auth.user);
      return res.status(200).json({ applications, requestId: req.requestId });
    },

    listAdmin: async (req, res) => {
      const result = await listApplications(
        prisma,
        req.auth.user,
        req.validatedQuery,
      );
      return res.status(200).json({ ...result, requestId: req.requestId });
    },

    getAdmin: async (req, res) => {
      const application = await getApplication(
        prisma,
        req.auth.user,
        req.validatedParams.id,
      );
      return res.status(200).json({ application, requestId: req.requestId });
    },

    decide: async (req, res) => {
      const result = await decideApplication(
        prisma,
        req.auth.user,
        req.validatedParams.id,
        req.validatedBody,
        requestContext(req),
      );
      return res.status(200).json({
        application: result.application,
        account: result.account,
        requestId: req.requestId,
      });
    },
  };
}

export { createOnboardingController };
