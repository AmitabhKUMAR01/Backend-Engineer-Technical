import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { AppConfigModule } from './config/config.module';
import { HealthController } from './health/health.controller';
import { JobsModule } from './jobs/jobs.module';
import { PaymentsModule } from './payments/payments.module';
import { PrismaModule } from './prisma/prisma.module';
import { WebhooksModule } from './webhooks/webhooks.module';

@Module({
  imports: [AppConfigModule, PrismaModule, ScheduleModule.forRoot(), PaymentsModule, WebhooksModule, JobsModule],
  controllers: [HealthController],
})
export class AppModule {}
