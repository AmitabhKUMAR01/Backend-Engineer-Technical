import { Module } from '@nestjs/common';
import { CashfreeClient } from './cashfree.client';

@Module({
  providers: [CashfreeClient],
  exports: [CashfreeClient],
})
export class CashfreeModule {}
