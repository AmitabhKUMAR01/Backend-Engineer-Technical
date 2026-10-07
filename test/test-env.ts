export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgresql://ums:ums@localhost:5433/ums_payments_test?schema=public';

export const TEST_ENV: Record<string, string> = {
  NODE_ENV: 'test',
  DATABASE_URL: TEST_DATABASE_URL,
  API_KEYS: 'test-api-key',
  CASHFREE_ENV: 'sandbox',
  CASHFREE_CLIENT_ID: 'test-client-id',
  CASHFREE_CLIENT_SECRET: 'test-client-secret',
  PUBLIC_BASE_URL: 'https://payments.example.edu',
  DEFAULT_FRONTEND_RETURN_URL: 'https://erp.example.edu/payments/result',
  ALLOWED_RETURN_ORIGINS: 'https://erp.example.edu',
  ERP_WEBHOOK_URL: 'http://127.0.0.1:4599/erp/events',
  ERP_WEBHOOK_SECRET: 'erp-secret',
  JOBS_ENABLED: 'false',
};
