import { BadRequestException } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { extname } from 'path';

export const ALLOWED_IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp'];
export const ALLOWED_IMAGE_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
export const MAX_UPLOAD_SIZE_BYTES = 10 * 1024 * 1024;

export function isAllowedImage(mimetype: string, originalName: string): boolean {
  const ext = extname(originalName).toLowerCase();
  return (
    ALLOWED_IMAGE_MIME_TYPES.includes(mimetype.toLowerCase()) &&
    ALLOWED_IMAGE_EXTENSIONS.includes(ext)
  );
}

type MulterFile = { mimetype: string; originalname: string };
type FileFilterCallback = (error: Error | null, acceptFile: boolean) => void;

export function imageFileFilter(
  _req: unknown,
  file: MulterFile,
  cb: FileFilterCallback,
): void {
  if (isAllowedImage(file.mimetype, file.originalname)) {
    cb(null, true);
    return;
  }
  cb(new BadRequestException('Only jpg, jpeg, png, and webp images are allowed'), false);
}

export function normalizeUploadFilename(originalName: string): string {
  const ext = extname(originalName).toLowerCase();
  const unique = `${Date.now()}-${randomBytes(8).toString('hex')}`;
  return `${unique}${ext}`;
}
