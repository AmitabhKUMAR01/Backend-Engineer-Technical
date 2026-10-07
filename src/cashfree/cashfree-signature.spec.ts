import { createHmac } from 'crypto';
import { computeCashfreeSignature, verifyCashfreeSignature } from './cashfree-signature';

describe('Cashfree webhook signature', () => {
  const secret = 'test-secret';
  const timestamp = '1728300000000';
  const rawBody = '{"type":"PAYMENT_SUCCESS_WEBHOOK","data":{"order":{"order_id":"UMS_1"}}}';

  it('matches the documented algorithm: base64(HMAC_SHA256(timestamp + rawBody))', () => {
    const expected = createHmac('sha256', secret).update(timestamp + rawBody).digest('base64');
    expect(computeCashfreeSignature(timestamp, rawBody, secret)).toBe(expected);
  });

  it('accepts a valid signature', () => {
    const signature = computeCashfreeSignature(timestamp, rawBody, secret);
    expect(verifyCashfreeSignature({ timestamp, signature, rawBody, secret })).toBe(true);
  });

  it('rejects a tampered body, wrong timestamp, wrong secret or missing headers', () => {
    const signature = computeCashfreeSignature(timestamp, rawBody, secret);
    expect(verifyCashfreeSignature({ timestamp, signature, rawBody: rawBody.replace('UMS_1', 'UMS_2'), secret })).toBe(false);
    expect(verifyCashfreeSignature({ timestamp: '1', signature, rawBody, secret })).toBe(false);
    expect(verifyCashfreeSignature({ timestamp, signature, rawBody, secret: 'other' })).toBe(false);
    expect(verifyCashfreeSignature({ timestamp: undefined, signature, rawBody, secret })).toBe(false);
    expect(verifyCashfreeSignature({ timestamp, signature: undefined, rawBody, secret })).toBe(false);
  });
});
