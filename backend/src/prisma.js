import { PrismaClient } from '@prisma/client';

let prisma;

function getPrismaClient(databaseUrl) {
  if (!databaseUrl) {
    throw new Error('A validated DATABASE_URL is required to initialize Prisma.');
  }

  if (!prisma) {
    prisma = new PrismaClient({
      datasources: {
        db: { url: databaseUrl },
      },
    });
  }

  return prisma;
}

export { getPrismaClient };
