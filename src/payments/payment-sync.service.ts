import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { EventSource, PaymentOrder, PaymentStatus, Prisma } from '@prisma/client';
import { CashfreeClient } from '../cashfree/cashfree.client';
import { CashfreeApiError } from '../cashfree/cashfree.errors';
import { CfOrder, CfPayment } from '../cashfree/cashfree.types';
import { toPaise } from '../common/money';
import { PrismaService } from '../prisma/prisma.service';
import { PAID_STATUSES, deriveStatus, mapTransactionStatus } from './domain/payment-state';
import { PaymentStateService } from './payment-state.service';

/** A CREATED order may still be in flight to Cashfree; only give up on it after this long. */
const CREATE_GRACE_MS = 2 * 60 * 1000;

const LATE_SUCCESS_FROM: readonly PaymentStatus[] = ['EXPIRED', 'CANCELLED', 'INITIATION_FAILED'];

/**
 * Pulls the authoritative order + payment state from Cashfree and applies it locally.
 *
 * Webhooks, the browser return URL, manual verification and the reconciliation job all
 * funnel into this one code path, which is why out-of-order / duplicate signals are harmless:
 * we never trust the signal's content, only the fact that "something changed".
 */
@Injectable()
export class PaymentSyncService {
  private readonly logger = new Logger(PaymentSyncService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cashfree: CashfreeClient,
    private readonly state: PaymentStateService,
  ) {}

  async syncOrder(orderId: string, source: EventSource, payload?: Prisma.InputJsonValue): Promise<PaymentOrder> {
    const order = await this.prisma.paymentOrder.findUnique({ where: { orderId } });
    if (!order) throw new NotFoundException(`Payment order ${orderId} not found`);

    // Network I/O happens before taking any row lock, so a slow gateway never holds DB locks.
    let cfOrder: CfOrder;
    let payments: CfPayment[];
    try {
      cfOrder = await this.cashfree.getOrder(orderId);
      payments = await this.cashfree.getPayments(orderId);
    } catch (error) {
      if (error instanceof CashfreeApiError && error.isNotFound) {
        return this.handleMissingAtGateway(order, source);
      }
      throw error;
    }

    return this.applyGatewayState(order.id, cfOrder, payments, source, payload);
  }

  async applyGatewayState(
    id: string,
    cfOrder: CfOrder,
    payments: CfPayment[],
    source: EventSource,
    payload?: Prisma.InputJsonValue,
  ): Promise<PaymentOrder> {
    return this.prisma.$transaction(async (tx) => {
      const order = await this.state.lockOrder(tx, id);

      for (const payment of payments) {
        await this.upsertTransaction(tx, order.id, payment);
      }

      let { status: target, successfulPayment } = deriveStatus(cfOrder, payments);
      let flaggedReason = order.flaggedReason;

      const amountMatches =
        toPaise(cfOrder.order_amount) === toPaise(order.amount) && cfOrder.order_currency === order.currency;
      if (!amountMatches) {
        flaggedReason = `AMOUNT_MISMATCH: gateway ${cfOrder.order_amount} ${cfOrder.order_currency}, expected ${order.amount.toFixed(2)} ${order.currency}`;
        this.logger.error(`Order ${order.orderId} ${flaggedReason}`);
        if (target === 'PAID') target = order.status;
      }

      // Refund states are owned by the refund flow; the gateway only ever says "PAID" for them.
      if (target === 'PAID' && PAID_STATUSES.includes(order.status)) target = order.status;

      if (target === 'PAID' && LATE_SUCCESS_FROM.includes(order.status)) {
        flaggedReason = `LATE_SUCCESS_AFTER_${order.status}`;
        this.logger.error(`Order ${order.orderId} received a successful payment after being ${order.status}`);
      }

      if (target === 'PAID' && order.status !== 'PAID') {
        const other = await tx.paymentOrder.findFirst({
          where: { feeReference: order.feeReference, id: { not: order.id }, status: { in: ['PAID', 'PARTIALLY_REFUNDED'] } },
        });
        if (other) {
          flaggedReason = `DUPLICATE_PAYMENT: fee already settled by ${other.orderId}`;
          this.logger.error(`Order ${order.orderId} ${flaggedReason}`);
        }
      }

      const paidAt =
        target === 'PAID' && !order.paidAt ? parseDate(successfulPayment?.payment_completion_time ?? successfulPayment?.payment_time) ?? new Date() : undefined;

      return this.state.transition(tx, order, target, {
        source,
        payload,
        note: `cashfree order_status=${cfOrder.order_status}, attempts=${payments.length}`,
        data: {
          cfOrderId: String(cfOrder.cf_order_id),
          cfOrderStatus: cfOrder.order_status,
          paymentSessionId: cfOrder.payment_session_id ?? order.paymentSessionId,
          expiresAt: parseDate(cfOrder.order_expiry_time) ?? order.expiresAt,
          flaggedReason,
          lastSyncedAt: new Date(),
          ...(paidAt ? { paidAt } : {}),
        },
      });
    });
  }

  private async handleMissingAtGateway(order: PaymentOrder, source: EventSource): Promise<PaymentOrder> {
    const ageMs = Date.now() - order.createdAt.getTime();
    return this.prisma.$transaction(async (tx) => {
      const locked = await this.state.lockOrder(tx, order.id);
      if (locked.status === 'CREATED' && ageMs > CREATE_GRACE_MS) {
        return this.state.transition(tx, locked, 'INITIATION_FAILED', {
          source,
          note: 'Order never reached Cashfree',
          data: { lastSyncedAt: new Date() },
        });
      }
      return tx.paymentOrder.update({ where: { id: locked.id }, data: { lastSyncedAt: new Date() } });
    });
  }

  private async upsertTransaction(tx: Prisma.TransactionClient, paymentOrderId: string, payment: CfPayment): Promise<void> {
    const data = {
      status: mapTransactionStatus(payment.payment_status),
      amount: new Prisma.Decimal(payment.payment_amount ?? 0).toDecimalPlaces(2),
      currency: payment.payment_currency ?? 'INR',
      paymentGroup: payment.payment_group ?? null,
      bankReference: payment.bank_reference ?? null,
      message: payment.payment_message ?? null,
      errorDetails: (payment.error_details ?? undefined) as Prisma.InputJsonValue | undefined,
      paymentTime: parseDate(payment.payment_time),
      completedAt: parseDate(payment.payment_completion_time),
      raw: payment as unknown as Prisma.InputJsonValue,
    };
    await tx.paymentTransaction.upsert({
      where: { cfPaymentId: String(payment.cf_payment_id) },
      create: { paymentOrderId, cfPaymentId: String(payment.cf_payment_id), ...data },
      update: data,
    });
  }
}

function parseDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}
