import { z } from 'zod';

const accountIdParamsSchema = z.object({
  id: z.string().uuid(),
}).strict();

const accountListQuerySchema = z.object({
  status: z.enum(['ACTIVE', 'FROZEN', 'CLOSED']).optional(),
  kind: z.enum(['CUSTOMER', 'SYSTEM']).optional(),
  page: z.coerce.number().int().min(1).max(1000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
}).strict();

const accountStatusSchema = z.object({
  status: z.enum(['ACTIVE', 'FROZEN', 'CLOSED']),
}).strict();

export {
  accountIdParamsSchema,
  accountListQuerySchema,
  accountStatusSchema,
};
