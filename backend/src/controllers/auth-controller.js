import { getCookie, clearAuthCookies, clearCsrfCookie, setSessionCookie } from '../auth/cookies.js';
import { loginUser, logoutSession, registerUser } from '../services/auth-service.js';

function requestContext(req) {
  return {
    requestId: req.requestId,
    ipAddress: typeof req.ip === 'string' ? req.ip.slice(0, 64) : null,
  };
}

function createAuthController({ prisma, config }) {
  const isProduction = config.nodeEnv === 'production';

  return {
    register: async (req, res) => {
      const user = await registerUser(prisma, req.validatedBody, requestContext(req));
      return res.status(201).json({ user, requestId: req.requestId });
    },

    login: async (req, res) => {
      const result = await loginUser(
        prisma,
        req.validatedBody,
        requestContext(req),
        getCookie(req, 'bv_session'),
      );
      clearCsrfCookie(res, isProduction);
      setSessionCookie(
        res,
        result.token,
        isProduction,
        Math.floor((result.expiresAt.getTime() - Date.now()) / 1000),
      );
      return res.status(200).json({ user: result.user, requestId: req.requestId });
    },

    logout: async (req, res) => {
      await logoutSession(prisma, req.auth.session, req.auth.user, requestContext(req));
      clearAuthCookies(res, isProduction);
      return res.status(204).end();
    },

    me: (req, res) => res.status(200).json({
      user: req.auth.user,
      requestId: req.requestId,
    }),

  };
}

export { createAuthController };
