import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { AppConfig } from '../config/app-config.service';
import { OutboxDispatcher } from '../outbox/outbox.dispatcher';
import { ReconciliationService } from './reconciliation.service';

/** Registers interval jobs from config. Each job skips a tick if its previous run is still going. */
@Injectable()
export class JobsScheduler implements OnApplicationBootstrap {
  private readonly logger = new Logger(JobsScheduler.name);
  private readonly running = new Set<string>();

  constructor(
    private readonly config: AppConfig,
    private readonly registry: SchedulerRegistry,
    private readonly reconciliation: ReconciliationService,
    private readonly outbox: OutboxDispatcher,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.config.get('JOBS_ENABLED')) {
      this.logger.log('Background jobs disabled (JOBS_ENABLED=false)');
      return;
    }
    this.register('reconciliation', this.config.get('RECONCILE_INTERVAL_SECONDS'), () => this.reconciliation.run());
    this.register('outbox', this.config.get('OUTBOX_INTERVAL_SECONDS'), () => this.outbox.dispatchBatch());
  }

  private register(name: string, seconds: number, job: () => Promise<unknown>): void {
    const handle = setInterval(async () => {
      if (this.running.has(name)) return;
      this.running.add(name);
      try {
        await job();
      } catch (error) {
        this.logger.error(`Job ${name} failed: ${(error as Error).message}`);
      } finally {
        this.running.delete(name);
      }
    }, seconds * 1000);
    this.registry.addInterval(name, handle);
    this.logger.log(`Job ${name} scheduled every ${seconds}s`);
  }
}
