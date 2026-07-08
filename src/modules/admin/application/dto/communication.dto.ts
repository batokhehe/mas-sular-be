import { NotificationChannel } from '@prisma/client';
import { IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { MANUAL_TEMPLATES, ManualTemplate } from '../../../../infrastructure/notifications/notification-message';

const MANUAL_CHANNELS = [NotificationChannel.EMAIL, NotificationChannel.WHATSAPP] as const;

/** Render-only preview of a manual message (no outbox row is created). */
export class PreviewCommunicationDto {
  @IsIn(MANUAL_CHANNELS) channel!: NotificationChannel;

  @IsIn(MANUAL_TEMPLATES) template!: ManualTemplate;

  @IsString() @MinLength(1) @MaxLength(1000) message!: string;

  @IsOptional() @IsString() @MaxLength(120) customerName?: string;

  @IsOptional() @IsString() @MaxLength(40) orderNumber?: string;

  @IsOptional() @IsString() @MaxLength(150) subject?: string;
}

/** Manual send — queues ONE NotificationOutbox row for the existing sender worker. */
export class SendCommunicationDto extends PreviewCommunicationDto {
  @IsString() @MinLength(3) @MaxLength(255) recipient!: string;

  @IsOptional() @IsString() @MaxLength(36) customerId?: string;

  @IsOptional() @IsString() @MaxLength(36) orderId?: string;
}
