import { Controller, Get, Query, Res } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { Response } from 'express';
import { PaymentsService } from './payments.service';

/** Public: the customer's browser is redirected here by Cashfree after checkout. */
@ApiExcludeController()
@Controller('api/v1/payments/return')
export class PaymentReturnController {
  constructor(private readonly payments: PaymentsService) {}

  @Get()
  async handleReturn(@Query('order_id') orderId: string | undefined, @Res() res: Response) {
    res.redirect(302, await this.payments.handleReturn(orderId));
  }
}
