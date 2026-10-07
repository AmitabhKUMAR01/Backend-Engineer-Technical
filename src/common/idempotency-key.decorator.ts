import { BadRequestException, ExecutionContext, createParamDecorator } from '@nestjs/common';
import { Request } from 'express';

const KEY_PATTERN = /^[A-Za-z0-9_\-:.]{8,128}$/;

/** Extracts and validates the mandatory `Idempotency-Key` header. */
export const IdempotencyKey = createParamDecorator((_: unknown, context: ExecutionContext): string => {
  const key = context.switchToHttp().getRequest<Request>().header('idempotency-key');
  if (!key || !KEY_PATTERN.test(key)) {
    throw new BadRequestException(
      'Idempotency-Key header is required (8-128 chars, letters, digits, _ - : .)',
    );
  }
  return key;
});
