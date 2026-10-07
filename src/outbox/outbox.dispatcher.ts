import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { hmacSha256 } from '../common/crypto';
import { AppConfig } from '../config/app-config.service';
import { PrismaService } from '../prisma/prisma.service';

interface ClaimedEvent {
  id: string;
  event_type: string;
  aggregate_id: string;
  payload: Prisma.JsonValue;
  attempts: number;
  created_at: Date;
}

const LEASE_SECONDS = 60;
const MAX_BACKOFF_SECONDS = 3600;

/**
 * Delivers outbox events to the ERP with at-least-once semantics.
 * The ERP must dedupe on `x-ums-event-id`.
 */
@Injectable()
export class OutboxDispatcher {
  private readonly logger = new Logger(OutboxDispatcher.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfig,
  ) {}

  /** Claims a batch with SKIP LOCKED so several app instances can dispatch concurrently without double-sending. */
  async dispatchBatch(limit = 50): Promise<number> {
    const events = await this.prisma.$queryRaw<ClaimedEvent[]>`
      UPDATE outbox_events
         SET status = 'PROCESSING',
             attempts = attempts + 1,
             locked_until = now() + make_interval(secs => ${LEASE_SECONDS})
       WHERE id IN (
         SELECT id FROM outbox_events
          WHERE (status = 'PENDING' AND (next_attempt_at IS NULL OR next_attempt_at <= now()))
             OR (status = 'PROCESSING' AND locked_until < now())
          ORDER BY created_at
          LIMIT ${limit}
          FOR UPDATE SKIP LOCKED
       )
      RETURNING id, event_type, aggregate_id, payload, attempts, created_at`;

    for (const event of events) {
      await this.deliver(event);
    }
    return events.length;
  }

  private async deliver(event: ClaimedEvent): Promise<void> {
    const url = this.config.get('ERP_WEBHOOK_URL');
    if (!url) {
      this.logger.log(`[outbox] ERP_WEBHOOK_URL not set; ${event.event_type} for ${event.aggregate_id} logged only`);
      await this.markSent(event.id);
      return;
    }

    const body = JSON.stringify({
      id: event.id,
      type: event.event_type,
      occurredAt: event.created_at.toISOString(),
      data: event.payload,
    });

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-ums-event-id': event.id,
          'x-ums-event-type': event.event_type,
          'x-ums-signature': hmacSha256(this.config.get('ERP_WEBHOOK_SECRET'), body, 'hex'),
        },
        body,
        signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) throw new Error(`ERP responded with HTTP ${response.status}`);
      await this.markSent(event.id);
    } catch (error) {
      await this.markFailed(event, error instanceof Error ? error.message : String(error));
    }
  }

  private async markSent(id: string): Promise<void> {
    await this.prisma.outboxEvent.update({
      where: { id },
      data: { status: 'SENT', sentAt: new Date(), lockedUntil: null, lastError: null },
    });
  }

  private async markFailed(event: ClaimedEvent, message: string): Promise<void> {
    const dead = event.attempts >= this.config.get('OUTBOX_MAX_ATTEMPTS');
    const backoffSeconds = Math.min(2 ** event.attempts * 5, MAX_BACKOFF_SECONDS);
    if (dead) {
      this.logger.error(`[outbox] ${event.event_type} ${event.id} is DEAD after ${event.attempts} attempts: ${message}`);
    } else {
      this.logger.warn(`[outbox] ${event.event_type} ${event.id} failed (attempt ${event.attempts}), retry in ${backoffSeconds}s: ${message}`);
    }
    await this.prisma.$executeRaw`
      UPDATE outbox_events
         SET status = ${dead ? 'DEAD' : 'PENDING'}::"OutboxStatus",
             last_error = ${message.slice(0, 1000)},
             locked_until = NULL,
             next_attempt_at = now() + make_interval(secs => ${backoffSeconds})
       WHERE id = ${event.id}::uuid`;
  }
}
