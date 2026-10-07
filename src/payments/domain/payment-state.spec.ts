import { CfOrder, CfPayment } from '../../cashfree/cashfree.types';
import { canTransition, deriveStatus, mapTransactionStatus, refundedStatus } from './payment-state';

const order = (status: CfOrder['order_status'] = 'ACTIVE'): CfOrder => ({
  cf_order_id: 1,
  order_id: 'UMS_1',
  order_amount: 1000,
  order_currency: 'INR',
  order_status: status,
});

let seq = 0;
const payment = (status: CfPayment['payment_status'], minutesAgo = 0): CfPayment => ({
  cf_payment_id: ++seq,
  order_id: 'UMS_1',
  payment_status: status,
  payment_amount: 1000,
  payment_time: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
});

describe('deriveStatus', () => {
  it('is ACTIVE when there are no attempts', () => {
    expect(deriveStatus(order(), []).status).toBe('ACTIVE');
  });

  it('is PAID when any attempt succeeded, regardless of later failures', () => {
    const success = payment('SUCCESS', 5);
    const result = deriveStatus(order('PAID'), [success, payment('FAILED', 1)]);
    expect(result.status).toBe('PAID');
    expect(result.successfulPayment).toBe(success);
  });

  it('prefers PENDING over order expiry (bank may still confirm)', () => {
    expect(deriveStatus(order('EXPIRED'), [payment('PENDING')]).status).toBe('PENDING');
  });

  it('uses the latest attempt when the order is still active', () => {
    expect(deriveStatus(order(), [payment('USER_DROPPED', 10), payment('FAILED', 1)]).status).toBe('FAILED');
    expect(deriveStatus(order(), [payment('FAILED', 10), payment('USER_DROPPED', 1)]).status).toBe('USER_DROPPED');
  });

  it('maps order-level terminal states', () => {
    expect(deriveStatus(order('EXPIRED'), [payment('FAILED')]).status).toBe('EXPIRED');
    expect(deriveStatus(order('TERMINATED'), []).status).toBe('CANCELLED');
    expect(deriveStatus(order('TERMINATION_REQUESTED'), []).status).toBe('CANCELLED');
  });

  it('ignores NOT_ATTEMPTED payments', () => {
    expect(deriveStatus(order(), [payment('NOT_ATTEMPTED')]).status).toBe('ACTIVE');
  });
});

describe('canTransition', () => {
  it('never downgrades a paid order', () => {
    expect(canTransition('PAID', 'FAILED')).toBe(false);
    expect(canTransition('PAID', 'PENDING')).toBe(false);
    expect(canTransition('PAID', 'EXPIRED')).toBe(false);
  });

  it('allows retries after a failed or dropped attempt', () => {
    expect(canTransition('FAILED', 'PENDING')).toBe(true);
    expect(canTransition('USER_DROPPED', 'PAID')).toBe(true);
  });

  it('records late success on expired/cancelled orders', () => {
    expect(canTransition('EXPIRED', 'PAID')).toBe(true);
    expect(canTransition('CANCELLED', 'PAID')).toBe(true);
    expect(canTransition('EXPIRED', 'ACTIVE')).toBe(false);
  });

  it('treats REFUNDED as final', () => {
    expect(canTransition('REFUNDED', 'PAID')).toBe(false);
    expect(canTransition('PARTIALLY_REFUNDED', 'REFUNDED')).toBe(true);
  });
});

describe('helpers', () => {
  it('maps unknown gateway statuses to UNKNOWN', () => {
    expect(mapTransactionStatus('SUCCESS')).toBe('SUCCESS');
    expect(mapTransactionStatus('SOMETHING_NEW')).toBe('UNKNOWN');
  });

  it('computes refund status from cumulative amounts', () => {
    expect(refundedStatus(100000, 0)).toBe('PAID');
    expect(refundedStatus(100000, 40000)).toBe('PARTIALLY_REFUNDED');
    expect(refundedStatus(100000, 100000)).toBe('REFUNDED');
  });
});
