import { HttpStatus, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PaymentOrder, PaymentStatus, Prisma } from '@prisma/client';
import { CashfreeClient } from '../cashfree/cashfree.client';
import { CashfreeApiError } from '../cashfree/cashfree.errors';
import { CfCreateOrderRequest } from '../cashfree/cashfree.types';
import { canonicalJson, generateReference, sha256Hex } from '../common/crypto';
import { PaymentError } from '../common/errors';
import { toGatewayAmount, toPaise } from '../common/money';
import { AppConfig } from '../config/app-config.service';
import { PrismaService } from '../prisma/prisma.service';
import { OPEN_STATUSES } from './domain/payment-state';
import { CreatePaymentOrderDto } from './dto/create-payment-order.dto';
import { ListPaymentOrdersDto } from './dto/list-payment-orders.dto';
import { PaymentStateService } from './payment-state.service';
import { PaymentSyncService } from './payment-sync.service';

export interface CreateOrderResult {
  order: PaymentOrder;
  /** false when an existing order was returned (idempotent replay or reuse of an open order). */
  created: boolean;
}

const SETTLED_STATUSES: PaymentStatus[] = ['PAID', 'PARTIALLY_REFUNDED'];

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cashfree: CashfreeClient,
    private readonly sync: PaymentSyncService,
    private readonly state: PaymentStateService,
    private readonly config: AppConfig,
  ) {}

  async createOrder(dto: CreatePaymentOrderDto, idempotencyKey: string): Promise<CreateOrderResult> {
    this.assertReturnUrlAllowed(dto.returnUrl);
    const requestHash = sha256Hex(canonicalJson(dto));

    // Two passes: if a concurrent request wins the unique-index race, the second pass resolves to its row.
    for (let pass = 0; pass < 2; pass++) {
      const existing = await this.resolveExisting(dto, idempotencyKey, requestHash);
      if (existing) return existing;

      let reserved: PaymentOrder;
      try {
        reserved = await this.reserveOrder(dto, idempotencyKey, requestHash);
      } catch (error) {
        if (isUniqueViolation(error)) continue;
        throw error;
      }
      return { order: await this.ensureGatewayOrder(reserved), created: true };
    }
    throw new PaymentError(HttpStatus.CONFLICT, 'CONCURRENT_REQUEST', 'A conflicting request is in progress; retry shortly');
  }

  async findOne(orderId: string) {
    const order = await this.prisma.paymentOrder.findUnique({
      where: { orderId },
      include: { transactions: { orderBy: { createdAt: 'asc' } }, refunds: { orderBy: { createdAt: 'asc' } } },
    });
    if (!order) throw new NotFoundException(`Payment order ${orderId} not found`);
    return order;
  }

  async list(query: ListPaymentOrdersDto) {
    const where: Prisma.PaymentOrderWhereInput = {
      studentId: query.studentId,
      feeReference: query.feeReference,
      status: query.status,
    };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.paymentOrder.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.prisma.paymentOrder.count({ where }),
    ]);
    return { items, total, page: query.page, pageSize: query.pageSize };
  }

  async events(orderId: string) {
    const order = await this.prisma.paymentOrder.findUnique({
      where: { orderId },
      include: { events: { orderBy: { createdAt: 'asc' } } },
    });
    if (!order) throw new NotFoundException(`Payment order ${orderId} not found`);
    return order.events;
  }

  /** Forces a status refresh from Cashfree (e.g. after the customer returns from checkout). */
  verify(orderId: string): Promise<PaymentOrder> {
    return this.sync.syncOrder(orderId, 'API');
  }

  async cancel(orderId: string): Promise<PaymentOrder> {
    const order = await this.prisma.paymentOrder.findUnique({ where: { orderId } });
    if (!order) throw new NotFoundException(`Payment order ${orderId} not found`);
    if (order.status === 'CANCELLED') return order;
    if (order.status === 'PENDING') {
      throw new PaymentError(HttpStatus.CONFLICT, 'PAYMENT_IN_PROGRESS', 'A payment attempt is pending at the bank; cannot cancel now');
    }
    if (!OPEN_STATUSES.includes(order.status)) {
      throw new PaymentError(HttpStatus.CONFLICT, 'NOT_CANCELLABLE', `Order in status ${order.status} cannot be cancelled`);
    }

    try {
      await this.cashfree.terminateOrder(orderId);
    } catch (error) {
      if (!(error instanceof CashfreeApiError)) throw error;
      if (error.isNotFound) {
        return this.prisma.$transaction(async (tx) => {
          const locked = await this.state.lockOrder(tx, order.id);
          return this.state.transition(tx, locked, 'CANCELLED', { source: 'API', note: 'Cancelled before reaching Cashfree' });
        });
      }
      if (error.isTransient) {
        throw new PaymentError(HttpStatus.SERVICE_UNAVAILABLE, 'GATEWAY_UNAVAILABLE', 'Payment gateway unavailable; retry later');
      }
      // Cashfree refused (typically: a payment just went through). Sync below reflects the truth.
      this.logger.warn(`Cashfree refused to terminate ${orderId}: ${error.message}`);
    }

    // Termination is confirmed by re-reading gateway state, never assumed.
    const synced = await this.sync.syncOrder(orderId, 'API');
    if (synced.status !== 'CANCELLED') {
      throw new PaymentError(HttpStatus.CONFLICT, 'NOT_CANCELLABLE', `Order could not be cancelled; current status ${synced.status}`, {
        status: synced.status,
      });
    }
    return synced;
  }

  /** Browser lands here from Cashfree checkout. Status in the redirect is informational only. */
  async handleReturn(orderId: string | undefined): Promise<string> {
    const fallback = new URL(this.config.get('DEFAULT_FRONTEND_RETURN_URL'));
    const order = orderId ? await this.prisma.paymentOrder.findUnique({ where: { orderId } }) : null;
    if (!order) {
      fallback.searchParams.set('status', 'UNKNOWN');
      return fallback.toString();
    }

    let current = order;
    try {
      current = await this.sync.syncOrder(order.orderId, 'RETURN_URL');
    } catch (error) {
      this.logger.warn(`Return-URL sync failed for ${order.orderId}: ${(error as Error).message}`);
    }

    const target = new URL(order.returnUrl ?? fallback.toString());
    target.searchParams.set('order_id', current.orderId);
    target.searchParams.set('status', current.status);
    return target.toString();
  }

  private async resolveExisting(
    dto: CreatePaymentOrderDto,
    idempotencyKey: string,
    requestHash: string,
  ): Promise<CreateOrderResult | null> {
    const byKey = await this.prisma.paymentOrder.findUnique({ where: { idempotencyKey } });
    if (byKey) {
      if (byKey.requestHash !== requestHash) {
        throw new PaymentError(
          HttpStatus.UNPROCESSABLE_ENTITY,
          'IDEMPOTENCY_KEY_REUSED',
          'Idempotency-Key was already used with a different request body',
        );
      }
      // A previous attempt reserved the order but could not reach Cashfree: resume it.
      const order = byKey.status === 'CREATED' ? await this.ensureGatewayOrder(byKey) : byKey;
      return { order, created: false };
    }

    const settled = await this.prisma.paymentOrder.findFirst({
      where: { feeReference: dto.feeReference, status: { in: SETTLED_STATUSES } },
    });
    if (settled) {
      throw new PaymentError(HttpStatus.CONFLICT, 'FEE_ALREADY_PAID', 'This fee has already been paid', {
        orderId: settled.orderId,
      });
    }

    let open = await this.prisma.paymentOrder.findFirst({
      where: { feeReference: dto.feeReference, status: { in: [...OPEN_STATUSES] } },
    });
    if (open && open.status !== 'CREATED' && open.expiresAt && open.expiresAt.getTime() <= Date.now() + 60_000) {
      // Likely expired at Cashfree but not reconciled yet; refresh before deciding.
      open = await this.sync.syncOrder(open.orderId, 'API').catch(() => open);
      if (open && SETTLED_STATUSES.includes(open.status)) {
        throw new PaymentError(HttpStatus.CONFLICT, 'FEE_ALREADY_PAID', 'This fee has already been paid', {
          orderId: open.orderId,
        });
      }
      if (open && !OPEN_STATUSES.includes(open.status)) open = null;
    }
    if (!open) return null;

    if (open.status === 'PENDING') {
      throw new PaymentError(
        HttpStatus.CONFLICT,
        'PAYMENT_IN_PROGRESS',
        'A payment for this fee is pending confirmation from the bank; do not pay again',
        { orderId: open.orderId },
      );
    }

    const sameRequest =
      open.studentId === dto.studentId && toPaise(open.amount) === toPaise(dto.amount) && open.currency === dto.currency;
    if (!sameRequest) {
      throw new PaymentError(
        HttpStatus.CONFLICT,
        'OPEN_ORDER_EXISTS',
        'Another open order exists for this fee with different details; cancel it first',
        { orderId: open.orderId },
      );
    }

    // Same student, same fee, same amount: hand back the existing checkout (Cashfree allows retries on an order).
    const order = open.status === 'CREATED' ? await this.ensureGatewayOrder(open) : open;
    return { order, created: false };
  }

  private reserveOrder(dto: CreatePaymentOrderDto, idempotencyKey: string, requestHash: string): Promise<PaymentOrder> {
    return this.prisma.$transaction(async (tx) => {
      const order = await tx.paymentOrder.create({
        data: {
          orderId: generateReference('UMS'),
          studentId: dto.studentId,
          feeReference: dto.feeReference,
          purpose: dto.purpose,
          amount: new Prisma.Decimal(dto.amount.toFixed(2)),
          currency: dto.currency,
          customerName: dto.customer.name,
          customerEmail: dto.customer.email,
          customerPhone: dto.customer.phone,
          returnUrl: dto.returnUrl,
          metadata: dto.metadata as Prisma.InputJsonValue | undefined,
          idempotencyKey,
          requestHash,
          expiresAt: new Date(Date.now() + this.config.get('PAYMENT_ORDER_TTL_MINUTES') * 60_000),
        },
      });
      await tx.paymentEvent.create({
        data: { paymentOrderId: order.id, toStatus: 'CREATED', source: 'API', note: 'Order reserved' },
      });
      return order;
    });
  }

  /**
   * Makes sure the reserved order exists at Cashfree. Safe to call repeatedly: our order_id is
   * unique at Cashfree, so a retry can never create a second gateway order.
   */
  private async ensureGatewayOrder(order: PaymentOrder): Promise<PaymentOrder> {
    try {
      const cfOrder = await this.cashfree.createOrder(this.buildGatewayRequest(order));
      return await this.sync.applyGatewayState(order.id, cfOrder, [], 'API');
    } catch (error) {
      if (!(error instanceof CashfreeApiError)) throw error;

      if (error.isTransient || error.isConflict) {
        // Outcome unknown (or order already exists): look it up instead of guessing.
        const synced = await this.sync.syncOrder(order.orderId, 'API').catch(() => null);
        if (synced && synced.status !== 'CREATED') return synced;
        await this.prisma.paymentOrder.update({ where: { id: order.id }, data: { lastGatewayError: error.message } });
        throw new PaymentError(
          HttpStatus.SERVICE_UNAVAILABLE,
          'GATEWAY_UNAVAILABLE',
          'Payment gateway is temporarily unavailable; retry with the same Idempotency-Key',
          { orderId: order.orderId },
        );
      }

      await this.prisma.$transaction(async (tx) => {
        const locked = await this.state.lockOrder(tx, order.id);
        await this.state.transition(tx, locked, 'INITIATION_FAILED', {
          source: 'API',
          note: `Cashfree rejected order: ${error.message}`,
          payload: (error.responseBody ?? null) as Prisma.InputJsonValue,
          data: { lastGatewayError: error.message },
        });
      });
      throw new PaymentError(HttpStatus.BAD_GATEWAY, 'GATEWAY_REJECTED', `Cashfree rejected the order: ${error.message}`, {
        orderId: order.orderId,
      });
    }
  }

  private buildGatewayRequest(order: PaymentOrder): CfCreateOrderRequest {
    const base = this.config.get('PUBLIC_BASE_URL').replace(/\/$/, '');
    return {
      order_id: order.orderId,
      order_amount: toGatewayAmount(order.amount),
      order_currency: order.currency,
      customer_details: {
        customer_id: order.studentId.replace(/[^A-Za-z0-9_-]/g, '_'),
        customer_phone: order.customerPhone,
        customer_email: order.customerEmail ?? undefined,
        customer_name: order.customerName ?? undefined,
      },
      order_meta: {
        // Cashfree substitutes {order_id} itself.
        return_url: `${base}/api/v1/payments/return?order_id={order_id}`,
        // Cashfree only delivers to HTTPS; otherwise rely on the dashboard-configured webhook.
        ...(base.startsWith('https://') ? { notify_url: `${base}/api/v1/webhooks/cashfree` } : {}),
      },
      order_expiry_time: order.expiresAt?.toISOString(),
      order_note: order.purpose,
      order_tags: { student_id: order.studentId, fee_reference: order.feeReference, purpose: order.purpose },
    };
  }

  private assertReturnUrlAllowed(returnUrl: string | undefined): void {
    if (!returnUrl) return;
    const allowed = new Set([
      ...this.config.get('ALLOWED_RETURN_ORIGINS'),
      new URL(this.config.get('DEFAULT_FRONTEND_RETURN_URL')).origin,
    ]);
    if (!allowed.has(new URL(returnUrl).origin)) {
      throw new PaymentError(HttpStatus.BAD_REQUEST, 'RETURN_URL_NOT_ALLOWED', 'returnUrl origin is not allow-listed');
    }
  }
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}
