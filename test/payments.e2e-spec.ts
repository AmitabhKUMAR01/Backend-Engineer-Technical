import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { createServer, IncomingMessage, Server } from 'http';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { CashfreeClient } from '../src/cashfree/cashfree.client';
import { computeCashfreeSignature } from '../src/cashfree/cashfree-signature';
import { CashfreeApiError } from '../src/cashfree/cashfree.errors';
import { hmacSha256 } from '../src/common/crypto';
import { ReconciliationService } from '../src/jobs/reconciliation.service';
import { configureApp } from '../src/main';
import { OutboxDispatcher } from '../src/outbox/outbox.dispatcher';
import { PrismaService } from '../src/prisma/prisma.service';
import { FakeCashfreeClient } from './fake-cashfree.client';
import { TEST_ENV } from './test-env';

const API_KEY = TEST_ENV.API_KEYS;
const SECRET = TEST_ENV.CASHFREE_CLIENT_SECRET;

interface ErpDelivery {
  headers: IncomingMessage['headers'];
  body: string;
}

describe('Payments module (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let reconciliation: ReconciliationService;
  let dispatcher: OutboxDispatcher;
  let erpServer: Server;
  const erpDeliveries: ErpDelivery[] = [];
  let erpFailuresRemaining = 0;
  const fake = new FakeCashfreeClient();
  let keySeq = 0;

  const http = () => request(app.getHttpServer());
  const newKey = () => `test-key-${Date.now()}-${++keySeq}`;

  const orderBody = (overrides: Record<string, unknown> = {}) => ({
    studentId: 'STU-1001',
    feeReference: 'INV-2026-0001',
    purpose: 'TUITION_FEE',
    amount: 45000.5,
    customer: { name: 'Asha Verma', email: 'asha@example.edu', phone: '9876543210' },
    metadata: { semester: '2026-ODD' },
    ...overrides,
  });

  const createOrder = (body = orderBody(), key = newKey()) =>
    http().post('/api/v1/payments/orders').set('x-api-key', API_KEY).set('Idempotency-Key', key).send(body);

  const getOrder = (orderId: string) =>
    http().get(`/api/v1/payments/orders/${orderId}`).set('x-api-key', API_KEY);

  const sendWebhook = (payload: unknown, opts: { signature?: string } = {}) => {
    const raw = JSON.stringify(payload);
    const timestamp = String(Date.now());
    return http()
      .post('/api/v1/webhooks/cashfree')
      .set('content-type', 'application/json')
      .set('x-webhook-timestamp', timestamp)
      .set('x-webhook-signature', opts.signature ?? computeCashfreeSignature(timestamp, raw, SECRET))
      .set('x-webhook-version', '2025-01-01')
      .send(raw);
  };

  const paymentWebhook = (orderId: string, type: string, status: string, cfPaymentId: string | number) => ({
    type,
    event_time: new Date().toISOString(),
    data: {
      order: { order_id: orderId, order_amount: 45000.5, order_currency: 'INR' },
      payment: { cf_payment_id: String(cfPaymentId), payment_status: status, payment_amount: 45000.5 },
    },
  });

  beforeAll(async () => {
    erpServer = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        if (erpFailuresRemaining > 0) {
          erpFailuresRemaining--;
          res.writeHead(500).end();
          return;
        }
        erpDeliveries.push({ headers: req.headers, body });
        res.writeHead(200).end();
      });
    });
    await new Promise<void>((resolve) => erpServer.listen(4599, '127.0.0.1', resolve));

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(CashfreeClient)
      .useValue(fake)
      .compile();
    app = moduleRef.createNestApplication({ rawBody: true });
    configureApp(app);
    await app.init();

    prisma = app.get(PrismaService);
    reconciliation = app.get(ReconciliationService);
    dispatcher = app.get(OutboxDispatcher);
  });

  beforeEach(async () => {
    fake.reset();
    erpDeliveries.length = 0;
    erpFailuresRemaining = 0;
    await prisma.$executeRawUnsafe(
      'TRUNCATE payment_transactions, refunds, payment_events, webhook_events, outbox_events, payment_orders CASCADE',
    );
  });

  afterAll(async () => {
    await app?.close();
    await new Promise((resolve) => erpServer?.close(resolve));
  });

  describe('security & validation', () => {
    it('rejects requests without a valid API key', async () => {
      await http().get('/api/v1/payments/orders').expect(401);
      await http().get('/api/v1/payments/orders').set('x-api-key', 'wrong').expect(401);
    });

    it('requires an Idempotency-Key on create', async () => {
      const res = await http().post('/api/v1/payments/orders').set('x-api-key', API_KEY).send(orderBody());
      expect(res.status).toBe(400);
    });

    it('validates the payload (amount precision, phone, unknown fields)', async () => {
      await createOrder(orderBody({ amount: 10.123 })).expect(400);
      await createOrder(orderBody({ amount: -5 })).expect(400);
      await createOrder(orderBody({ customer: { phone: '123' } })).expect(400);
      await createOrder({ ...orderBody(), isAdmin: true } as never).expect(400);
    });

    it('rejects return URLs outside the allow-list (open redirect protection)', async () => {
      const res = await createOrder(orderBody({ returnUrl: 'https://evil.example.com/steal' }));
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('RETURN_URL_NOT_ALLOWED');
    });

    it('rejects webhooks with an invalid signature and stores nothing', async () => {
      await sendWebhook({ type: 'PAYMENT_SUCCESS_WEBHOOK' }, { signature: 'forged' }).expect(401);
      expect(await prisma.webhookEvent.count()).toBe(0);
    });
  });

  describe('order creation & idempotency', () => {
    it('creates an order at Cashfree and returns a checkout session', async () => {
      const res = await createOrder().expect(201);
      expect(res.body).toMatchObject({
        status: 'ACTIVE',
        amount: '45000.50',
        currency: 'INR',
        feeReference: 'INV-2026-0001',
        checkout: { environment: 'sandbox' },
      });
      expect(res.body.checkout.paymentSessionId).toBe(`session_${res.body.orderId}`);
      expect(fake.orders.get(res.body.orderId)?.order_amount).toBe(45000.5);
    });

    it('replays the same response for the same Idempotency-Key and body', async () => {
      const key = newKey();
      const first = await createOrder(orderBody(), key).expect(201);
      const second = await createOrder(orderBody(), key).expect(200);
      expect(second.body.orderId).toBe(first.body.orderId);
      expect(fake.orders.size).toBe(1);
    });

    it('rejects reuse of an Idempotency-Key with a different body', async () => {
      const key = newKey();
      await createOrder(orderBody(), key).expect(201);
      const res = await createOrder(orderBody({ amount: 100 }), key).expect(422);
      expect(res.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
    });

    it('reuses the open order for the same fee instead of creating a duplicate', async () => {
      const first = await createOrder().expect(201);
      const second = await createOrder().expect(200);
      expect(second.body.orderId).toBe(first.body.orderId);

      const conflict = await createOrder(orderBody({ amount: 50000 })).expect(409);
      expect(conflict.body.code).toBe('OPEN_ORDER_EXISTS');
    });

    it('creates exactly one order under concurrent requests for the same fee', async () => {
      const responses = await Promise.all(Array.from({ length: 6 }, () => createOrder()));
      const ids = new Set(responses.filter((r) => r.status < 300).map((r) => r.body.orderId));
      expect(ids.size).toBe(1);
      expect(await prisma.paymentOrder.count()).toBe(1);
      expect(fake.orders.size).toBe(1);
    });

    it('returns 503 when Cashfree is down, then resumes on retry with the same key', async () => {
      const key = newKey();
      fake.failNext('createOrder', new CashfreeApiError('Cashfree unreachable', 0));
      const failed = await createOrder(orderBody(), key).expect(503);
      expect(failed.body.code).toBe('GATEWAY_UNAVAILABLE');

      const stored = await prisma.paymentOrder.findUniqueOrThrow({ where: { orderId: failed.body.details.orderId } });
      expect(stored.status).toBe('CREATED');

      const retried = await createOrder(orderBody(), key).expect(200);
      expect(retried.body.orderId).toBe(failed.body.details.orderId);
      expect(retried.body.status).toBe('ACTIVE');
    });

    it('adopts the gateway order when the create response was lost (timeout after success)', async () => {
      fake.timeoutAfterCreate = true;
      const res = await createOrder().expect(201);
      expect(res.body.status).toBe('ACTIVE');
      expect(fake.orders.size).toBe(1);
    });

    it('marks INITIATION_FAILED when Cashfree rejects the order, and allows a fresh attempt', async () => {
      fake.failNext('createOrder', new CashfreeApiError('customer_phone is invalid', 400, 'request_invalid'));
      const res = await createOrder().expect(502);
      expect(res.body.code).toBe('GATEWAY_REJECTED');
      const stored = await prisma.paymentOrder.findUniqueOrThrow({ where: { orderId: res.body.details.orderId } });
      expect(stored.status).toBe('INITIATION_FAILED');

      await createOrder().expect(201);
    });
  });

  describe('payment lifecycle via webhooks', () => {
    it('marks the order PAID on a success webhook and notifies the ERP exactly once', async () => {
      const { body: order } = await createOrder().expect(201);
      const payment = fake.addPayment(order.orderId, 'SUCCESS');
      const webhook = paymentWebhook(order.orderId, 'PAYMENT_SUCCESS_WEBHOOK', 'SUCCESS', payment.cf_payment_id);

      await sendWebhook(webhook).expect(200);
      const duplicate = await sendWebhook(webhook).expect(200);
      expect(duplicate.body.duplicate).toBe(true);

      const { body: paid } = await getOrder(order.orderId).expect(200);
      expect(paid.status).toBe('PAID');
      expect(paid.paidAt).toBeTruthy();
      expect(paid.checkout).toBeNull();
      expect(paid.transactions).toHaveLength(1);
      expect(paid.transactions[0]).toMatchObject({ status: 'SUCCESS', bankReference: expect.any(String) });

      const outbox = await prisma.outboxEvent.findMany({ where: { eventType: 'payment.succeeded' } });
      expect(outbox).toHaveLength(1);

      await dispatcher.dispatchBatch();
      expect(erpDeliveries).toHaveLength(1);
      const delivery = erpDeliveries[0];
      expect(delivery.headers['x-ums-signature']).toBe(hmacSha256(TEST_ENV.ERP_WEBHOOK_SECRET, delivery.body, 'hex'));
      expect(JSON.parse(delivery.body)).toMatchObject({
        type: 'payment.succeeded',
        data: { orderId: order.orderId, feeReference: 'INV-2026-0001', status: 'PAID', amount: '45000.50' },
      });

      const again = await createOrder(orderBody(), newKey()).expect(409);
      expect(again.body.code).toBe('FEE_ALREADY_PAID');
    });

    it('never downgrades PAID when a stale failure webhook arrives late', async () => {
      const { body: order } = await createOrder().expect(201);
      const failed = fake.addPayment(order.orderId, 'FAILED');
      fake.addPayment(order.orderId, 'SUCCESS');
      await sendWebhook(paymentWebhook(order.orderId, 'PAYMENT_SUCCESS_WEBHOOK', 'SUCCESS', 1)).expect(200);
      await sendWebhook(paymentWebhook(order.orderId, 'PAYMENT_FAILED_WEBHOOK', 'FAILED', failed.cf_payment_id)).expect(200);

      const { body } = await getOrder(order.orderId).expect(200);
      expect(body.status).toBe('PAID');
      expect(body.transactions).toHaveLength(2);
    });

    it('keeps a failed order payable and accepts a successful retry', async () => {
      const { body: order } = await createOrder().expect(201);
      const attempt = fake.addPayment(order.orderId, 'FAILED');
      await sendWebhook(paymentWebhook(order.orderId, 'PAYMENT_FAILED_WEBHOOK', 'FAILED', attempt.cf_payment_id)).expect(200);

      let { body } = await getOrder(order.orderId).expect(200);
      expect(body.status).toBe('FAILED');
      expect(body.checkout?.paymentSessionId).toBeTruthy();

      fake.addPayment(order.orderId, 'SUCCESS');
      await sendWebhook(paymentWebhook(order.orderId, 'PAYMENT_SUCCESS_WEBHOOK', 'SUCCESS', 2)).expect(200);
      ({ body } = await getOrder(order.orderId).expect(200));
      expect(body.status).toBe('PAID');
    });

    it('handles user-dropped and pending payments; blocks double payment while pending', async () => {
      const { body: order } = await createOrder().expect(201);
      fake.addPayment(order.orderId, 'USER_DROPPED');
      await sendWebhook(paymentWebhook(order.orderId, 'PAYMENT_USER_DROPPED_WEBHOOK', 'USER_DROPPED', 1)).expect(200);
      expect((await getOrder(order.orderId)).body.status).toBe('USER_DROPPED');

      const pending = fake.addPayment(order.orderId, 'PENDING');
      await http().post(`/api/v1/payments/orders/${order.orderId}/verify`).set('x-api-key', API_KEY).expect(200);
      expect((await getOrder(order.orderId)).body.status).toBe('PENDING');

      const second = await createOrder(orderBody(), newKey()).expect(409);
      expect(second.body.code).toBe('PAYMENT_IN_PROGRESS');
      const cancel = await http().post(`/api/v1/payments/orders/${order.orderId}/cancel`).set('x-api-key', API_KEY).expect(409);
      expect(cancel.body.code).toBe('PAYMENT_IN_PROGRESS');

      fake.resolvePayment(order.orderId, pending.cf_payment_id, 'SUCCESS');
      await http().post(`/api/v1/payments/orders/${order.orderId}/verify`).set('x-api-key', API_KEY).expect(200);
      expect((await getOrder(order.orderId)).body.status).toBe('PAID');
    });

    it('acknowledges but ignores webhooks for unknown orders and unknown event types', async () => {
      await sendWebhook(paymentWebhook('UMS_UNKNOWN', 'PAYMENT_SUCCESS_WEBHOOK', 'SUCCESS', 1)).expect(200);
      await sendWebhook({ type: 'SOME_NEW_WEBHOOK', data: {} }).expect(200);
      const events = await prisma.webhookEvent.findMany();
      expect(events.map((e) => e.status)).toEqual(['IGNORED', 'IGNORED']);
    });

    it('persists the webhook and retries it later if Cashfree is unreachable during processing', async () => {
      const { body: order } = await createOrder().expect(201);
      fake.addPayment(order.orderId, 'SUCCESS');
      fake.failNext('getOrder', new CashfreeApiError('Cashfree unreachable', 0));

      await sendWebhook(paymentWebhook(order.orderId, 'PAYMENT_SUCCESS_WEBHOOK', 'SUCCESS', 1)).expect(200);
      let event = await prisma.webhookEvent.findFirstOrThrow();
      expect(event.status).toBe('FAILED');

      await prisma.webhookEvent.update({ where: { id: event.id }, data: { receivedAt: new Date(Date.now() - 120_000) } });
      await reconciliation.retryWebhooks();
      event = await prisma.webhookEvent.findFirstOrThrow();
      expect(event.status).toBe('PROCESSED');
      expect((await getOrder(order.orderId)).body.status).toBe('PAID');
    });
  });

  describe('cancellation, expiry and reconciliation', () => {
    it('cancels an active order at Cashfree; cancelling again is idempotent', async () => {
      const { body: order } = await createOrder().expect(201);
      const res = await http().post(`/api/v1/payments/orders/${order.orderId}/cancel`).set('x-api-key', API_KEY).expect(200);
      expect(res.body.status).toBe('CANCELLED');
      expect(fake.orders.get(order.orderId)?.order_status).toBe('TERMINATED');
      await http().post(`/api/v1/payments/orders/${order.orderId}/cancel`).set('x-api-key', API_KEY).expect(200);

      // A new order can now be created for the same fee.
      await createOrder(orderBody(), newKey()).expect(201);
    });

    it('reconciles missed webhooks: expiry, then a late success gets recorded and flagged', async () => {
      const { body: order } = await createOrder().expect(201);
      const backdate = () =>
        prisma.paymentOrder.update({
          where: { orderId: order.orderId },
          data: { createdAt: new Date(Date.now() - 3600_000), lastSyncedAt: new Date(Date.now() - 3600_000) },
        });

      fake.setOrderStatus(order.orderId, 'EXPIRED');
      await backdate();
      await reconciliation.reconcileOrders();
      expect((await getOrder(order.orderId)).body.status).toBe('EXPIRED');

      // Bank confirms a payment after expiry: money moved, so we must record it.
      fake.addPayment(order.orderId, 'SUCCESS');
      await sendWebhook(paymentWebhook(order.orderId, 'PAYMENT_SUCCESS_WEBHOOK', 'SUCCESS', 1)).expect(200);
      const { body } = await getOrder(order.orderId).expect(200);
      expect(body.status).toBe('PAID');
      expect(body.flaggedReason).toBe('LATE_SUCCESS_AFTER_EXPIRED');

      const { body: events } = await http().get(`/api/v1/payments/orders/${order.orderId}/events`).set('x-api-key', API_KEY).expect(200);
      expect(events.map((e: { toStatus: string }) => e.toStatus)).toEqual(['CREATED', 'ACTIVE', 'EXPIRED', 'PAID']);
    });

    it('redirects the browser from the return URL with the verified status', async () => {
      const { body: order } = await createOrder().expect(201);
      fake.addPayment(order.orderId, 'SUCCESS');
      const res = await http().get(`/api/v1/payments/return?order_id=${order.orderId}`).expect(302);
      const location = new URL(res.headers.location);
      expect(location.origin + location.pathname).toBe(TEST_ENV.DEFAULT_FRONTEND_RETURN_URL);
      expect(location.searchParams.get('status')).toBe('PAID');
      expect((await getOrder(order.orderId)).body.status).toBe('PAID');
    });

    it('retries ERP delivery with backoff when the ERP is down', async () => {
      const { body: order } = await createOrder().expect(201);
      fake.addPayment(order.orderId, 'SUCCESS');
      await sendWebhook(paymentWebhook(order.orderId, 'PAYMENT_SUCCESS_WEBHOOK', 'SUCCESS', 1)).expect(200);

      erpFailuresRemaining = 1;
      await dispatcher.dispatchBatch();
      let event = await prisma.outboxEvent.findFirstOrThrow({ where: { eventType: 'payment.succeeded' } });
      expect(event.status).toBe('PENDING');
      expect(event.attempts).toBe(1);
      expect(event.nextAttemptAt!.getTime()).toBeGreaterThan(event.createdAt.getTime());

      await prisma.$executeRaw`UPDATE outbox_events SET next_attempt_at = now() WHERE id = ${event.id}::uuid`;
      await dispatcher.dispatchBatch();
      event = await prisma.outboxEvent.findFirstOrThrow({ where: { id: event.id } });
      expect(event.status).toBe('SENT');
      expect(erpDeliveries).toHaveLength(1);
    });
  });

  describe('refunds', () => {
    const payOrder = async () => {
      const { body: order } = await createOrder().expect(201);
      fake.addPayment(order.orderId, 'SUCCESS');
      await sendWebhook(paymentWebhook(order.orderId, 'PAYMENT_SUCCESS_WEBHOOK', 'SUCCESS', 1)).expect(200);
      return order.orderId as string;
    };
    const refund = (orderId: string, amount: number, key = newKey()) =>
      http()
        .post(`/api/v1/payments/orders/${orderId}/refunds`)
        .set('x-api-key', API_KEY)
        .set('Idempotency-Key', key)
        .send({ amount, reason: 'Course withdrawal' });

    it('rejects refunds for unpaid orders', async () => {
      const { body: order } = await createOrder().expect(201);
      const res = await refund(order.orderId, 100).expect(409);
      expect(res.body.code).toBe('NOT_REFUNDABLE');
    });

    it('processes partial then full refunds and never exceeds the paid amount', async () => {
      const orderId = await payOrder();

      const key = newKey();
      const partial = await refund(orderId, 10000, key).expect(201);
      expect(partial.body.status).toBe('PENDING');
      await refund(orderId, 10000, key).expect(200);

      const over = await refund(orderId, 40000).expect(422);
      expect(over.body.code).toBe('REFUND_EXCEEDS_BALANCE');
      expect(over.body.details.refundable).toBe('35000.50');

      fake.setRefundStatus(partial.body.refundId, 'SUCCESS');
      await sendWebhook({
        type: 'REFUND_STATUS_WEBHOOK',
        data: { refund: { refund_id: partial.body.refundId, order_id: orderId, refund_status: 'SUCCESS' } },
      }).expect(200);
      expect((await getOrder(orderId)).body.status).toBe('PARTIALLY_REFUNDED');

      fake.refundStatusOnCreate = 'SUCCESS';
      await refund(orderId, 35000.5).expect(201);
      const { body } = await getOrder(orderId).expect(200);
      expect(body.status).toBe('REFUNDED');
      expect(body.refunds).toHaveLength(2);

      const types = (await prisma.outboxEvent.findMany({ orderBy: { createdAt: 'asc' } })).map((e) => e.eventType);
      expect(types).toEqual([
        'payment.succeeded',
        'refund.succeeded',
        'payment.partially_refunded',
        'refund.succeeded',
        'payment.refunded',
      ]);
    });

    it('resubmits a refund whose first submission had an unknown outcome', async () => {
      const orderId = await payOrder();
      fake.failNext('createRefund', new CashfreeApiError('Cashfree unreachable', 0));
      const res = await refund(orderId, 500).expect(201);
      expect(res.body.status).toBe('PENDING');
      expect(res.body.cfRefundId).toBeNull();

      await prisma.refund.update({
        where: { refundId: res.body.refundId },
        data: { createdAt: new Date(Date.now() - 3600_000) },
      });
      await reconciliation.reconcileRefunds();
      const stored = await prisma.refund.findUniqueOrThrow({ where: { refundId: res.body.refundId } });
      expect(stored.cfRefundId).toBeTruthy();
      expect(fake.refunds.size).toBe(1);
    });
  });

  it('exposes a health check', async () => {
    await http().get('/health').expect(200, { status: 'ok', database: 'up' });
  });

  it('lists orders with filters and pagination', async () => {
    await createOrder().expect(201);
    await createOrder(orderBody({ feeReference: 'INV-2026-0002' })).expect(201);
    const res = await http()
      .get('/api/v1/payments/orders?studentId=STU-1001&pageSize=1')
      .set('x-api-key', API_KEY)
      .expect(200);
    expect(res.body.total).toBe(2);
    expect(res.body.items).toHaveLength(1);
  });
});
