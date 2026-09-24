import { describe, expect, it, vi } from 'vitest';
import { readOrderSystemFormForOrder } from '../src/services/order/OrderSystemFormService';

const base = { id: 1, uid: 0, staffId: 1, isChannel: 2, unique: 'a'.repeat(32), pid: 0, customForm: '[]' };
const proof = { version: 1, adminId: 1, uid: 0, key: base.unique, systemFormId: 77, digest: 'A'.repeat(43) };
const json = (scope: unknown = proof, values: unknown[] = ['/api/assets/42']) => JSON.stringify([
  { name: 'texts', value: 'Local text', assistedImageScope: 'not-public' },
  { name: 'uploadPicture', value: values, assistedImageScope: scope },
]);
const unexpected = { select: () => { throw Error('Unexpected SQL'); } } as never;

describe('bounded assisted order-form reads', () => {
  it.each([undefined, null, {}, { ...proof, version: 2 }, { ...proof, uid: 11 }, { ...proof, adminId: 2 },
    { ...proof, key: 'b'.repeat(32) }, { ...proof, systemFormId: 0 }, { ...proof, systemFormId: '77' },
    { ...proof, digest: 'short' }])('removes unproven image evidence without querying a shared UID: %j', async scope => {
    const signer = { signReferences: vi.fn() };
    const result = await readOrderSystemFormForOrder(unexpected, signer, { ...base, customForm: json(scope === undefined ? false : scope) });
    expect(result).toEqual([{ name: 'texts', value: 'Local text' }, { name: 'uploadPicture', value: [] }]);
    expect(signer.signReferences).not.toHaveBeenCalled();
  });
  it.each(['broken', 'x'.repeat(1_000_001), JSON.stringify([{ name: 'texts', value: '界'.repeat(340_000) }]),
    JSON.stringify(Array.from({ length: 101 }, () => ({ name: 'texts', value: '' }))), json(proof, Array(10).fill('/api/assets/42'))])(
    'rejects malformed or oversized snapshots before SQL (%#)', async customForm => {
      const signer = { signReferences: vi.fn() };
      expect(await readOrderSystemFormForOrder(unexpected, signer, { ...base, customForm })).toEqual([]);
      expect(signer.signReferences).not.toHaveBeenCalled();
    });
  it('never passes URLs or out-of-range IDs to SQL or signing for assisted images', async () => {
    const signer = { signReferences: vi.fn() };
    const result = await readOrderSystemFormForOrder(unexpected, signer, { ...base,
      customForm: json(proof, ['https://example.test/foreign.png', '/api/assets/42?sig=foreign', '/api/assets/2147483648', '/api/assets/9007199254740993']) });
    expect(result[1].value).toEqual([]); expect(signer.signReferences).not.toHaveBeenCalled();
  });
  it('does not turn SQL failure into a successful empty form', async () => {
    await expect(readOrderSystemFormForOrder(unexpected, { signReferences: vi.fn() }, { ...base, customForm: json() })).rejects.toThrow('Unexpected SQL');
  });
  it('keeps ordinary historical HTTPS images while stripping reserved metadata', async () => {
    const result = await readOrderSystemFormForOrder(unexpected, { signReferences: vi.fn() }, { ...base,
      uid: 11, isChannel: 0, customForm: json(proof, ['https://example.test/ordinary.png']) });
    expect(result).toEqual([{ name: 'texts', value: 'Local text' }, { name: 'uploadPicture', value: ['https://example.test/ordinary.png'] }]);
  });
});
