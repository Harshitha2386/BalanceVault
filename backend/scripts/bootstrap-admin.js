import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';
import {
  assertDirectUrlTarget,
  bootstrapAdmin,
  BootstrapError,
  verifyDatabaseIdentity,
} from '../src/services/admin-bootstrap-service.js';

const CREDENTIAL_ENV = Object.freeze({
  email: 'BV_BOOTSTRAP_EMAIL',
  fullName: 'BV_BOOTSTRAP_FULL_NAME',
  password: 'BV_BOOTSTRAP_PASSWORD',
});

function bootstrapPrismaClient(directUrl) {
  return new PrismaClient({
    datasources: { db: { url: directUrl } },
  });
}

function writeLine(output, value) {
  output.write(`${value}\n`);
}

async function question(readline, output, prompt) {
  output.write(prompt);
  return readline.question('');
}

async function readHiddenPassword(input, output, prompt) {
  if (!input.isTTY || typeof input.setRawMode !== 'function') {
    throw new BootstrapError('INTERACTIVE_TTY_REQUIRED');
  }

  output.write(prompt);
  input.setRawMode(true);
  input.setEncoding('utf8');
  input.resume();

  return new Promise((resolve, reject) => {
    let value = '';
    const restore = () => {
      input.removeListener('data', onData);
      input.setRawMode(false);
      input.pause();
    };
    const onData = (chunk) => {
      for (const character of chunk) {
        if (character === '\u0003') {
          restore();
          output.write('\n');
          reject(new BootstrapError('PROMPT_CANCELLED'));
          return;
        }
        if (character === '\r' || character === '\n') {
          restore();
          output.write('\n');
          resolve(value);
          return;
        }
        if (character === '\u0008' || character === '\u007f') {
          value = [...value].slice(0, -1).join('');
        } else {
          value += character;
        }
      }
    };
    input.on('data', onData);
  });
}

async function readCredentials(environment, input, output) {
  const provided = Object.values(CREDENTIAL_ENV)
    .map((name) => environment[name]);
  if (provided.every((value) => typeof value === 'string' && value.length > 0)) {
    return {
      email: environment[CREDENTIAL_ENV.email],
      fullName: environment[CREDENTIAL_ENV.fullName],
      password: environment[CREDENTIAL_ENV.password],
    };
  }
  if (provided.some((value) => value !== undefined)) {
    throw new BootstrapError('ALL_CREDENTIAL_ENV_REQUIRED');
  }
  if (!input.isTTY) {
    throw new BootstrapError('INTERACTIVE_TTY_REQUIRED');
  }

  const { createInterface } = await import('node:readline/promises');
  const readline = createInterface({ input, output });
  try {
    const email = await question(readline, output, 'Administrator email: ');
    const fullName = await question(readline, output, 'Administrator full name: ');
    readline.close();
    const password = await readHiddenPassword(
      input,
      output,
      'Administrator password (input hidden): ',
    );
    const confirmPassword = await readHiddenPassword(
      input,
      output,
      'Confirm administrator password (input hidden): ',
    );
    if (password !== confirmPassword) {
      throw new BootstrapError('PASSWORD_CONFIRMATION_FAILED');
    }
    return { email, fullName, password };
  } finally {
    readline.close();
  }
}

function safeFailureMessage(error) {
  if (error instanceof BootstrapError) {
    return `Admin bootstrap refused: ${error.code}.`;
  }
  return 'Admin bootstrap failed safely. No internal details were printed.';
}

async function runBootstrapCli({
  environment = process.env,
  input = process.stdin,
  output = process.stdout,
  errorOutput = process.stderr,
  createClient = bootstrapPrismaClient,
  preflight = false,
} = {}) {
  const directUrl = environment.DIRECT_URL;
  const confirmation = environment.BV_BOOTSTRAP_CONFIRM_DATABASE;
  if (!directUrl) {
    writeLine(errorOutput, safeFailureMessage(new BootstrapError('DIRECT_URL_REQUIRED')));
    return 1;
  }
  if (confirmation !== 'balancevault_test') {
    writeLine(errorOutput, safeFailureMessage(
      new BootstrapError('DATABASE_CONFIRMATION_REQUIRED'),
    ));
    return 1;
  }

  let prisma;
  try {
    assertDirectUrlTarget(directUrl, confirmation);
    prisma = createClient(directUrl);
    const identity = await verifyDatabaseIdentity(prisma);
    if (preflight) {
      writeLine(
        output,
        `Database preflight passed: database=${identity.database_name} role=${identity.role_name}; no writes performed.`,
      );
      return 0;
    }

    await bootstrapAdmin({
      prisma,
      directUrl,
      confirmation,
      credentials: await readCredentials(environment, input, output),
    });
    writeLine(output, 'Admin bootstrap succeeded. Sign in and change the temporary password.');
    return 0;
  } catch (error) {
    writeLine(errorOutput, safeFailureMessage(error));
    return 1;
  } finally {
    if (prisma) {
      try {
        await prisma.$disconnect();
      } catch {
        writeLine(errorOutput, 'Database disconnect failed.');
      }
    }
  }
}

const isMainModule = process.argv[1]
  && fileURLToPath(import.meta.url) === process.argv[1];

if (isMainModule) {
  runBootstrapCli({ preflight: process.argv.includes('--preflight') }).then((exitCode) => {
    process.exitCode = exitCode;
  });
}

export {
  CREDENTIAL_ENV,
  readCredentials,
  readHiddenPassword,
  runBootstrapCli,
  safeFailureMessage,
};
