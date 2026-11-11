import { z } from 'zod';

function isStrongPassword(password) {
  const categories = [
    /[a-z]/u.test(password),
    /[A-Z]/u.test(password),
    /[0-9]/u.test(password),
    /[^A-Za-z0-9]/u.test(password),
  ];

  return [...password].length >= 12
    && [...password].length <= 128
    && Buffer.byteLength(password, 'utf8') <= 512
    && categories.filter(Boolean).length >= 3;
}

const emailSchema = z.string()
  .trim()
  .email()
  .max(254)
  .transform((email) => email.toLowerCase());

const registrationSchema = z.object({
  email: emailSchema,
  fullName: z.string().trim().min(2).max(120),
  password: z.string().refine(isStrongPassword),
}).strict();

const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1).max(128),
}).strict();

export { isStrongPassword, loginSchema, registrationSchema };
