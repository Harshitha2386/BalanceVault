import { z } from 'zod';

const adminUserListQuerySchema = z.object({
  status: z.enum(['ACTIVE', 'DISABLED']).optional(),
  role: z.enum(['ACCOUNT_HOLDER', 'ADMIN']).optional(),
  page: z.coerce.number().int().min(1).max(1000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
}).strict();

const adminUserStatusSchema = z.object({
  status: z.enum(['ACTIVE', 'DISABLED']),
}).strict();

const adminUserIdParamsSchema = z.object({
  id: z.string().uuid(),
}).strict();

const auditLogQuerySchema = z.object({
  action: z.string().trim().min(1).max(64).optional(),
  outcome: z.enum(['SUCCESS', 'DENIED', 'FAILURE']).optional(),
  targetType: z.string().trim().min(1).max(64).optional(),
  page: z.coerce.number().int().min(1).max(1000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
}).strict();

export {
  adminUserIdParamsSchema,
  adminUserListQuerySchema,
  adminUserStatusSchema,
  auditLogQuerySchema,
};
