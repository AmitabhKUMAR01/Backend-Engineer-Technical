import { Type } from 'class-transformer';
import {
  IsEmail,
  IsIn,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  IsUrl,
  Length,
  Matches,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

const REFERENCE = /^[A-Za-z0-9_\-./:]+$/;

export class CustomerDto {
  @IsOptional()
  @IsString()
  @Length(1, 100)
  name?: string;

  @IsOptional()
  @IsEmail()
  email?: string;

  /** Required by Cashfree. 10-15 digits, optional leading +. */
  @Matches(/^\+?[0-9]{10,15}$/, { message: 'phone must be 10-15 digits' })
  phone: string;
}

export class CreatePaymentOrderDto {
  /** Student identifier in the ERP. */
  @IsString()
  @Length(1, 64)
  @Matches(REFERENCE)
  studentId: string;

  /** ERP fee invoice / demand id that this payment settles. One open order per reference. */
  @IsString()
  @Length(1, 64)
  @Matches(REFERENCE)
  feeReference: string;

  /** e.g. TUITION_FEE, HOSTEL_FEE, EXAM_FEE */
  @IsString()
  @Length(1, 64)
  purpose: string;

  /** Amount in major units (rupees), max 2 decimals. Must come from the ERP, never from the browser. */
  @IsNumber({ maxDecimalPlaces: 2, allowNaN: false, allowInfinity: false })
  @Min(1)
  @Max(10_000_000)
  amount: number;

  @IsOptional()
  @IsIn(['INR'])
  currency: string = 'INR';

  @ValidateNested()
  @Type(() => CustomerDto)
  customer: CustomerDto;

  /** Where to send the browser after payment. Must be on an allow-listed origin. */
  @IsOptional()
  @IsUrl({ require_tld: false, protocols: ['http', 'https'], require_protocol: true })
  returnUrl?: string;

  /** Free-form ERP context stored with the order (semester, installment, ...). */
  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;
}
