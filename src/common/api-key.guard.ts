import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Request } from 'express';
import { AppConfig } from '../config/app-config.service';
import { safeEqual } from './crypto';

/** Service-to-service auth for the ERP backend. Browsers must never hold this key. */
@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(private readonly config: AppConfig) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const provided = request.header('x-api-key');
    if (provided && this.config.get('API_KEYS').some((key) => safeEqual(key, provided))) {
      return true;
    }
    throw new UnauthorizedException('Invalid or missing API key');
  }
}
