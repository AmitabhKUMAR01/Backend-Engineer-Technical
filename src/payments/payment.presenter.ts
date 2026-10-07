import { PaymentEvent, PaymentOrder, PaymentTransaction, Refund } from '@prisma/client';
import { formatAmount } from '../common/money';
import { PAYABLE_STATUSES } from './domain/payment-state';

type OrderWithRelations = PaymentOrder & {
  transactions?: PaymentTransaction[];
  refunds?: Refund[];
};

export function presentOrder(order: OrderWithRelations, cashfreeEnv: string) {
  const payable = PAYABLE_STATUSES.includes(order.status) && (!order.expiresAt || order.expiresAt > new Date());
  return {
    orderId: order.orderId,
    cfOrderId: order.cfOrderId,
    status: order.status,
    studentId: order.studentId,
    feeReference: order.feeReference,
    purpose: order.purpose,
    amount: formatAmount(order.amount),
    currency: order.currency,
    /** Present only while the customer can still pay; pass to the Cashfree JS SDK checkout(). */
    checkout: payable && order.paymentSessionId
      ? { paymentSessionId: order.paymentSessionId, environment: cashfreeEnv }
      : null,
    expiresAt: order.expiresAt,
    paidAt: order.paidAt,
    flaggedReason: order.flaggedReason,
    metadata: order.metadata,
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
    ...(order.transactions ? { transactions: order.transactions.map(presentTransaction) } : {}),
    ...(order.refunds ? { refunds: order.refunds.map(presentRefund) } : {}),
  };
}

export function presentTransaction(txn: PaymentTransaction) {
  return {
    cfPaymentId: txn.cfPaymentId,
    status: txn.status,
    amount: formatAmount(txn.amount),
    currency: txn.currency,
    paymentGroup: txn.paymentGroup,
    bankReference: txn.bankReference,
    message: txn.message,
    paymentTime: txn.paymentTime,
    completedAt: txn.completedAt,
  };
}

export function presentRefund(refund: Refund) {
  return {
    refundId: refund.refundId,
    cfRefundId: refund.cfRefundId,
    status: refund.status,
    amount: formatAmount(refund.amount),
    reason: refund.reason,
    statusDescription: refund.statusDescription,
    processedAt: refund.processedAt,
    createdAt: refund.createdAt,
  };
}

export function presentEvent(event: PaymentEvent) {
  return {
    fromStatus: event.fromStatus,
    toStatus: event.toStatus,
    source: event.source,
    note: event.note,
    createdAt: event.createdAt,
  };
}
