import { describe, expect, it } from 'vitest';
import { purchasedLabelSelection } from '../src/services/order/PurchasedProductLabelSelection';
const platform = { id: 31, type: 0, relationId: 0, status: 1 };
const store = { id: 32, type: 1, relationId: 5, status: 1 };
describe('actual purchased label ownership', () => {
  it('keeps platform labels platform-wide even for a financial store order', () => {
    for (const financial of [0, 5]) expect(purchasedLabelSelection([31], [platform], financial).targets)
      .toEqual([{ labelId: 31, type: 0, relationId: 0 }]);
  });
  it('grants matching store labels alongside platform labels without merging the scopes', () => {
    expect(purchasedLabelSelection([32, 31], [store, platform], 5)).toEqual({
      targets: [{ labelId: 31, type: 0, relationId: 0 }, { labelId: 32, type: 1, relationId: 5 }], skipped: [] });
  });
  it('requires maintenance for a foreign store, platform order or unsupported Supplier label scope', () => {
    for (const [label, financial] of [[store, 0], [store, 6], [{ ...store, type: 2 }, 5],
      [{ ...platform, relationId: 5 }, 5], [{ ...store, relationId: 0 }, 5]] as const)
      expect(() => purchasedLabelSelection([label.id], [label], financial)).toThrow('归属');
  });
  it('records missing or deliberately retired labels without recreating them or removing existing membership', () => {
    expect(purchasedLabelSelection([33, 31, 32], [platform, { ...store, status: 0 }], 0)).toEqual({
      targets: [{ labelId: 31, type: 0, relationId: 0 }], skipped: [{ labelId: 32, reason: 'retired' }, { labelId: 33, reason: 'missing' }] });
  });
  it('refuses duplicate, oversized and noncanonical sets or ambiguous catalog results', () => {
    for (const run of [() => purchasedLabelSelection([31, 31], [platform], 0),
      () => purchasedLabelSelection([0], [], 0), () => purchasedLabelSelection([31], [platform, platform], 0),
      () => purchasedLabelSelection([31], [{ ...platform, id: 99 }], 0),
      () => purchasedLabelSelection([31], [{ ...platform, status: 2 }], 0),
      () => purchasedLabelSelection([31], [platform], -1),
      () => purchasedLabelSelection(Array(10001).fill(31), [], 0)]) expect(run).toThrow('维护');
  });
});
