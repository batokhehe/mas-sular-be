import {
  paxelCancelSignature,
  paxelCreateSignature,
  paxelWebhookSignature,
} from '../../src/modules/shipment/infrastructure/providers/paxel-signature';

/**
 * Paxel signature vectors.
 *
 * Every expected digest below is the one Paxel publishes in the
 * `X-Paxel-Signature` header documentation of its Postman collection, alongside
 * the exact inputs that produce it. They are the only proof that our reading of
 * the formulas is right — the three are similar enough to transpose by accident
 * (create takes the FIRST two characters of four fields; cancel and webhook take
 * the LAST six of the airwaybill plus the first two of one other field).
 *
 * The secret used here is Paxel's own documentation placeholder, not a real one.
 */

const DOC_SECRET = 'GK8BGUE0B2';

describe('Paxel signatures — documented vectors', () => {
  it('create matches the collection example', () => {
    expect(
      paxelCreateSignature(
        {
          invoiceNumber: 'A8HGK893J8',
          originName: 'Jhon Doe',
          destinationName: 'Jhon Lenon',
          firstItemName: 'Samsung Galaxy S9',
        },
        DOC_SECRET,
      ),
    ).toBe('8dc40976acaf29f423aa60c2ea9e2b826a5c7f804dc74b1ff116a8bfbddd7ef9');
  });

  it('create matches the second (PAXELBIG) collection example', () => {
    expect(
      paxelCreateSignature(
        {
          invoiceNumber: 'HVS-ECOM0000400779',
          originName: 'Jhon Pantau',
          destinationName: 'John Travolta',
          firstItemName: 'Samsung Galaxy S10',
        },
        DOC_SECRET,
      ),
    ).toBe('10ac24d2915d5c3846d3b01f4c932d7e02cddcd146b39f0f73dfbebdbee09351');
  });

  it('cancel matches the collection example', () => {
    expect(
      paxelCancelSignature('EM.3BM5H5WOBN-20180413-8-X8H3YN', 'penjual kehabisan stok', DOC_SECRET),
    ).toBe('cb87694b606df7178d91aa4c9891e3d3d91a85278e9ea431a352425ddcbd6529');
  });

  it('webhook uses the same shape as cancel, over latest_status', () => {
    // The collection documents the formula for webhooks without publishing a
    // digest, so this pins the shape against cancel, whose digest IS published:
    // identical inputs must produce identical output.
    const awb = 'EM.3BM5H5WOBN-20180413-8-X8H3YN';
    expect(paxelWebhookSignature(awb, 'penjual kehabisan stok', DOC_SECRET)).toBe(
      paxelCancelSignature(awb, 'penjual kehabisan stok', DOC_SECRET),
    );
    expect(paxelWebhookSignature(awb, 'Delivered', DOC_SECRET)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('Paxel signatures — substring discipline', () => {
  it('create reads only the first two characters of each field', () => {
    const a = paxelCreateSignature(
      { invoiceNumber: 'A8XXXX', originName: 'JhXXXX', destinationName: 'JhXXXX', firstItemName: 'SaXXXX' },
      DOC_SECRET,
    );
    const b = paxelCreateSignature(
      { invoiceNumber: 'A8YYYY', originName: 'JhYYYY', destinationName: 'JhYYYY', firstItemName: 'SaYYYY' },
      DOC_SECRET,
    );
    expect(a).toBe(b);
  });

  it('cancel reads the LAST six characters of the airwaybill, not the first', () => {
    const tail = paxelCancelSignature('AAAAAA-X8H3YN', 'penjual', DOC_SECRET);
    const same = paxelCancelSignature('ZZZZZZ-X8H3YN', 'penjual', DOC_SECRET);
    const different = paxelCancelSignature('X8H3YN-AAAAAA', 'penjual', DOC_SECRET);
    expect(tail).toBe(same);
    expect(tail).not.toBe(different);
  });

  it('inputs are used verbatim — no trimming or case folding', () => {
    expect(paxelCancelSignature('AWBX8H3YN', ' penjual', DOC_SECRET)).not.toBe(
      paxelCancelSignature('AWBX8H3YN', 'penjual', DOC_SECRET),
    );
    expect(paxelCancelSignature('AWBX8H3YN', 'Penjual', DOC_SECRET)).not.toBe(
      paxelCancelSignature('AWBX8H3YN', 'penjual', DOC_SECRET),
    );
  });

  it('a different secret produces a different digest', () => {
    const awb = 'EM.3BM5H5WOBN-20180413-8-X8H3YN';
    expect(paxelCancelSignature(awb, 'penjual kehabisan stok', 'OTHER-SECRET')).not.toBe(
      'cb87694b606df7178d91aa4c9891e3d3d91a85278e9ea431a352425ddcbd6529',
    );
  });
});

describe('Paxel signatures — secret containment', () => {
  it('returns a bare hex digest that cannot leak the secret', () => {
    const secret = 'super-synthetic-secret-value';
    const digest = paxelCancelSignature('AWB-123456', 'reason', secret);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(digest).not.toContain(secret);
  });
});
