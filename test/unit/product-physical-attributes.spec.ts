import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { CreateProductDto } from '../../src/modules/admin/application/dto/create-product.dto';
import { UpdateProductDto } from '../../src/modules/admin/application/dto/update-product.dto';
import { assertShippingConfigured, isPaxelPhone, loadShippingConfig } from '../../src/modules/shipping/shipping.config';

/**
 * Physical product attributes (PAXEL-B2a).
 *
 * Paxel's shipment CREATE requires per-item weight and dimensions, and validates
 * them server-side: weight 1-5000 g, each side 1-50 cm. Catching an out-of-range
 * value when a product is edited is worth far more than catching it at booking,
 * which happens asynchronously after the customer has already paid.
 *
 * All five fields stay OPTIONAL: the catalogue predates them, and forcing them
 * now would break every existing product edit. The rule is "null is fine, wrong
 * is not".
 */

function errorsFor(dto: object, cls: typeof CreateProductDto | typeof UpdateProductDto) {
  return validateSync(plainToInstance(cls, dto) as object, { whitelist: false });
}

function propertiesWithErrors(dto: object, cls: typeof CreateProductDto | typeof UpdateProductDto): string[] {
  return errorsFor(dto, cls).map((e) => e.property);
}

const VALID_CREATE = {
  slug: 'baso-urat',
  sku: 'SKU-001',
  name: 'Baso Urat',
  description: 'enak',
  price: 45000,
  imageUrl: 'https://example.test/a.png',
  status: 'ACTIVE',
  stock: 10,
  categoryId: 'cat-1',
};

describe('Product physical attributes — validation', () => {
  it('accepts a product with no physical data at all (legacy catalogue)', () => {
    expect(propertiesWithErrors(VALID_CREATE, CreateProductDto)).toEqual([]);
  });

  it('accepts values inside the Paxel bounds', () => {
    const dto = { ...VALID_CREATE, weightGram: 500, lengthCm: 30, widthCm: 20, heightCm: 10, isFragile: true };
    expect(propertiesWithErrors(dto, CreateProductDto)).toEqual([]);
  });

  it('accepts the exact boundary values', () => {
    const low = { ...VALID_CREATE, weightGram: 1, lengthCm: 1, widthCm: 1, heightCm: 1 };
    const high = { ...VALID_CREATE, weightGram: 5000, lengthCm: 50, widthCm: 50, heightCm: 50 };
    expect(propertiesWithErrors(low, CreateProductDto)).toEqual([]);
    expect(propertiesWithErrors(high, CreateProductDto)).toEqual([]);
  });

  it.each([
    ['weightGram', 0],
    ['weightGram', 5001],
    ['weightGram', -1],
  ])('rejects %s = %p (Paxel allows 1-5000 g)', (field, value) => {
    expect(propertiesWithErrors({ ...VALID_CREATE, [field]: value }, CreateProductDto)).toContain(field);
  });

  it.each([
    ['lengthCm', 0],
    ['lengthCm', 51],
    ['widthCm', 0],
    ['widthCm', 51],
    ['heightCm', 0],
    ['heightCm', 51],
  ])('rejects %s = %p (Paxel allows 1-50 cm)', (field, value) => {
    expect(propertiesWithErrors({ ...VALID_CREATE, [field]: value }, CreateProductDto)).toContain(field);
  });

  it('rejects a non-integer weight rather than coercing it', () => {
    expect(propertiesWithErrors({ ...VALID_CREATE, weightGram: 500.5 }, CreateProductDto)).toContain('weightGram');
  });

  it('rejects a non-boolean isFragile', () => {
    expect(propertiesWithErrors({ ...VALID_CREATE, isFragile: 'yes' }, CreateProductDto)).toContain('isFragile');
  });

  it('applies the same bounds on update, where every field is optional', () => {
    expect(propertiesWithErrors({ weightGram: 500 }, UpdateProductDto)).toEqual([]);
    expect(propertiesWithErrors({}, UpdateProductDto)).toEqual([]);
    expect(propertiesWithErrors({ heightCm: 99 }, UpdateProductDto)).toContain('heightCm');
  });
});

// ==================================================== Paxel origin config ====

function config(env: Record<string, string | undefined>) {
  return loadShippingConfig({ PAXEL_ENABLED: 'true', PAXEL_API_KEY: 'k', PAXEL_API_SECRET: 's', PAXEL_DEFAULT_DIMENSION: '30x35x20', ...env } as NodeJS.ProcessEnv);
}

describe('PAXEL_ORIGIN_PHONE', () => {
  it.each(['081212121212', '123456789', '1234567890123'])('accepts %s', (value) => {
    expect(isPaxelPhone(value)).toBe(true);
  });

  it.each(['', undefined, '12345678', '12345678901234', '+6281212121212', '0812 1212 1212', '0812-1212', 'abcdefghij'])(
    'rejects %p',
    (value) => {
      expect(isPaxelPhone(value as string | undefined)).toBe(false);
    },
  );

  it('fails configuration when Paxel is enabled and the phone is missing', () => {
    expect(() => assertShippingConfigured(config({ PAXEL_ORIGIN_NOTE: 'gerbang samping' }))).toThrow(/PAXEL_ORIGIN_PHONE/);
  });

  it('fails configuration when the phone is present but malformed', () => {
    expect(() =>
      assertShippingConfigured(config({ PAXEL_ORIGIN_PHONE: '+62 812', PAXEL_ORIGIN_NOTE: 'gerbang samping' })),
    ).toThrow(/PAXEL_ORIGIN_PHONE/);
  });
});

describe('PAXEL_ORIGIN_NOTE', () => {
  it('fails configuration when Paxel is enabled and the note is missing', () => {
    expect(() => assertShippingConfigured(config({ PAXEL_ORIGIN_PHONE: '081212121212' }))).toThrow(/PAXEL_ORIGIN_NOTE/);
  });

  it('fails configuration when the note is only whitespace — there is no default', () => {
    expect(() =>
      assertShippingConfigured(config({ PAXEL_ORIGIN_PHONE: '081212121212', PAXEL_ORIGIN_NOTE: '   ' })),
    ).toThrow(/PAXEL_ORIGIN_NOTE/);
  });

  it('has no default value baked into the loader', () => {
    expect(config({}).paxel.originNote).toBeUndefined();
  });

  it('passes configuration when both are supplied', () => {
    expect(() =>
      assertShippingConfigured(config({ PAXEL_ORIGIN_PHONE: '081212121212', PAXEL_ORIGIN_NOTE: 'gerbang samping' })),
    ).not.toThrow();
  });
});

describe('Paxel disabled', () => {
  it('requires neither the origin phone nor the note', () => {
    const disabled = loadShippingConfig({ PAXEL_ENABLED: 'false', JNE_ENABLED: 'false' } as NodeJS.ProcessEnv);
    expect(() => assertShippingConfigured(disabled)).not.toThrow();
    expect(disabled.paxel.originPhone).toBeUndefined();
    expect(disabled.paxel.originNote).toBeUndefined();
  });
});
