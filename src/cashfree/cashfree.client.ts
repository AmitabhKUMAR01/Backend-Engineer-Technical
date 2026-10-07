import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { AppConfig } from '../config/app-config.service';
import { CashfreeApiError } from './cashfree.errors';
import {
  CfCreateOrderRequest,
  CfCreateRefundRequest,
  CfOrder,
  CfPayment,
  CfRefund,
} from './cashfree.types';

/**
 * Thin, typed wrapper over the Cashfree PG REST API.
 * Kept free of business logic so it can be faked in tests and swapped for another gateway.
 */
@Injectable()
export class CashfreeClient {
  private readonly logger = new Logger(CashfreeClient.name);

  constructor(private readonly config: AppConfig) {}

  createOrder(body: CfCreateOrderRequest): Promise<CfOrder> {
    return this.request<CfOrder>('POST', '/orders', body);
  }

  getOrder(orderId: string): Promise<CfOrder> {
    return this.request<CfOrder>('GET', `/orders/${encodeURIComponent(orderId)}`);
  }

  getPayments(orderId: string): Promise<CfPayment[]> {
    return this.request<CfPayment[]>('GET', `/orders/${encodeURIComponent(orderId)}/payments`);
  }

  terminateOrder(orderId: string): Promise<CfOrder> {
    return this.request<CfOrder>('PATCH', `/orders/${encodeURIComponent(orderId)}`, {
      order_status: 'TERMINATED',
    });
  }

  createRefund(orderId: string, body: CfCreateRefundRequest): Promise<CfRefund> {
    return this.request<CfRefund>('POST', `/orders/${encodeURIComponent(orderId)}/refunds`, body);
  }

  getRefund(orderId: string, refundId: string): Promise<CfRefund> {
    return this.request<CfRefund>(
      'GET',
      `/orders/${encodeURIComponent(orderId)}/refunds/${encodeURIComponent(refundId)}`,
    );
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const requestId = randomUUID();
    const started = Date.now();
    let response: Response;

    try {
      response = await fetch(`${this.config.cashfreeBaseUrl}${path}`, {
        method,
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          'x-api-version': this.config.get('CASHFREE_API_VERSION'),
          'x-client-id': this.config.get('CASHFREE_CLIENT_ID'),
          'x-client-secret': this.config.get('CASHFREE_CLIENT_SECRET'),
          'x-request-id': requestId,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.config.get('CASHFREE_TIMEOUT_MS')),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Cashfree ${method} ${path} network error after ${Date.now() - started}ms: ${reason}`);
      throw new CashfreeApiError(`Cashfree unreachable: ${reason}`, 0);
    }

    const text = await response.text();
    const parsed = text ? safeJson(text) : undefined;
    this.logger.log(`Cashfree ${method} ${path} -> ${response.status} in ${Date.now() - started}ms [${requestId}]`);

    if (!response.ok) {
      const payload = (parsed ?? {}) as { message?: string; code?: string };
      throw new CashfreeApiError(
        payload.message ?? `Cashfree responded with HTTP ${response.status}`,
        response.status,
        payload.code,
        parsed,
      );
    }
    return parsed as T;
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { message: text.slice(0, 500) };
  }
}
