export type CfOrderStatus = 'ACTIVE' | 'PAID' | 'EXPIRED' | 'TERMINATED' | 'TERMINATION_REQUESTED';

export type CfPaymentStatus =
  | 'SUCCESS'
  | 'NOT_ATTEMPTED'
  | 'PENDING'
  | 'FAILED'
  | 'USER_DROPPED'
  | 'CANCELLED'
  | 'VOID';

export type CfRefundStatus = 'SUCCESS' | 'PENDING' | 'CANCELLED' | 'ONHOLD';

export interface CfCreateOrderRequest {
  order_id: string;
  order_amount: number;
  order_currency: string;
  customer_details: {
    customer_id: string;
    customer_phone: string;
    customer_email?: string;
    customer_name?: string;
  };
  order_meta?: {
    return_url?: string;
    notify_url?: string;
  };
  order_expiry_time?: string;
  order_note?: string;
  order_tags?: Record<string, string>;
}

export interface CfOrder {
  cf_order_id: string | number;
  order_id: string;
  order_amount: number;
  order_currency: string;
  order_status: CfOrderStatus;
  payment_session_id?: string;
  order_expiry_time?: string;
  created_at?: string;
}

export interface CfPayment {
  cf_payment_id: string | number;
  order_id: string;
  payment_status: CfPaymentStatus;
  payment_amount: number;
  payment_currency?: string;
  payment_message?: string | null;
  payment_time?: string | null;
  payment_completion_time?: string | null;
  payment_group?: string | null;
  bank_reference?: string | null;
  error_details?: Record<string, unknown> | null;
  [key: string]: unknown;
}

export interface CfCreateRefundRequest {
  refund_amount: number;
  refund_id: string;
  refund_note?: string;
}

export interface CfRefund {
  cf_refund_id?: string | number;
  cf_payment_id?: string | number;
  refund_id: string;
  order_id: string;
  refund_amount: number;
  refund_status: CfRefundStatus;
  status_description?: string | null;
  processed_at?: string | null;
  [key: string]: unknown;
}

export interface CfWebhookEnvelope {
  type: string;
  event_time?: string;
  data?: {
    order?: { order_id?: string; order_amount?: number; order_currency?: string };
    payment?: Partial<CfPayment>;
    refund?: Partial<CfRefund>;
    [key: string]: unknown;
  };
}
