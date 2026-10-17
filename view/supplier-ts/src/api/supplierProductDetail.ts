import { apiRequest } from './http';
import { getProductDetail, previewMode, previewProductRows } from './supplier';
import { parseSupplierProductDetail } from '@/utils/productDetail';
import { escapeProductText } from '@/utils/productMedia';
import type { SupplierProductDetailContext } from '@/types/productDetail';

export async function getSupplierProductDetail(context: SupplierProductDetailContext, signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException('读取已取消', 'AbortError');
  if (!previewMode) return parseSupplierProductDetail(await apiRequest<unknown>({ method: 'GET',
    url: `/product/product/${context.productId}/view`, signal }), context);
  const row = previewProductRows().find(row => row.id === context.productId);
  if (!row) throw Error('示例商品不存在');
  const source = await getProductDetail(row.id), first = source.attrs.find(sku => !sku.is_retired);
  return parseSupplierProductDetail({ version: 'supplier-product-detail-v1', actor_id: context.actorId,
    supplier_id: context.supplierId, product_id: row.id, bounded: true,
    product: { product_type: source.product_type, store_name: source.store_name, store_info: source.store_info,
      keyword: source.keyword, unit_name: source.unit_name, bar_code: source.bar_code, image: row.image,
      slider_image: source.slider_image, price: row.price, ot_price: first?.ot_price ?? '0.00', vip_price: first?.vip_price ?? '0.00',
      stock: row.stock, sales: row.sales, spec_type: source.spec_type, freight: source.freight, postage: source.postage,
      temp_id: source.temp_id, is_postage: source.is_postage, is_support_refund: source.is_support_refund,
      is_limit: source.is_limit, limit_type: source.limit_type, limit_num: source.limit_num, is_show: row.is_show,
      is_verify: row.is_verify, refusal: source.refusal ?? '', sort: source.sort, ficti: source.ficti,
      add_time: row.add_time, video_link: '', video_preview_url: '' },
    attributes: source.items.map(item => ({ name: item.value, values: [...item.detail] })),
    skus: source.attrs.filter(sku => !sku.is_retired).map(sku => ({ id: sku.id, suk: sku.suk,
      price: sku.price, ot_price: sku.ot_price, vip_price: sku.vip_price, stock: sku.stock,
      sales: sku.sales ?? 0, image: sku.image, bar_code: sku.bar_code, is_retired: 0 })).sort((a, b) => (a.id ?? 0) - (b.id ?? 0)),
    media: { version: 1, status: 'ready', previews: {}, description_html: `<p>${escapeProductText('示例商品详情，仅供本地预览。')}</p>` },
  }, context);
}
