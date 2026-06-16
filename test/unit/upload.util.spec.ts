import { BadRequestException } from '@nestjs/common';
import {
  ALLOWED_IMAGE_EXTENSIONS,
  ALLOWED_IMAGE_MIME_TYPES,
  MAX_UPLOAD_SIZE_BYTES,
  imageFileFilter,
  isAllowedImage,
  normalizeUploadFilename,
} from '../../src/modules/upload/upload.util';

describe('upload.util', () => {
  describe('constants', () => {
    it('caps uploads at 10 MB', () => {
      expect(MAX_UPLOAD_SIZE_BYTES).toBe(10 * 1024 * 1024);
    });

    it('allows only jpg/jpeg/png/webp', () => {
      expect(ALLOWED_IMAGE_EXTENSIONS).toEqual(['.jpg', '.jpeg', '.png', '.webp']);
      expect(ALLOWED_IMAGE_MIME_TYPES).toEqual(['image/jpeg', 'image/png', 'image/webp']);
    });
  });

  describe('isAllowedImage', () => {
    it.each([
      ['image/jpeg', 'photo.jpg'],
      ['image/jpeg', 'photo.jpeg'],
      ['image/png', 'photo.png'],
      ['image/webp', 'photo.webp'],
      ['IMAGE/PNG', 'PHOTO.PNG'],
    ])('accepts %s / %s', (mime, name) => {
      expect(isAllowedImage(mime, name)).toBe(true);
    });

    it.each([
      ['image/gif', 'photo.gif'],
      ['application/pdf', 'doc.pdf'],
      ['application/octet-stream', 'malware.exe'],
      ['image/svg+xml', 'icon.svg'],
      ['image/png', 'photo.php'],
      ['image/jpeg', 'noextension'],
    ])('rejects %s / %s', (mime, name) => {
      expect(isAllowedImage(mime, name)).toBe(false);
    });

    it('rejects a spoofed mime type that does not match the extension', () => {
      expect(isAllowedImage('image/png', 'payload.exe')).toBe(false);
    });
  });

  describe('imageFileFilter', () => {
    it('accepts an allowed image', () => {
      const cb = jest.fn();
      imageFileFilter({}, { mimetype: 'image/png', originalname: 'a.png' }, cb);
      expect(cb).toHaveBeenCalledWith(null, true);
    });

    it('rejects a disallowed file with a BadRequestException', () => {
      const cb = jest.fn();
      imageFileFilter({}, { mimetype: 'application/pdf', originalname: 'a.pdf' }, cb);
      const [error, accepted] = cb.mock.calls[0];
      expect(error).toBeInstanceOf(BadRequestException);
      expect(accepted).toBe(false);
    });
  });

  describe('normalizeUploadFilename', () => {
    it('preserves a lowercased allowed extension', () => {
      expect(normalizeUploadFilename('Vacation.JPG')).toMatch(/^\d+-[0-9a-f]{16}\.jpg$/);
    });

    it('discards the original basename (no user-controlled name leakage)', () => {
      const result = normalizeUploadFilename('../../etc/passwd.png');
      expect(result).not.toContain('passwd');
      expect(result).not.toContain('/');
      expect(result).not.toContain('..');
      expect(result).toMatch(/^\d+-[0-9a-f]{16}\.png$/);
    });

    it('produces unique names across calls', () => {
      const names = new Set(
        Array.from({ length: 50 }, () => normalizeUploadFilename('x.webp')),
      );
      expect(names.size).toBe(50);
    });
  });
});
