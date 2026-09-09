import { describe, expect, it } from 'vitest';
import { bargainEditPayload } from '../../view/admin-ts/src/api/bargainEdit';

const form = { id: 40, productId: 70, storeName: '活动', image: '', price: '10.00', minPrice: '2.00',
  stock: 8, quota: 6, num: 1, people: 2, sort: 90, status: 1,
  startTime: '2026-09-09T00:00:00.000Z', stopTime: '2026-09-10T00:00:00.000Z' };
describe('actual admin bargain form payload', () => {
  it('sends only a rename, never stale inventory/pricing/product/rules', () => {
    expect(bargainEditPayload({ ...form, storeName: '改名' }, form)).toEqual({ type: 'bargain', id: 40, storeName: '改名' });
  });
  it('sends both original inventory values with an explicit stock change', () => {
    expect(bargainEditPayload({ ...form, stock: 10 }, form)).toEqual({ type: 'bargain', id: 40, stock: 10, expected: { stock: 8, quota: 6 } });
  });
  it('sends both original inventory values with an explicit quota change', () => {
    expect(bargainEditPayload({ ...form, quota: 5 }, form)).toEqual({ type: 'bargain', id: 40, quota: 5, expected: { stock: 8, quota: 6 } });
  });
  it('supports no-op and reuses original identity, not a mutated form ID', () => {
    expect(bargainEditPayload({ ...form, id: 99 }, form)).toEqual({ type: 'bargain', id: 40 });
  });
  it('keeps create separate and excludes generic-only or system-owned fields', () => {
    const { id, ...values } = form;
    expect(bargainEditPayload({ ...form, sales: 99, addTime: 0, otPrice: '0' }, null)).toEqual({ type: 'bargain', ...values });
  });
  it('refuses missing original inventory instead of inventing zero', () => {
    expect(() => bargainEditPayload({ ...form, stock: 10 }, { ...form, quota: undefined })).toThrow('库存原值');
  });
  it('compares instants rather than Date object identities and serializes only the changed endpoint', () => {
    expect(bargainEditPayload({ ...form, startTime: new Date(form.startTime), stopTime: new Date('2026-09-11T00:00:00.000Z') }, form))
      .toEqual({ type: 'bargain', id: 40, stopTime: '2026-09-11T00:00:00.000Z' });
  });
  it.each([null, '', '2026-09-09T00:00:00', '2026-02-30T00:00:00.000Z'])('refuses invalid or missing form time %s', startTime => {
    expect(() => bargainEditPayload({ ...form, startTime }, form)).toThrow('时间');
  });
});
