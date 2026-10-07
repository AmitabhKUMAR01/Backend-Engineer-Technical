import { PaymentStatus, TransactionStatus } from '@prisma/client';
import { CfOrder, CfPayment } from '../../cashfree/cashfree.types';

/** Orders the customer can still pay (or is paying). Mirrors the partial unique index in the migration. */
export const OPEN_STATUSES: readonly PaymentStatus[] = [
  PaymentStatus.CREATED,
  PaymentStatus.ACTIVE,
  PaymentStatus.PENDING,
  PaymentStatus.FAILED,
  PaymentStatus.USER_DROPPED,
];

export const PAID_STATUSES: readonly PaymentStatus[] = [
  PaymentStatus.PAID,
  PaymentStatus.PARTIALLY_REFUNDED,
  PaymentStatus.REFUNDED,
];

/** Statuses from which a checkout session may still be (re)opened by the customer. */
export const PAYABLE_STATUSES: readonly PaymentStatus[] = [
  PaymentStatus.ACTIVE,
  PaymentStatus.FAILED,
  PaymentStatus.USER_DROPPED,
];

const { CREATED, ACTIVE, PENDING, FAILED, USER_DROPPED, PAID, EXPIRED, CANCELLED, INITIATION_FAILED, PARTIALLY_REFUNDED, REFUNDED } =
  PaymentStatus;

/**
 * Allowed transitions. Anything not listed is rejected, which is what protects us from
 * out-of-order or duplicate gateway signals (e.g. a stale FAILED webhook after PAID).
 *
 * EXPIRED/CANCELLED/INITIATION_FAILED -> PAID/PENDING exist on purpose: if the gateway
 * captured money we must record it, even if we had given up on the order (it gets flagged).
 */
const TRANSITIONS: Record<PaymentStatus, readonly PaymentStatus[]> = {
  [CREATED]: [ACTIVE, PENDING, FAILED, USER_DROPPED, PAID, EXPIRED, CANCELLED, INITIATION_FAILED],
  [ACTIVE]: [PENDING, FAILED, USER_DROPPED, PAID, EXPIRED, CANCELLED],
  [FAILED]: [ACTIVE, PENDING, USER_DROPPED, PAID, EXPIRED, CANCELLED],
  [USER_DROPPED]: [ACTIVE, PENDING, FAILED, PAID, EXPIRED, CANCELLED],
  [PENDING]: [PAID, FAILED, USER_DROPPED, EXPIRED, CANCELLED],
  [PAID]: [PARTIALLY_REFUNDED, REFUNDED],
  [PARTIALLY_REFUNDED]: [REFUNDED],
  [REFUNDED]: [],
  [EXPIRED]: [PENDING, PAID],
  [CANCELLED]: [PENDING, PAID],
  [INITIATION_FAILED]: [PENDING, PAID],
};

export function canTransition(from: PaymentStatus, to: PaymentStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function isTerminal(status: PaymentStatus): boolean {
  return status === REFUNDED || status === EXPIRED || status === CANCELLED || status === INITIATION_FAILED;
}

export function mapTransactionStatus(status: string | undefined): TransactionStatus {
  return (Object.values(TransactionStatus) as string[]).includes(status ?? '')
    ? (status as TransactionStatus)
    : TransactionStatus.UNKNOWN;
}

export interface DerivedState {
  status: PaymentStatus;
  successfulPayment?: CfPayment;
}

/**
 * Derives the ERP-facing status from Cashfree's view of the order and its payment attempts.
 * Precedence: any SUCCESS > any PENDING > order-level terminal state > latest attempt outcome.
 */
export function deriveStatus(order: CfOrder, payments: CfPayment[]): DerivedState {
  const successfulPayment = payments.find((p) => p.payment_status === 'SUCCESS');
  if (successfulPayment) return { status: PAID, successfulPayment };
  if (order.order_status === 'PAID') return { status: PAID };

  if (payments.some((p) => p.payment_status === 'PENDING')) return { status: PENDING };

  if (order.order_status === 'EXPIRED') return { status: EXPIRED };
  if (order.order_status === 'TERMINATED' || order.order_status === 'TERMINATION_REQUESTED') {
    return { status: CANCELLED };
  }

  const latest = latestAttempt(payments);
  switch (latest?.payment_status) {
    case 'FAILED':
    case 'VOID':
      return { status: FAILED };
    case 'USER_DROPPED':
    case 'CANCELLED':
      return { status: USER_DROPPED };
    default:
      return { status: ACTIVE };
  }
}

function latestAttempt(payments: CfPayment[]): CfPayment | undefined {
  return [...payments]
    .filter((p) => p.payment_status !== 'NOT_ATTEMPTED')
    .sort((a, b) => timeOf(b) - timeOf(a))[0];
}

function timeOf(payment: CfPayment): number {
  const value = payment.payment_completion_time ?? payment.payment_time;
  return value ? new Date(value).getTime() : 0;
}

/** Status after refunds: compares cumulative successful refunds against the paid amount (in paise). */
export function refundedStatus(paidAmountPaise: number, refundedPaise: number): PaymentStatus {
  if (refundedPaise <= 0) return PAID;
  return refundedPaise >= paidAmountPaise ? REFUNDED : PARTIALLY_REFUNDED;
}
