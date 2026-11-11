import { z } from 'zod';

function isValidDateOnly(value) {
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime())
    && date.toISOString().slice(0, 10) === value
    && date <= new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`);
}

const applicationSubmissionSchema = z.object({
  legalName: z.string().trim().min(2).max(120),
  dateOfBirth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u).refine(isValidDateOnly)
    .transform((value) => new Date(`${value}T00:00:00.000Z`)),
  phone: z.string().trim().regex(/^[+0-9(). -]{7,20}$/u)
    .refine((value) => value.replace(/\D/gu, '').length >= 7),
  addressLine: z.string().trim().min(3).max(200),
  city: z.string().trim().min(2).max(100),
  country: z.string().trim().regex(/^[A-Za-z]{2}$/u)
    .transform((value) => value.toUpperCase()),
}).strict();

const applicationDecisionSchema = z.object({
  decision: z.enum(['APPROVED', 'REJECTED']),
  reviewNote: z.string().trim().min(1).max(500).optional(),
}).strict();

const applicationListQuerySchema = z.object({
  status: z.enum(['PENDING', 'APPROVED', 'REJECTED']).optional(),
  page: z.coerce.number().int().min(1).max(1000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
}).strict();

const applicationIdParamsSchema = z.object({
  id: z.string().uuid(),
}).strict();

export {
  applicationDecisionSchema,
  applicationIdParamsSchema,
  applicationListQuerySchema,
  applicationSubmissionSchema,
};
