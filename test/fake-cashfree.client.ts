import { CashfreeApiError } from '../src/cashfree/cashfree.errors';
import {
  CfCreateOrderRequest,
  CfCreateRefundRequest,
  CfOrder,
  CfOrderStatus,
  CfPayment,
  CfPaymentStatus,
  CfRefund,
  CfRefundStatus,
} from '../src/cashfree/cashfree.types';

type Operation = 'createOrder' | 'getOrder' | 'getPayments' | 'terminateOrder' | 'createRefund' | 'getRefund';

/** In-memory stand-in for Cashfree that mimics its idempotency and error semantics. */
export class FakeCashfreeClient {
  orders = new Map<string, CfOrder>();
  payments = new Map<string, CfPayment[]>();
  refunds = new Map<string, CfRefund>();
  private failures = new Map<Operation, CashfreeApiError>();
  /** Simulates "request reached Cashfree, but the response was lost". */
  timeoutAfterCreate = false;
  refundStatusOnCreate: CfRefundStatus = 'PENDING';
  private seq = 1000;

  reset(): void {
    this.orders.clear();
    this.payments.clear();
    this.refunds.clear();
    this.failures.clear();
    this.timeoutAfterCreate = false;
    this.refundStatusOnCreate = 'PENDING';
  }

  failNext(op: Operation, error: CashfreeApiError): void {
    this.failures.set(op, error);
  }

  async createOrder(body: CfCreateOrderRequest): Promise<CfOrder> {
    this.maybeFail('createOrder');
    if (this.orders.has(body.order_id)) {
      throw new CashfreeApiError('order with same id is already present', 409, 'order_already_exists');
    }
    const order: CfOrder = {
      cf_order_id: ++this.seq,
      order_id: body.order_id,
      order_amount: body.order_amount,
      order_currency: body.order_currency,
      order_status: 'ACTIVE',
      payment_session_id: `session_${body.order_id}`,
      order_expiry_time: body.order_expiry_time,
    };
    this.orders.set(order.order_id, order);
    if (this.timeoutAfterCreate) {
      this.timeoutAfterCreate = false;
      throw new CashfreeApiError('Cashfree unreachable: The operation was aborted due to timeout', 0);
    }
    return { ...order };
  }

  async getOrder(orderId: string): Promise<CfOrder> {
    this.maybeFail('getOrder');
    const order = this.orders.get(orderId);
    if (!order) throw new CashfreeApiError('order not found', 404, 'order_not_found');
    return { ...order };
  }

  async getPayments(orderId: string): Promise<CfPayment[]> {
    this.maybeFail('getPayments');
    return [...(this.payments.get(orderId) ?? [])];
  }

  async terminateOrder(orderId: string): Promise<CfOrder> {
    this.maybeFail('terminateOrder');
    const order = this.orders.get(orderId);
    if (!order) throw new CashfreeApiError('order not found', 404, 'order_not_found');
    if (order.order_status !== 'ACTIVE') {
      throw new CashfreeApiError(`order is ${order.order_status}`, 400, 'order_not_active');
    }
    order.order_status = 'TERMINATED';
    return { ...order };
  }

  async createRefund(orderId: string, body: CfCreateRefundRequest): Promise<CfRefund> {
    this.maybeFail('createRefund');
    if (this.refunds.has(body.refund_id)) {
      throw new CashfreeApiError('refund with same id already exists', 409, 'refund_already_exists');
    }
    const refund: CfRefund = {
      cf_refund_id: ++this.seq,
      refund_id: body.refund_id,
      order_id: orderId,
      refund_amount: body.refund_amount,
      refund_status: this.refundStatusOnCreate,
      processed_at: this.refundStatusOnCreate === 'SUCCESS' ? new Date().toISOString() : null,
    };
    this.refunds.set(refund.refund_id, refund);
    return { ...refund };
  }

  async getRefund(_orderId: string, refundId: string): Promise<CfRefund> {
    this.maybeFail('getRefund');
    const refund = this.refunds.get(refundId);
    if (!refund) throw new CashfreeApiError('refund not found', 404, 'refund_not_found');
    return { ...refund };
  }

  // ---- simulation helpers -------------------------------------------------

  addPayment(orderId: string, status: CfPaymentStatus): CfPayment {
    const order = this.orders.get(orderId);
    if (!order) throw new Error(`fake: unknown order ${orderId}`);
    const payment: CfPayment = {
      cf_payment_id: ++this.seq,
      order_id: orderId,
      payment_status: status,
      payment_amount: order.order_amount,
      payment_currency: order.order_currency,
      payment_group: 'upi',
      payment_message: `simulated ${status}`,
      payment_time: new Date(Date.now() + this.seq).toISOString(),
      bank_reference: `BANK${this.seq}`,
    };
    this.payments.set(orderId, [...(this.payments.get(orderId) ?? []), payment]);
    if (status === 'SUCCESS') order.order_status = 'PAID';
    return payment;
  }

  resolvePayment(orderId: string, cfPaymentId: CfPayment['cf_payment_id'], status: CfPaymentStatus): void {
    const payment = this.payments.get(orderId)?.find((p) => p.cf_payment_id === cfPaymentId);
    if (!payment) throw new Error('fake: unknown payment');
    payment.payment_status = status;
    if (status === 'SUCCESS') this.orders.get(orderId)!.order_status = 'PAID';
  }

  setOrderStatus(orderId: string, status: CfOrderStatus): void {
    this.orders.get(orderId)!.order_status = status;
  }

  setRefundStatus(refundId: string, status: CfRefundStatus): void {
    const refund = this.refunds.get(refundId)!;
    refund.refund_status = status;
    if (status === 'SUCCESS') refund.processed_at = new Date().toISOString();
  }

  private maybeFail(op: Operation): void {
    const error = this.failures.get(op);
    if (error) {
      this.failures.delete(op);
      throw error;
    }
  }
}
