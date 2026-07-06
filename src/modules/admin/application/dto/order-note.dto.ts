import { IsString, MaxLength, MinLength } from 'class-validator';

export class CreateOrderNoteDto {
  @IsString()
  @MinLength(1)
  @MaxLength(5000)
  body!: string;
}

export class UpdateOrderNoteDto {
  @IsString()
  @MinLength(1)
  @MaxLength(5000)
  body!: string;
}
