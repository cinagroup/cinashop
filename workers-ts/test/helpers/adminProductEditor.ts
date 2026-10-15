import { legacySaveSku } from './adminLegacyProductSave';
/** Independent complete editor submission, including intentional empty sets. */
export function editorProduct(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    product_type: 0, supplier_id: 0, cate_id: [1], store_name: '完整编辑器商品', store_info: '简介', keyword: '关键字', unit_name: '件',
    recommend_image: '', slider_image: ['/uploads/main.png'], is_sub: [], sort: 0, ficti: 0, give_integral: 0,
    is_show: 0, is_hot: 0, is_benefit: 0, is_best: 0, is_new: 0, mer_use: 0, is_postage: 0, is_good: 0,
    description: '<p>完整商品详情</p>', spec_type: 0, video_open: false, video_link: '', items: [], attrs: [legacySaveSku()],
    recommend: [], activity: ['默认','秒杀','砍价','拼团'], coupon_ids: [], label_id: [], command_word: '', tao_words: '', type: 0,
    delivery_type: ['1'], freight: 1, postage: 0, temp_id: 0, recommend_list: [], brand_id: [], soure_link: '', bar_code: '', code: '',
    is_support_refund: 1, is_presale_product: 0, presale_time: [], presale_day: 0, is_vip_product: 0,
    auto_on_time: '', auto_off_time: '', custom_form: [], system_form_id: 0, store_label_id: [], ensure_id: [], specs: [], specs_id: 0,
    is_limit: false, limit_type: 0, limit_num: 0, ...overrides,
  };
}
