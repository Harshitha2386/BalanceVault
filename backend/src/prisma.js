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
      log: [{ emit: 'event', level: 'query' }],
    });

    prisma.$on('query', (event) => {
      if (
        event.query.includes('"Session"') &&
        event.query.trimStart().startsWith('INSERT')
      ) {
        console.log(JSON.stringify({
          level: 'debug',
          event: 'prisma_session_insert_query',
          query: event.query,
        }));
      }
    });
  }

  return prisma;
}

export { getPrismaClient };
