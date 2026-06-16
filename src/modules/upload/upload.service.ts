import { Injectable } from '@nestjs/common';

@Injectable()
export class UploadService {
  getFileUrl(filename: string) {
    const base = process.env.APP_URL;
    // APP_URL is required + URL-validated at startup; guard defensively so we never
    // emit a malformed "undefined/uploads/..." URL if this is ever reached unset.
    if (!base) {
      throw new Error('APP_URL is not configured; cannot build an upload URL');
    }
    return `${base.replace(/\/+$/, '')}/uploads/${filename}`;
  }
}
