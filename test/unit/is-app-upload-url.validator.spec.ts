import { isAppUploadUrl } from '../../src/modules/payments/application/validators/is-app-upload-url.validator';

describe('isAppUploadUrl', () => {
  const OLD = process.env.APP_URL;
  afterEach(() => {
    if (OLD === undefined) delete process.env.APP_URL;
    else process.env.APP_URL = OLD;
  });

  it('accepts a root-relative app upload path', () => {
    expect(isAppUploadUrl('/uploads/1700-abcdef0123456789.png')).toBe(true);
    expect(isAppUploadUrl('/uploads/photo.jpeg')).toBe(true);
    expect(isAppUploadUrl('/uploads/photo.webp')).toBe(true);
  });

  it('accepts an absolute URL on the configured APP_URL host', () => {
    process.env.APP_URL = 'https://shop.example.com';
    expect(isAppUploadUrl('https://shop.example.com/uploads/x.png')).toBe(true);
  });

  it('rejects an absolute URL on a different host', () => {
    process.env.APP_URL = 'https://shop.example.com';
    expect(isAppUploadUrl('https://evil.example.com/uploads/x.png')).toBe(false);
  });

  it('rejects arbitrary / external / dangerous URLs and non-image paths', () => {
    expect(isAppUploadUrl('https://evil.com/phish')).toBe(false);
    expect(isAppUploadUrl('javascript:alert(1)')).toBe(false);
    expect(isAppUploadUrl('/uploads/../../etc/passwd')).toBe(false);
    expect(isAppUploadUrl('/uploads/script.svg')).toBe(false);
    expect(isAppUploadUrl('/files/x.png')).toBe(false);
    expect(isAppUploadUrl('')).toBe(false);
    expect(isAppUploadUrl(undefined)).toBe(false);
  });
});
