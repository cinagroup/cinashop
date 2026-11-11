import { describe, expect, it } from 'vitest';
import { normalizeOutProductListFilters } from '../src/services/out/OutProductListFilters';

describe('authenticated Out product list filters', () => {
  it('keeps PHP defaults distinct from anonymous storefront defaults', () => {
    expect(normalizeOutProductListFilters({})).toMatchObject({ outStatus: 1, outVip: undefined,
      outPresale: undefined, outNew: false, outNotLive: false, page: 1, limit: 20 });
    expect(normalizeOutProductListFilters({type:'', is_vip_product:'-1', is_presale_product:'0', is_new:'1', is_live:'1',
      cate_id:'9', store_label_id:'5,6,5', brand_id:'3,3', page:'2', limit:'150'})).toMatchObject({
        outStatus: undefined, outVip: -1, outPresale: 0, outNew: true, outNotLive: true,
        outCategoryId: 9, outStoreLabelIds: [5,6], brand_id:'3', page:2, limit:100 });
  });
  it.each([
    { is_vip_product:'2' }, { is_presale_product:'-1' }, { is_live:'bad' }, { is_new:'2' }, { type:'8' },
    { cate_id:'2.5' }, { store_label_id:'1,wat' }, { store_label_id:'1,,2' }, { page:'-1' }, { limit:'NaN' },
  ])('rejects malformed filters instead of broadening the result: %j', query => {
    expect(() => normalizeOutProductListFilters(query)).toThrow();
  });
});
