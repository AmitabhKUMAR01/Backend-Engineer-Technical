import { BadRequestException, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { Prisma, WebhookEvent } from '@prisma/client';
import { verifyCashfreeSignature } from '../cashfree/cashfree-signature';
import { CfWebhookEnvelope } from '../cashfree/cashfree.types';
import { sha256Hex } from '../common/crypto';
import { AppConfig } from '../config/app-config.service';
import { PaymentSyncService } from '../payments/payment-sync.service';
import { RefundsService } from '../payments/refunds.service';
import { PrismaService } from '../prisma/prisma.service';

type Outcome = { status: 'PROCESSED' | 'IGNORED'; note?: string };

@Injectable()
export class WebhooksService {
  private readonly logger = new Logger(WebhooksService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfig,
    private readonly sync: PaymentSyncService,
    private readonly refunds: RefundsService,
  ) {}

  /**
   * Verify -> persist -> process. Once the event is persisted we always acknowledge (2xx);
   * processing failures are retried by the reconciliation job instead of by Cashfree.
   */
  async receive(rawBody: Buffer | undefined, headers: Record<string, string | undefined>) {
    if (!rawBody?.length) throw new BadRequestException('Empty webhook body');
    const raw = rawBody.toString('utf8');

    const valid = verifyCashfreeSignature({
      timestamp: headers['x-webhook-timestamp'],
      signature: headers['x-webhook-signature'],
      rawBody: raw,
      secret: this.config.get('CASHFREE_CLIENT_SECRET'),
    });
    if (!valid) {
      this.logger.warn('Rejected webhook with invalid signature');
      throw new UnauthorizedException('Invalid webhook signature');
    }

    let envelope: CfWebhookEnvelope;
    try {
      envelope = JSON.parse(raw) as CfWebhookEnvelope;
    } catch {
      throw new BadRequestException('Webhook body is not valid JSON');
    }

    const event = await this.persist(raw, envelope, headers);
    if (event.status === 'PROCESSED' || event.status === 'IGNORED') {
      return { received: true, duplicate: true };
    }
    await this.process(event);
    return { received: true };
  }

  /** Also used by the reconciliation job to retry events whose processing failed. */
  async process(event: WebhookEvent): Promise<void> {
    try {
      const outcome = await this.dispatch(event.payload as unknown as CfWebhookEnvelope);
      await this.prisma.webhookEvent.update({
        where: { id: event.id },
        data: { status: outcome.status, lastError: outcome.note ?? null, attempts: { increment: 1 }, processedAt: new Date() },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Webhook ${event.id} (${event.eventType}) processing failed: ${message}`);
      await this.prisma.webhookEvent.update({
        where: { id: event.id },
        data: { status: 'FAILED', lastError: message.slice(0, 1000), attempts: { increment: 1 } },
      });
    }
  }

  private async dispatch(envelope: CfWebhookEnvelope): Promise<Outcome> {
    if (envelope.type?.startsWith('PAYMENT_')) {
      const orderId = envelope.data?.order?.order_id ?? envelope.data?.payment?.order_id;
      if (!orderId) return { status: 'IGNORED', note: 'No order_id in payload' };
      const exists = await this.prisma.paymentOrder.findUnique({ where: { orderId }, select: { id: true } });
      if (!exists) return { status: 'IGNORED', note: `Unknown order ${orderId}` };
      // The webhook is a trigger; the authoritative state comes from Cashfree's API.
      await this.sync.syncOrder(orderId, 'WEBHOOK', { type: envelope.type, event_time: envelope.event_time ?? null });
      return { status: 'PROCESSED' };
    }

    if (envelope.type === 'REFUND_STATUS_WEBHOOK') {
      const refundId = envelope.data?.refund?.refund_id;
      const refund = refundId ? await this.prisma.refund.findUnique({ where: { refundId } }) : null;
      if (!refund) return { status: 'IGNORED', note: `Unknown refund ${refundId ?? '(missing)'}` };
      await this.refunds.syncRefund(refund.id, 'WEBHOOK');
      return { status: 'PROCESSED' };
    }

    return { status: 'IGNORED', note: `Unhandled webhook type ${envelope.type}` };
  }

  private async persist(raw: string, envelope: CfWebhookEnvelope, headers: Record<string, string | undefined>): Promise<WebhookEvent> {
    const dedupeKey = sha256Hex(raw);
    try {
      return await this.prisma.webhookEvent.create({
        data: {
          dedupeKey,
          eventType: String(envelope.type ?? 'UNKNOWN').slice(0, 64),
          orderId: envelope.data?.order?.order_id ?? envelope.data?.refund?.order_id ?? null,
          payload: envelope as unknown as Prisma.InputJsonValue,
          headers: {
            'x-webhook-timestamp': headers['x-webhook-timestamp'] ?? null,
            'x-webhook-version': headers['x-webhook-version'] ?? null,
          },
        },
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        return this.prisma.webhookEvent.findUniqueOrThrow({ where: { dedupeKey } });
      }
      throw error;
    }
  }
}
