import { IsNotEmpty, IsNumber, IsPositive, IsString, IsUUID, Max, MaxLength } from 'class-validator';

export class CreateOrderDto {
  @IsUUID()
  userId: string;

  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  @Max(1_000_000)
  amount: number;

  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  description: string;
}
