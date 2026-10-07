import { Controller, Headers, HttpCode, Post, RawBodyRequest, Req } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { WebhooksService } from './webhooks.service';

/** Public endpoint called by Cashfree. Authenticated by HMAC signature, not API key. */
@ApiTags('webhooks')
@Controller('api/v1/webhooks')
export class WebhooksController {
  constructor(private readonly webhooks: WebhooksService) {}

  @Post('cashfree')
  @HttpCode(200)
  receive(@Req() req: RawBodyRequest<Request>, @Headers() headers: Record<string, string | undefined>) {
    return this.webhooks.receive(req.rawBody, headers);
  }
}
