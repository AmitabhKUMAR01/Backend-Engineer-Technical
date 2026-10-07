import { HttpException, HttpStatus } from '@nestjs/common';

/** HTTP error with a stable machine-readable `code` the ERP can branch on. */
export class PaymentError extends HttpException {
  constructor(status: HttpStatus, code: string, message: string, details?: Record<string, unknown>) {
    super({ statusCode: status, code, message, ...(details ? { details } : {}) }, status);
  }
}
