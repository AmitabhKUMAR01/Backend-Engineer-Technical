import { HttpStatus, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { EventSource, Prisma, Refund, RefundStatus } from '@prisma/client';
import { CashfreeClient } from '../cashfree/cashfree.client';
import { CashfreeApiError } from '../cashfree/cashfree.errors';
import { CfRefund } from '../cashfree/cashfree.types';
import { canonicalJson, generateReference, sha256Hex } from '../common/crypto';
import { PaymentError } from '../common/errors';
import { toGatewayAmount, toPaise } from '../common/money';
import { OutboxService } from '../outbox/outbox.service';
import { PrismaService } from '../prisma/prisma.service';
import { refundedStatus } from './domain/payment-state';
import { CreateRefundDto } from './dto/create-refund.dto';
import { PaymentStateService } from './payment-state.service';

/** Refunds that count against the refundable balance. */
const COMMITTED_REFUND_STATUSES: RefundStatus[] = ['PENDING', 'ONHOLD', 'SUCCESS'];
const KNOWN_GATEWAY_STATUSES: RefundStatus[] = ['PENDING', 'ONHOLD', 'SUCCESS', 'CANCELLED'];

@Injectable()
export class RefundsService {
  private readonly logger = new Logger(RefundsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cashfree: CashfreeClient,
    private readonly state: PaymentStateService,
    private readonly outbox: OutboxService,
  ) {}

  async create(orderId: string, dto: CreateRefundDto, idempotencyKey: string): Promise<{ refund: Refund; created: boolean }> {
    const requestHash = sha256Hex(canonicalJson({ orderId, ...dto }));

    const existing = await this.prisma.refund.findUnique({ where: { idempotencyKey } });
    if (existing) return { refund: this.assertSameRequest(existing, requestHash), created: false };

    const order = await this.prisma.paymentOrder.findUnique({ where: { orderId } });
    if (!order) throw new NotFoundException(`Payment order ${orderId} not found`);

    let refund: Refund;
    try {
      refund = await this.prisma.$transaction(async (tx) => {
        // Lock the order so two concurrent refunds cannot both pass the balance check.
        const locked = await this.state.lockOrder(tx, order.id);
        if (locked.status !== 'PAID' && locked.status !== 'PARTIALLY_REFUNDED') {
          throw new PaymentError(HttpStatus.CONFLICT, 'NOT_REFUNDABLE', `Order in status ${locked.status} cannot be refunded`);
        }
        const committed = await tx.refund.aggregate({
          where: { paymentOrderId: locked.id, status: { in: COMMITTED_REFUND_STATUSES } },
          _sum: { amount: true },
        });
        const committedPaise = toPaise(committed._sum.amount ?? 0);
        const requestedPaise = toPaise(dto.amount);
        if (committedPaise + requestedPaise > toPaise(locked.amount)) {
          throw new PaymentError(HttpStatus.UNPROCESSABLE_ENTITY, 'REFUND_EXCEEDS_BALANCE', 'Refund exceeds the refundable balance', {
            refundable: ((toPaise(locked.amount) - committedPaise) / 100).toFixed(2),
          });
        }
        return tx.refund.create({
          data: {
            paymentOrderId: locked.id,
            refundId: generateReference('RF'),
            amount: new Prisma.Decimal(dto.amount.toFixed(2)),
            reason: dto.reason,
            idempotencyKey,
            requestHash,
          },
        });
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const raced = await this.prisma.refund.findUniqueOrThrow({ where: { idempotencyKey } });
        return { refund: this.assertSameRequest(raced, requestHash), created: false };
      }
      throw error;
    }

    return { refund: await this.submit(refund, orderId), created: true };
  }

  async findOne(orderId: string, refundId: string): Promise<Refund> {
    const refund = await this.prisma.refund.findFirst({ where: { refundId, paymentOrder: { orderId } } });
    if (!refund) throw new NotFoundException(`Refund ${refundId} not found for order ${orderId}`);
    return refund;
  }

  /**
   * Sends the refund to Cashfree. Idempotent: refund_id is unique at Cashfree, so the
   * reconciliation job can call this again for refunds whose first submission had an unknown outcome.
   */
  async submit(refund: Refund, orderId: string): Promise<Refund> {
    try {
      const cfRefund = await this.cashfree.createRefund(orderId, {
        refund_amount: toGatewayAmount(refund.amount),
        refund_id: refund.refundId,
        refund_note: refund.reason ?? undefined,
      });
      return await this.applyGatewayRefund(refund.id, cfRefund, 'API');
    } catch (error) {
      if (!(error instanceof CashfreeApiError)) throw error;
      if (error.isTransient || error.isConflict) {
        const synced = await this.syncRefund(refund.id, 'API').catch(() => null);
        if (synced?.cfRefundId) return synced;
        this.logger.warn(`Refund ${refund.refundId} outcome unknown, will reconcile: ${error.message}`);
        return this.prisma.refund.update({ where: { id: refund.id }, data: { lastGatewayError: error.message } });
      }
      return this.markFailed(refund.id, error.message);
    }
  }

  async syncRefund(id: string, source: EventSource): Promise<Refund> {
    const refund = await this.prisma.refund.findUniqueOrThrow({ where: { id }, include: { paymentOrder: true } });
    const cfRefund = await this.cashfree.getRefund(refund.paymentOrder.orderId, refund.refundId);
    return this.applyGatewayRefund(id, cfRefund, source);
  }

  private async applyGatewayRefund(id: string, cfRefund: CfRefund, source: EventSource): Promise<Refund> {
    return this.prisma.$transaction(async (tx) => {
      const current = await tx.refund.findUniqueOrThrow({ where: { id } });
      const order = await this.state.lockOrder(tx, current.paymentOrderId);
      const refund = await tx.refund.findUniqueOrThrow({ where: { id } });

      const gatewayStatus = KNOWN_GATEWAY_STATUSES.includes(cfRefund.refund_status as RefundStatus)
        ? (cfRefund.refund_status as RefundStatus)
        : refund.status;
      // SUCCESS is final: money has left; nothing the gateway says later can undo it.
      const nextStatus = refund.status === 'SUCCESS' ? 'SUCCESS' : gatewayStatus;
      const statusChanged = nextStatus !== refund.status;

      const updated = await tx.refund.update({
        where: { id },
        data: {
          status: nextStatus,
          cfRefundId: cfRefund.cf_refund_id != null ? String(cfRefund.cf_refund_id) : refund.cfRefundId,
          statusDescription: cfRefund.status_description ?? refund.statusDescription,
          processedAt: cfRefund.processed_at ? new Date(cfRefund.processed_at) : refund.processedAt,
          lastSyncedAt: new Date(),
          lastGatewayError: null,
          raw: cfRefund as unknown as Prisma.InputJsonValue,
        },
      });

      if (statusChanged) {
        await this.outbox.enqueueRefundStatus(tx, order, updated);
      }

      if (statusChanged && nextStatus === 'SUCCESS') {
        const refunded = await tx.refund.aggregate({
          where: { paymentOrderId: order.id, status: 'SUCCESS' },
          _sum: { amount: true },
        });
        const target = refundedStatus(toPaise(order.amount), toPaise(refunded._sum.amount ?? 0));
        await this.state.transition(tx, order, target, {
          source,
          note: `Refund ${updated.refundId} succeeded (${updated.amount.toFixed(2)})`,
        });
      }
      return updated;
    });
  }

  private async markFailed(id: string, message: string): Promise<Refund> {
    return this.prisma.$transaction(async (tx) => {
      const current = await tx.refund.findUniqueOrThrow({ where: { id } });
      const order = await this.state.lockOrder(tx, current.paymentOrderId);
      const updated = await tx.refund.update({
        where: { id },
        data: { status: 'FAILED', lastGatewayError: message, lastSyncedAt: new Date() },
      });
      await this.outbox.enqueueRefundStatus(tx, order, updated);
      return updated;
    });
  }

  private assertSameRequest(refund: Refund, requestHash: string): Refund {
    if (refund.requestHash !== requestHash) {
      throw new PaymentError(
        HttpStatus.UNPROCESSABLE_ENTITY,
        'IDEMPOTENCY_KEY_REUSED',
        'Idempotency-Key was already used with a different request body',
      );
    }
    return refund;
  }
}
