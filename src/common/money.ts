import { Prisma } from '@prisma/client';

/** Money is handled as integer minor units (paise) in code and DECIMAL(12,2) in the DB. Never floats. */
export function toPaise(value: Prisma.Decimal | number | string): number {
  return new Prisma.Decimal(value).mul(100).toDecimalPlaces(0).toNumber();
}

export function paiseToDecimal(paise: number): Prisma.Decimal {
  return new Prisma.Decimal(paise).div(100);
}

/** Cashfree expects a JSON number with at most 2 decimals. */
export function toGatewayAmount(value: Prisma.Decimal): number {
  return Number(value.toFixed(2));
}

export function formatAmount(value: Prisma.Decimal): string {
  return value.toFixed(2);
}
