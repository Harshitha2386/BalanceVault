import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { formatStartupError } from './error-diagnostics.js';
import { getPrismaClient } from './prisma.js';

function createShutdownHandler(server, prisma) {
  let shuttingDown = false;

  return function shutdown() {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;

    server.close(async (error) => {
      if (error) {
        process.exitCode = 1;
      }

      try {
        await prisma.$disconnect();
      } catch {
        process.exitCode = 1;
        console.error(JSON.stringify({
          level: 'error',
          event: 'prisma_disconnect_failed',
        }));
      }
    });
  };
}

async function startServer() {
  const config = loadConfig();
  const prisma = getPrismaClient(config.databaseUrl);
  const server = http.createServer(createApp({ prisma, config }));

  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(config.port, '0.0.0.0', resolve);
    });
  } catch (error) {
    try {
      await prisma.$disconnect();
    } catch {
      console.error(JSON.stringify({
        level: 'error',
        event: 'prisma_disconnect_failed',
      }));
    }
    throw error;
  }

  console.log(JSON.stringify({
    level: 'info',
    event: 'server_listening',
    port: config.port,
  }));

  const shutdown = createShutdownHandler(server, prisma);
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  return { server, shutdown };
}

const isMainModule = process.argv[1]
  && fileURLToPath(import.meta.url) === process.argv[1];

if (isMainModule) {
  startServer().catch((error) => {
    console.error(JSON.stringify({
      level: 'error',
      event: 'server_startup_failed',
      ...formatStartupError(error),
    }));
    process.exitCode = 1;
  });
}

export { createShutdownHandler, formatStartupError, startServer };
