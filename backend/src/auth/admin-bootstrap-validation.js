import { z } from 'zod';
import { isStrongPassword } from './validation.js';

const adminBootstrapCredentialsSchema = z.object({
  email: z.string().trim().email().max(254).transform((email) => email.toLowerCase()),
  fullName: z.string().trim().min(2).max(120),
  password: z.string().refine(isStrongPassword),
}).strict();

export { adminBootstrapCredentialsSchema };
