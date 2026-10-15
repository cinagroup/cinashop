/** Mirrors the pinned old infoData/submit consumer transformations, not a new
 * endpoint wire contract. Tests keep whole-DTO echo fields to catch data loss. */
export function oldEditorSaveBody(info: Record<string, unknown>): Record<string, unknown> {
  const ids = (value: unknown) => (value as Array<{ id: number }>).map(row => row.id);
  return { ...info, id: info.id, type: 0, supplier_id: info.product_type === 0 ? info.relation_id : 0,
    cate_id: (info.cate_id as string[]).map(Number), brand_id: (info.brand_id as number[]).map(String),
    label_id: ids(info.label_id), store_label_id: ids(info.store_label_id), coupon_ids: ids(info.coupons),
    recommend_list: (info.recommend_list as Array<{ product_id: string }>).map(row => row.product_id),
    is_limit: info.is_limit ? 1 : 0, video_open: info.video_open ? 1 : 0,
    items: info.items, attrs: info.spec_type === 0 ? [info.attr] : info.attrs,
  };
}
