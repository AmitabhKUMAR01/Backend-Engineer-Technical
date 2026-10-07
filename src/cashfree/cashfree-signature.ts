import { hmacSha256, safeEqual } from '../common/crypto';

/**
 * Cashfree webhook signature: base64(HMAC_SHA256(timestamp + rawBody, clientSecret)).
 * Must be computed over the exact raw bytes received; re-serialised JSON will not match.
 */
export function computeCashfreeSignature(timestamp: string, rawBody: string, secret: string): string {
  return hmacSha256(secret, timestamp + rawBody, 'base64');
}

export function verifyCashfreeSignature(params: {
  timestamp: string | undefined;
  signature: string | undefined;
  rawBody: string;
  secret: string;
}): boolean {
  const { timestamp, signature, rawBody, secret } = params;
  if (!timestamp || !signature) return false;
  return safeEqual(computeCashfreeSignature(timestamp, rawBody, secret), signature);
}
