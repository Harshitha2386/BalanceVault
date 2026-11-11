import { z } from 'zod';

const MAX_AMOUNT_MINOR = 100_000_000;

const amountMinorSchema = z.number()
  .int()
  .safe()
  .positive()
  .max(MAX_AMOUNT_MINOR);

const transactionListQuerySchema = z.object({
  type: z.enum(['TRANSFER', 'FUNDING', 'REVERSAL']).optional(),
  page: z.coerce.number().int().min(1).max(1000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
}).strict();

const transferBodySchema = z.object({
  destinationAccountId: z.string().uuid().transform((id) => id.toLowerCase()),
  amountMinor: amountMinorSchema,
}).strict();

const fundingBodySchema = z.object({
  amountMinor: amountMinorSchema,
}).strict();

const idempotencyKeySchema = z.string()
  .min(8)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/u);

export {
  MAX_AMOUNT_MINOR,
  fundingBodySchema,
  idempotencyKeySchema,
  transactionListQuerySchema,
  transferBodySchema,
};
