import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { getPrismaClient } from './prisma.js';

function redactStartupText(value, environment) {
  let text = String(value);
  const secretValues = Object.entries(environment)
    .filter(([name, secret]) => (
      /(?:_URL$|PASSWORD|PASSWD|SECRET|TOKEN|CREDENTIAL|API[_-]?KEY|PRIVATE[_-]?KEY|AUTHORIZATION)/i
        .test(name)
      && typeof secret === 'string'
      && secret.length >= 4
    ))
    .map(([, secret]) => secret)
    .sort((left, right) => right.length - left.length);

  for (const secret of secretValues) {
    text = text.split(secret).join('[REDACTED]');
  }

  return text
    .replace(
      /\b(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|redis|rediss|amqps?):\/\/[^\s"'<>]+/gi,
      '[REDACTED_CONNECTION_STRING]',
    )
    .replace(
      /\b(password|passwd|pwd|token|secret|api[_-]?key|access[_-]?key|authorization)\s*([=:])\s*(?:"[^"]*"|'[^']*'|[^\s,;&]+)/gi,
      '$1$2[REDACTED]',
    )
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [REDACTED]');
}

function formatStartupError(error, environment = process.env) {
  const normalizedError = error instanceof Error ? error : new Error(String(error));

  return {
    errorName: redactStartupText(normalizedError.name || 'Error', environment),
    errorMessage: redactStartupText(normalizedError.message, environment),
    stack: redactStartupText(
      normalizedError.stack || `${normalizedError.name}: ${normalizedError.message}`,
      environment,
    ),
  };
}

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
