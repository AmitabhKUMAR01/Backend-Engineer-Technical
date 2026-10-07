export class CashfreeApiError extends Error {
  constructor(
    message: string,
    /** HTTP status, or 0 when the request never got a response (network error / timeout). */
    readonly httpStatus: number,
    readonly code?: string,
    readonly responseBody?: unknown,
  ) {
    super(message);
    this.name = 'CashfreeApiError';
  }

  /**
   * The outcome is unknown and the call may or may not have taken effect at Cashfree.
   * Callers must re-check state (GET) before deciding, and may retry safely because
   * our merchant ids (order_id / refund_id) make retries idempotent at Cashfree.
   */
  get isTransient(): boolean {
    return this.httpStatus === 0 || this.httpStatus === 429 || this.httpStatus >= 500;
  }

  get isNotFound(): boolean {
    return this.httpStatus === 404;
  }

  /** Cashfree answers 409 when the merchant order_id / refund_id already exists. */
  get isConflict(): boolean {
    return this.httpStatus === 409;
  }
}
