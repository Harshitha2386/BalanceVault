import { existsSync } from 'node:fs';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import helmet from 'helmet';
import { createAuthRouter } from './routes/auth-routes.js';
import { createOnboardingRouter } from './routes/onboarding-routes.js';
import { createAdminOnboardingRouter } from './routes/admin-onboarding-routes.js';
import { createAccountRouter } from './routes/account-routes.js';
import { createAdminAccountRouter } from './routes/admin-account-routes.js';
import { createLedgerRouter } from './routes/ledger-routes.js';
import { createAdminLedgerRouter } from './routes/admin-ledger-routes.js';
import { createAdminManagementRouter } from './routes/admin-management-routes.js';
import { errorHandler, notFoundHandler } from './middleware/error-handler.js';
import { requestIdMiddleware } from './middleware/request-id.js';

const FRONTEND_DIST = fileURLToPath(new URL('../../frontend/dist/', import.meta.url));

function serveFrontend(app, frontendDist) {
  const indexPath = join(frontendDist, 'index.html');
  if (!existsSync(indexPath)) {
    return;
  }

  app.use(express.static(frontendDist, {
    index: false,
    maxAge: 0,
  }));
  app.use((req, res, next) => {
    if (req.method !== 'GET' || !req.accepts('html') || extname(req.path)) {
      return next();
    }

    res.setHeader('Cache-Control', 'no-cache');
    return res.sendFile(indexPath, (error) => {
      if (error) {
        next(error);
      }
    });
  });
}

function createApp({ prisma, config, rateLimitOptions, frontendDist = FRONTEND_DIST }) {
  if (!prisma || typeof prisma.$queryRaw !== 'function') {
    throw new TypeError('createApp requires a Prisma client.');
  }
  if (!config || !Array.isArray(config.allowedOrigins) || !config.csrfSecret) {
    throw new TypeError('createApp requires validated application configuration.');
  }

  const app = express();
  app.disable('x-powered-by');
  if (config.nodeEnv === 'production') {
    app.set('trust proxy', 1);
  }
  app.use(requestIdMiddleware);
  app.use(helmet());
  app.use(express.json({ limit: '16kb', strict: true }));

  app.get('/health', (req, res) => {
    res.status(200).json({ status: 'ok', requestId: req.requestId });
  });

  app.get('/ready', async (req, res) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      res.status(200).json({ status: 'ready', requestId: req.requestId });
    } catch {
      res.status(503).json({
        status: 'not_ready',
        error: {
          code: 'DATABASE_UNAVAILABLE',
          message: 'Database connectivity is unavailable.',
          requestId: req.requestId,
        },
      });
    }
  });

  app.use('/api/auth', createAuthRouter({ prisma, config, rateLimitOptions }));
  app.use('/api/onboarding', createOnboardingRouter({ prisma, config }));
  app.use('/api/accounts', createAccountRouter({ prisma, config }));
  app.use(
    '/api/admin/onboarding/applications',
    createAdminOnboardingRouter({ prisma, config }),
  );
  app.use('/api/admin/accounts', createAdminAccountRouter({ prisma, config }));
  app.use('/api', createLedgerRouter({ prisma, config }));
  app.use('/api/admin/ledger', createAdminLedgerRouter({ prisma, config }));
  app.use('/api/admin', createAdminManagementRouter({ prisma, config }));
  app.use('/api', notFoundHandler);
  serveFrontend(app, frontendDist);
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

export { createApp };
