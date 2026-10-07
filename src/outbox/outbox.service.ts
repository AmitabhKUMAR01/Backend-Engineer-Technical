import { Injectable } from '@nestjs/common';
import { PaymentOrder, PaymentStatus, Prisma, Refund } from '@prisma/client';
import { formatAmount } from '../common/money';

const PAYMENT_EVENT_TYPES: Partial<Record<PaymentStatus, string>> = {
  PENDING: 'payment.pending',
  PAID: 'payment.succeeded',
  FAILED: 'payment.failed',
  USER_DROPPED: 'payment.dropped',
  EXPIRED: 'payment.expired',
  CANCELLED: 'payment.cancelled',
  INITIATION_FAILED: 'payment.initiation_failed',
  PARTIALLY_REFUNDED: 'payment.partially_refunded',
  REFUNDED: 'payment.refunded',
};

/**
 * Writes ERP notifications into the outbox table. Always called with the transaction client
 * of the state change, so the notification commits (or rolls back) atomically with it.
 */
@Injectable()
export class OutboxService {
  async enqueuePaymentStatus(tx: Prisma.TransactionClient, order: PaymentOrder): Promise<void> {
    const eventType = PAYMENT_EVENT_TYPES[order.status];
    if (!eventType) return;
    await tx.outboxEvent.create({
      data: {
        aggregateId: order.orderId,
        eventType,
        payload: {
          orderId: order.orderId,
          cfOrderId: order.cfOrderId,
          studentId: order.studentId,
          feeReference: order.feeReference,
          purpose: order.purpose,
          status: order.status,
          amount: formatAmount(order.amount),
          currency: order.currency,
          paidAt: order.paidAt?.toISOString() ?? null,
          flaggedReason: order.flaggedReason,
        },
      },
    });
  }

  async enqueueRefundStatus(tx: Prisma.TransactionClient, order: PaymentOrder, refund: Refund): Promise<void> {
    const eventType =
      refund.status === 'SUCCESS' ? 'refund.succeeded' : refund.status === 'CANCELLED' || refund.status === 'FAILED' ? 'refund.failed' : null;
    if (!eventType) return;
    await tx.outboxEvent.create({
      data: {
        aggregateId: order.orderId,
        eventType,
        payload: {
          orderId: order.orderId,
          refundId: refund.refundId,
          cfRefundId: refund.cfRefundId,
          studentId: order.studentId,
          feeReference: order.feeReference,
          amount: formatAmount(refund.amount),
          status: refund.status,
          processedAt: refund.processedAt?.toISOString() ?? null,
        },
      },
    });
  }
}
