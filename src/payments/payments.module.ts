import { Module } from '@nestjs/common';
import { CashfreeModule } from '../cashfree/cashfree.module';
import { OutboxModule } from '../outbox/outbox.module';
import { PaymentReturnController } from './payment-return.controller';
import { PaymentStateService } from './payment-state.service';
import { PaymentSyncService } from './payment-sync.service';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';
import { RefundsService } from './refunds.service';

@Module({
  imports: [CashfreeModule, OutboxModule],
  controllers: [PaymentsController, PaymentReturnController],
  providers: [PaymentsService, PaymentSyncService, PaymentStateService, RefundsService],
  exports: [PaymentSyncService, RefundsService],
})
export class PaymentsModule {}
