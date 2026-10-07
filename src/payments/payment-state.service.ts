import { Injectable, Logger } from '@nestjs/common';
import { EventSource, PaymentOrder, PaymentStatus, Prisma } from '@prisma/client';
import { OutboxService } from '../outbox/outbox.service';
import { canTransition } from './domain/payment-state';

export interface TransitionOptions {
  source: EventSource;
  note?: string;
  payload?: Prisma.InputJsonValue;
  /** Extra columns to update together with the status. */
  data?: Prisma.PaymentOrderUpdateInput;
}

/**
 * The single write path for payment status. Every change is validated against the state
 * machine, audited in payment_events and published to the ERP outbox in the same transaction.
 */
@Injectable()
export class PaymentStateService {
  private readonly logger = new Logger(PaymentStateService.name);

  constructor(private readonly outbox: OutboxService) {}

  /** Row-level lock serialising concurrent webhook / reconciliation / API updates of one order. */
  async lockOrder(tx: Prisma.TransactionClient, id: string): Promise<PaymentOrder> {
    await tx.$queryRaw`SELECT id FROM payment_orders WHERE id = ${id}::uuid FOR UPDATE`;
    return tx.paymentOrder.findUniqueOrThrow({ where: { id } });
  }

  /**
   * Returns the updated order. If the transition is not allowed the status is left unchanged
   * (extra `data` is still applied) and the attempt is logged rather than thrown, because
   * stale/out-of-order gateway signals are expected, not exceptional.
   */
  async transition(
    tx: Prisma.TransactionClient,
    order: PaymentOrder,
    to: PaymentStatus,
    options: TransitionOptions,
  ): Promise<PaymentOrder> {
    const changed = order.status !== to && canTransition(order.status, to);

    if (order.status !== to && !changed) {
      this.logger.warn(`Ignored transition ${order.status} -> ${to} for ${order.orderId} (${options.source})`);
    }

    if (!changed && !options.data) return order;

    const updated = await tx.paymentOrder.update({
      where: { id: order.id },
      data: { ...(options.data ?? {}), ...(changed ? { status: to } : {}) },
    });

    if (changed) {
      await tx.paymentEvent.create({
        data: {
          paymentOrderId: order.id,
          fromStatus: order.status,
          toStatus: to,
          source: options.source,
          note: options.note,
          payload: options.payload,
        },
      });
      await this.outbox.enqueuePaymentStatus(tx, updated);
      this.logger.log(`Order ${order.orderId}: ${order.status} -> ${to} (${options.source})`);
    }
    return updated;
  }
}
