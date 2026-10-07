import { Injectable, Logger } from '@nestjs/common';
import { AppConfig } from '../config/app-config.service';
import { PrismaService } from '../prisma/prisma.service';
import { PaymentSyncService } from '../payments/payment-sync.service';
import { RefundsService } from '../payments/refunds.service';
import { WebhooksService } from '../webhooks/webhooks.service';

const BATCH_SIZE = 50;
const MAX_WEBHOOK_ATTEMPTS = 10;

/**
 * Safety net for everything event-driven: webhooks can be lost, delayed or fail to process,
 * and gateway calls can time out. This job converges local state with Cashfree regardless.
 * Each claim uses FOR UPDATE SKIP LOCKED, so running several instances is safe.
 */
@Injectable()
export class ReconciliationService {
  private readonly logger = new Logger(ReconciliationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfig,
    private readonly sync: PaymentSyncService,
    private readonly refunds: RefundsService,
    private readonly webhooks: WebhooksService,
  ) {}

  async run(): Promise<{ orders: number; refunds: number; webhooks: number }> {
    const orders = await this.reconcileOrders();
    const refunds = await this.reconcileRefunds();
    const webhooks = await this.retryWebhooks();
    if (orders || refunds || webhooks) {
      this.logger.log(`Reconciled ${orders} orders, ${refunds} refunds, retried ${webhooks} webhooks`);
    }
    return { orders, refunds, webhooks };
  }

  /** Open orders not synced recently (includes CREATED orders whose gateway call had an unknown outcome). */
  async reconcileOrders(): Promise<number> {
    const staleSeconds = this.config.get('RECONCILE_STALE_AFTER_SECONDS');
    const claimed = await this.prisma.$queryRaw<{ order_id: string }[]>`
      UPDATE payment_orders SET last_synced_at = now()
       WHERE id IN (
         SELECT id FROM payment_orders
          WHERE status IN ('CREATED', 'ACTIVE', 'PENDING', 'FAILED', 'USER_DROPPED')
            AND created_at < now() - interval '1 minute'
            AND (last_synced_at IS NULL OR last_synced_at < now() - make_interval(secs => ${staleSeconds}))
          ORDER BY last_synced_at NULLS FIRST
          LIMIT ${BATCH_SIZE}
          FOR UPDATE SKIP LOCKED
       )
      RETURNING order_id`;

    for (const { order_id } of claimed) {
      try {
        await this.sync.syncOrder(order_id, 'RECONCILIATION');
      } catch (error) {
        this.logger.warn(`Reconcile order ${order_id} failed: ${(error as Error).message}`);
      }
    }
    return claimed.length;
  }

  async reconcileRefunds(): Promise<number> {
    const staleSeconds = this.config.get('RECONCILE_STALE_AFTER_SECONDS');
    const claimed = await this.prisma.$queryRaw<{ id: string }[]>`
      UPDATE refunds SET last_synced_at = now()
       WHERE id IN (
         SELECT id FROM refunds
          WHERE status IN ('PENDING', 'ONHOLD')
            AND created_at < now() - interval '1 minute'
            AND (last_synced_at IS NULL OR last_synced_at < now() - make_interval(secs => ${staleSeconds}))
          ORDER BY last_synced_at NULLS FIRST
          LIMIT ${BATCH_SIZE}
          FOR UPDATE SKIP LOCKED
       )
      RETURNING id`;

    for (const { id } of claimed) {
      try {
        const refund = await this.prisma.refund.findUniqueOrThrow({ where: { id }, include: { paymentOrder: true } });
        if (refund.cfRefundId) {
          await this.refunds.syncRefund(id, 'RECONCILIATION');
        } else {
          // Never acknowledged by Cashfree: resubmitting with the same refund_id is idempotent.
          await this.refunds.submit(refund, refund.paymentOrder.orderId);
        }
      } catch (error) {
        this.logger.warn(`Reconcile refund ${id} failed: ${(error as Error).message}`);
      }
    }
    return claimed.length;
  }

  async retryWebhooks(): Promise<number> {
    const events = await this.prisma.webhookEvent.findMany({
      where: {
        status: { in: ['FAILED', 'RECEIVED'] },
        attempts: { lt: MAX_WEBHOOK_ATTEMPTS },
        receivedAt: { lt: new Date(Date.now() - 60_000) },
      },
      orderBy: { receivedAt: 'asc' },
      take: BATCH_SIZE,
    });
    for (const event of events) {
      await this.webhooks.process(event);
    }
    return events.length;
  }
}
