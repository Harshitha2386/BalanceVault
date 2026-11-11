import { randomBytes } from 'node:crypto';
import { z } from 'zod';

function isPostgresUrl(value) {
  try {
    return ['postgres:', 'postgresql:'].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

const configSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATABASE_URL: z
    .string()
    .url()
    .refine(isPostgresUrl),
  APP_ORIGINS: z.string().optional(),
  CSRF_SECRET: z.string().optional(),
}).strict();

function loadConfig(environment = process.env) {
  const result = configSchema.safeParse({
    NODE_ENV: environment.NODE_ENV,
    PORT: environment.PORT,
    DATABASE_URL: environment.DATABASE_URL,
    APP_ORIGINS: environment.APP_ORIGINS,
    CSRF_SECRET: environment.CSRF_SECRET,
  });

  const issues = result.success ? [] : result.error.issues;
  const originValue = result.success ? result.data.APP_ORIGINS : environment.APP_ORIGINS;
  const csrfSecret = result.success ? result.data.CSRF_SECRET : environment.CSRF_SECRET;
  const nodeEnv = result.success ? result.data.NODE_ENV : environment.NODE_ENV || 'development';

  if (nodeEnv === 'production' && !originValue) {
    issues.push({ path: ['APP_ORIGINS'] });
  }
  if (nodeEnv === 'production' && (!csrfSecret || csrfSecret.length < 32)) {
    issues.push({ path: ['CSRF_SECRET'] });
  }

  let allowedOrigins;
  if (originValue) {
    allowedOrigins = originValue.split(',').map((value) => value.trim());
    if (allowedOrigins.some((value) => {
      try {
        const parsed = new URL(value);
        return parsed.origin !== value
          || !['http:', 'https:'].includes(parsed.protocol)
          || (nodeEnv === 'production' && parsed.protocol !== 'https:');
      } catch {
        return true;
      }
    })) {
      issues.push({ path: ['APP_ORIGINS'] });
    }
  } else {
    allowedOrigins = ['http://localhost:5173'];
  }

  if (csrfSecret && csrfSecret.length < 32) {
    issues.push({ path: ['CSRF_SECRET'] });
  }

  if (issues.length > 0) {
    const invalidNames = [...new Set(
      issues.map((issue) => issue.path[0]).filter(Boolean),
    )];
    throw new Error(`Invalid configuration: ${invalidNames.join(', ')}`);
  }

  if (!result.success) {
    throw new Error('Invalid configuration.');
  }

  return {
    nodeEnv: result.data.NODE_ENV,
    port: result.data.PORT,
    databaseUrl: result.data.DATABASE_URL,
    allowedOrigins,
    csrfSecret: csrfSecret || randomBytes(32).toString('base64url'),
  };
}

export { loadConfig };
