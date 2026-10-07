import { Body, Controller, Get, HttpCode, Param, Post, Query, Res, UseGuards } from '@nestjs/common';
import { ApiHeader, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { Response } from 'express';
import { ApiKeyGuard } from '../common/api-key.guard';
import { IdempotencyKey } from '../common/idempotency-key.decorator';
import { AppConfig } from '../config/app-config.service';
import { CreatePaymentOrderDto } from './dto/create-payment-order.dto';
import { CreateRefundDto } from './dto/create-refund.dto';
import { ListPaymentOrdersDto } from './dto/list-payment-orders.dto';
import { presentEvent, presentOrder, presentRefund } from './payment.presenter';
import { PaymentsService } from './payments.service';
import { RefundsService } from './refunds.service';

@ApiTags('payments')
@ApiSecurity('api-key')
@UseGuards(ApiKeyGuard)
@Controller('api/v1/payments/orders')
export class PaymentsController {
  constructor(
    private readonly payments: PaymentsService,
    private readonly refunds: RefundsService,
    private readonly config: AppConfig,
  ) {}

  /** Create (or idempotently return) a payment order and its Cashfree checkout session. */
  @Post()
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  async create(
    @Body() dto: CreatePaymentOrderDto,
    @IdempotencyKey() idempotencyKey: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { order, created } = await this.payments.createOrder(dto, idempotencyKey);
    res.status(created ? 201 : 200);
    return presentOrder(order, this.env);
  }

  @Get()
  async list(@Query() query: ListPaymentOrdersDto) {
    const page = await this.payments.list(query);
    return { ...page, items: page.items.map((order) => presentOrder(order, this.env)) };
  }

  @Get(':orderId')
  async findOne(@Param('orderId') orderId: string) {
    return presentOrder(await this.payments.findOne(orderId), this.env);
  }

  /** Audit trail of every status change. */
  @Get(':orderId/events')
  async events(@Param('orderId') orderId: string) {
    return (await this.payments.events(orderId)).map(presentEvent);
  }

  /** Re-fetch the authoritative status from Cashfree now. */
  @Post(':orderId/verify')
  @HttpCode(200)
  async verify(@Param('orderId') orderId: string) {
    await this.payments.verify(orderId);
    return presentOrder(await this.payments.findOne(orderId), this.env);
  }

  @Post(':orderId/cancel')
  @HttpCode(200)
  async cancel(@Param('orderId') orderId: string) {
    return presentOrder(await this.payments.cancel(orderId), this.env);
  }

  @Post(':orderId/refunds')
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  async createRefund(
    @Param('orderId') orderId: string,
    @Body() dto: CreateRefundDto,
    @IdempotencyKey() idempotencyKey: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { refund, created } = await this.refunds.create(orderId, dto, idempotencyKey);
    res.status(created ? 201 : 200);
    return presentRefund(refund);
  }

  @Get(':orderId/refunds/:refundId')
  async findRefund(@Param('orderId') orderId: string, @Param('refundId') refundId: string) {
    return presentRefund(await this.refunds.findOne(orderId, refundId));
  }

  private get env(): string {
    return this.config.get('CASHFREE_ENV');
  }
}
