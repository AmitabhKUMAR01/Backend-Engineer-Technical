import { IsNumber, IsOptional, IsString, Length, Max, Min } from 'class-validator';

export class CreateRefundDto {
  /** Refund amount in major units (rupees), max 2 decimals. Partial refunds are allowed. */
  @IsNumber({ maxDecimalPlaces: 2, allowNaN: false, allowInfinity: false })
  @Min(1)
  @Max(10_000_000)
  amount: number;

  @IsOptional()
  @IsString()
  @Length(3, 100)
  reason?: string;
}
