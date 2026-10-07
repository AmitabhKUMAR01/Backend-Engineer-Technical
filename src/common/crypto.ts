import { createHash, createHmac, randomBytes, timingSafeEqual } from 'crypto';

export function sha256Hex(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}

export function hmacSha256(secret: string, data: string | Buffer, encoding: 'hex' | 'base64'): string {
  return createHmac('sha256', secret).update(data).digest(encoding);
}

export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** JSON with recursively sorted object keys, so semantically equal payloads hash identically. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    return Object.keys(value as Record<string, unknown>)
      .sort()
      .reduce<Record<string, unknown>>((acc, key) => {
        const child = (value as Record<string, unknown>)[key];
        if (child !== undefined) acc[key] = sortKeys(child);
        return acc;
      }, {});
  }
  return value;
}

/** Sortable, URL-safe id that fits Cashfree's order_id/refund_id rules ([A-Za-z0-9_-], <= 40 chars). */
export function generateReference(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${randomBytes(6).toString('hex')}`.toUpperCase();
}
