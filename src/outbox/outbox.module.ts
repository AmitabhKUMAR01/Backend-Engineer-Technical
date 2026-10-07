import { Module } from '@nestjs/common';
import { OutboxDispatcher } from './outbox.dispatcher';
import { OutboxService } from './outbox.service';

@Module({
  providers: [OutboxService, OutboxDispatcher],
  exports: [OutboxService, OutboxDispatcher],
})
export class OutboxModule {}
