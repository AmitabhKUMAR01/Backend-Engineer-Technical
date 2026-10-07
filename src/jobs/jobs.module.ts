import { Module } from '@nestjs/common';
import { OutboxModule } from '../outbox/outbox.module';
import { PaymentsModule } from '../payments/payments.module';
import { WebhooksModule } from '../webhooks/webhooks.module';
import { JobsScheduler } from './jobs.scheduler';
import { ReconciliationService } from './reconciliation.service';

@Module({
  imports: [PaymentsModule, WebhooksModule, OutboxModule],
  providers: [ReconciliationService, JobsScheduler],
  exports: [ReconciliationService],
})
export class JobsModule {}
