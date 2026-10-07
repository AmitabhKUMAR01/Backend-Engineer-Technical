import { z } from 'zod';

const csv = z
  .string()
  .default('')
  .transform((value) =>
    value
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean),
  );

const bool = z
  .enum(['true', 'false'])
  .default('true')
  .transform((value) => value === 'true');

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().min(1),

  /// Comma-separated keys accepted in the `x-api-key` header (ERP backend -> payment module).
  API_KEYS: csv.refine((keys) => keys.length > 0, 'At least one API key is required'),

  CASHFREE_ENV: z.enum(['sandbox', 'production']).default('sandbox'),
  CASHFREE_CLIENT_ID: z.string().min(1),
  CASHFREE_CLIENT_SECRET: z.string().min(1),
  CASHFREE_API_VERSION: z.string().default('2025-01-01'),
  CASHFREE_TIMEOUT_MS: z.coerce.number().int().positive().default(10000),

  /// Public base URL of this service; used to build return_url / notify_url sent to Cashfree.
  PUBLIC_BASE_URL: z.string().url(),
  /// Where the browser lands after payment when the order has no custom return URL.
  DEFAULT_FRONTEND_RETURN_URL: z.string().url(),
  /// Origins a caller-supplied return URL may point to (open-redirect protection).
  ALLOWED_RETURN_ORIGINS: csv,

  PAYMENT_ORDER_TTL_MINUTES: z.coerce.number().int().min(16).max(43200).default(30),

  /// ERP endpoint that receives payment outcome notifications (outbox). Empty = log only.
  ERP_WEBHOOK_URL: z.string().url().optional().or(z.literal('').transform(() => undefined)),
  ERP_WEBHOOK_SECRET: z.string().default(''),

  JOBS_ENABLED: bool,
  RECONCILE_INTERVAL_SECONDS: z.coerce.number().int().positive().default(60),
  /// An open order/refund is re-checked against Cashfree if not synced for this long.
  RECONCILE_STALE_AFTER_SECONDS: z.coerce.number().int().positive().default(300),
  OUTBOX_INTERVAL_SECONDS: z.coerce.number().int().positive().default(10),
  OUTBOX_MAX_ATTEMPTS: z.coerce.number().int().positive().default(10),
});

export type Env = z.infer<typeof envSchema>;

export function validateEnv(raw: Record<string, unknown>): Env {
  const parsed = envSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return parsed.data;
}
