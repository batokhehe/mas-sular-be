import { BadRequestException, Body, Controller, Get, Param, Post, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { diskStorage } from 'multer';
import { AuthUser, CurrentUser } from '../../../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { imageFileFilter, MAX_UPLOAD_SIZE_BYTES, normalizeUploadFilename } from '../../upload/upload.util';
import { UploadService } from '../../upload/upload.service';
import { UploadManualPaymentDto } from '../application/dto/payment.dto';
import { PaymentsService } from '../payments.service';

// Receipt image upload: reuses the same image-only filter, size limit, and
// normalized-filename storage as the admin uploader.
const RECEIPT_UPLOAD = {
  storage: diskStorage({
    destination: './uploads',
    filename: (_req: unknown, file: { originalname: string }, cb: (e: Error | null, name: string) => void) =>
      cb(null, normalizeUploadFilename(file.originalname)),
  }),
  fileFilter: imageFileFilter,
  limits: { fileSize: MAX_UPLOAD_SIZE_BYTES },
};

@ApiTags('payments')
@Controller({ path: 'payments', version: '1' })
export class PaymentsController {
  constructor(
    private readonly payments: PaymentsService,
    private readonly uploads: UploadService,
  ) {}

  @Post(':paymentId/manual-receipt')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  uploadManualReceipt(
    @Param('paymentId') paymentId: string,
    @CurrentUser() user: AuthUser,
    @Body() dto: UploadManualPaymentDto,
  ) {
    return this.payments.uploadManualReceipt(paymentId, user.sub, dto);
  }

  // Authenticated receipt image upload (login flow). Owner-scoped; returns an
  // application-owned URL that the manual-receipt endpoint will accept.
  @Post(':paymentId/manual-receipt/file')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @UseInterceptors(FileInterceptor('file', RECEIPT_UPLOAD))
  async uploadReceiptFile(
    @Param('paymentId') paymentId: string,
    @CurrentUser() user: AuthUser,
    @UploadedFile() file: Express.Multer.File,
  ) {
    if (!file) throw new BadRequestException('A receipt image file is required');
    await this.payments.assertPaymentOwner(paymentId, user.sub);
    return { url: this.uploads.getFileUrl(file.filename) };
  }

  // Public, unauthenticated upload-link surface. Access is by single-use token
  // (no login, no paymentId in the URL) so customers can pay without an account.
  @Get('upload/:token')
  getUploadPage(@Param('token') token: string) {
    return this.payments.getUploadPage(token);
  }

  // Anonymous receipt image upload, gated by an active token. Returns an
  // application-owned URL for the subsequent submit call.
  @Post('upload/:token/file')
  @UseInterceptors(FileInterceptor('file', RECEIPT_UPLOAD))
  async uploadTokenReceiptFile(@Param('token') token: string, @UploadedFile() file: Express.Multer.File) {
    if (!file) throw new BadRequestException('A receipt image file is required');
    await this.payments.getUploadPage(token); // validates the token is active + payment uploadable
    return { url: this.uploads.getFileUrl(file.filename) };
  }

  @Post('upload/:token')
  submitReceipt(@Param('token') token: string, @Body() dto: UploadManualPaymentDto) {
    return this.payments.submitReceiptByToken(token, dto);
  }

  // NOTE: payment verification is admin-only and lives on the admin surface
  // (PATCH /admin/payments/:paymentId/verify), which binds the verifier to the
  // authenticated admin principal.
}
