import { cloneProductDetailDesign, isProductDetailDesignValue } from '../../../common/productDetailDesign';
import { categoryImage } from '../../../common/categoryCatalog';
import { sanitizeArticleRichText } from '../../../common/articleRichText';
import { quoteMoney } from '../../../common/checkoutQuote';
import type {ProductReviewListItem,DetailDesignData,ActivityDetailProjection} from '../types/productDetailDesign';
export type {DetailDesignData,DetailCard,DetailCommunity,ActivityDetailProjection} from '../types/productDetailDesign';
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('商品展示资料格式错误');
  return value as Record<string, unknown>;
};
function text(value: unknown, max: number, empty = '', multiline = false): string {
  if (value === undefined || value === null) return empty;
  if (typeof value !== 'string' || [...value].length > max || (multiline ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u : /[\u0000-\u001f\u007f]/u).test(value)) throw Error('商品展示文字无效');
  return value;
}
function integer(value: unknown, max = 2147483647): number {
  if (value === undefined || value === null) return 0;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > max) throw Error('商品展示数量无效');
  return value;
}
function rows(value: unknown, max: number): Record<string, unknown>[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > max) throw Error('商品展示列表无效');
  return value.map(record);
}
function media(value: unknown): string { const source = text(value, 8192); return source ? categoryImage(source) : ''; }
export function productVideo(value: unknown): string {
  const source = text(value, 8192); if (!source) return '';
  if (/\s|[\\\u0000-\u001f\u007f]/u.test(source) || source.startsWith('//')) return '';
  try { const url = new URL(source, 'https://local.invalid');
    if (url.username || url.password || !/^\/(?!\/)/u.test(url.pathname) || !['https:', 'http:'].includes(url.protocol)) return '';
    return /^\/(?!\/)/u.test(source) || /^https:\/\//iu.test(source) ? source : '';
  } catch { return ''; }
}
/** Same snapshot as the product/SKU; settings never become a price or purchase permission. */
export function parseProductDetailDesignData(value: unknown): DetailDesignData {
  const raw = record(value), projected = raw.product_detail_design;
  let design = cloneProductDetailDesign(), configured = false, issues = ['product_detail_design_missing'];
  if (projected !== undefined) {
    const snapshot = record(projected);
    if (!isProductDetailDesignValue(snapshot.value) || typeof snapshot.configured !== 'boolean' || !Array.isArray(snapshot.issues)
      || snapshot.issues.length > 30 || snapshot.issues.some(item => typeof item !== 'string' || item.length > 255 || /[\u0000-\u001f\u007f]/u.test(item))) throw Error('商品详情布局资料无效');
    design = cloneProductDetailDesign(snapshot.value); configured = snapshot.configured; issues = [...snapshot.issues as string[]];
  }
  const description = raw.description ?? '';
  if (typeof description !== 'string' || description.length > 2 * 1024 * 1024) throw Error('商品正文超出可展示范围');
  const hint=raw.display_price===undefined?null:record(raw.display_price);
  if(hint&&(typeof hint.enabled!=='boolean'||!['','level','member'].includes(String(hint.price_type))))throw Error('会员展示资料无效');
  const optionalMoney=(value:unknown)=>value===undefined||value===null||value===''?'':quoteMoney(value);
  return { design, configured, issues, description: sanitizeArticleRichText(description), video: productVideo(raw.video_link ?? raw.videoLink),
    ensure: rows(raw.ensure, 1000).map(row => ({ id: integer(row.id), name: text(row.name, 255), image: media(row.image), desc: text(row.desc, 10000, '', true) })),
    specs: rows(raw.specs, 100).map(row => ({ name: text(row.name, 255), value: text(row.value, 255) })),
    rank: integer(raw.rank), rankType: integer(raw.rank_type ?? raw.rankType, 3), rankName: text(raw.rank_name ?? raw.rankName, 255),
    recommend: rows(raw.recommend, 24).map(row => ({ id: integer(row.id), name: text(row.store_name ?? row.storeName, 256), image: media(row.image), price: quoteMoney(row.price) })),
    community: rows(raw.elegant_list, 10).map(row => ({ id: integer(row.id), title: text(row.title, 255), image: media(row.image), contentType: integer(row.content_type ?? row.contentType, 2) })),
    communityCount: integer(raw.elegant_count), siteUrl: text(raw.site_url ?? raw.siteUrl, 255), siteName: text(raw.site_name ?? raw.siteName, 255),
    shareQrcode: integer(raw.share_qrcode ?? raw.shareQrcode, 1) as 0 | 1, posterTitle: text(raw.product_poster_title ?? raw.productPosterTitle, 255), contactType: integer(raw.routine_contact_type ?? raw.routineContactType, 10),
    replies:parseDetailReplies(raw.reply??[],integer(raw.id)),replyCount:integer(raw.replyCount),replyChance:integer(raw.replyChance,100),
    memberDisplay:{enabled:hint?.enabled===true,price:hint?quoteMoney(hint.price):'',priceType:(hint?.price_type??'') as ''|'level'|'member',levelName:text(hint?.level_name,255),vipPrice:optionalMoney(hint?.vip_price),levelPrice:optionalMoney(hint?.level_price)} };
}
export function parseDetailReplies(value:unknown,productId:number):ProductReviewListItem[]{return rows(value,10).map(row=>{
  if(integer(row.product_id)!==productId)throw Error('商品评价归属不一致');
  const pics=row.pics??[];if(!Array.isArray(pics)||pics.length>50)throw Error('评价图片无效');
  return{id:integer(row.id),product_id:productId,uid:integer(row.uid),nickname:text(row.nickname,255),avatar:media(row.avatar),comment:text(row.comment,10000,'',true),
    suk:text(row.suk,255),sku:text(row.sku??row.suk,255),product_score:integer(row.product_score,5),service_score:integer(row.service_score,5),delivery_score:integer(row.delivery_score,5),star:integer(row.star,5),pics:pics.map(media).filter(Boolean),
    merchant_reply:text(row.merchant_reply,10000,'',true),merchant_reply_content:text(row.merchant_reply_content,10000,'',true),merchant_reply_time:text(row.merchant_reply_time,255),add_time:typeof row.add_time==='number'?String(row.add_time):text(row.add_time,255),praise:integer(row.praise),is_praise:row.is_praise===true||row.is_praise===1};
});}
export function parseProductMarketingData(value:unknown){const raw=record(value);
  return{coupons:rows(raw.coupons,100).map(row=>({id:integer(row.id),title:text(row.coupon_title,255),price:quoteMoney(row.coupon_price),minimum:quoteMoney(row.use_min_price)})),
    promotions:rows(raw.promotions,100).map(row=>({id:integer(row.id),name:text(row.name??row.title,255),desc:text(row.desc,10000,'',true)}))};
}
export function parseProductCommunityData(value:unknown,limit=10){const raw=record(value);
  return{list:rows(raw.list,limit).map(row=>({id:integer(row.id),title:text(row.title,255),image:media(row.image),contentType:integer(row.content_type,2)})),count:integer(raw.count)};
}
export function parseActivityDetailProjection(value:unknown,productId:number,content?:Record<string,unknown>,galleryLimit=20):ActivityDetailProjection{
  const raw=record(value),images=raw.images??content?.images??[];
  if(!Array.isArray(images)||images.length>galleryLimit)throw Error('活动详情图库无效');
  return{data:parseProductDetailDesignData({...raw,...content,id:productId}),images:images.map(media).filter(Boolean)};
}
/** Provider-owned images, never an arbitrary server URL or a fabricated fallback code. */
export function productShareCode(value:unknown,kind:'wechat'|'routine'):string{
  if(typeof value!=='string')throw Error('商品分享码格式错误');
  if(kind==='routine'){
    if(value.length>1500000||!/^data:image\/(?:png;base64,iVBORw0KGgo|jpeg;base64,\/9j\/)[A-Za-z0-9+/]*={0,2}$/u.test(value))throw Error('微信小程序码格式错误');
    return value;
  }
  if(value.length>8192||/[\s\\\u0000-\u001f\u007f]/u.test(value))throw Error('公众号分享码地址无效');
  const address=new URL(value);
  if(address.origin!=='https://mp.weixin.qq.com'||address.pathname!=='/cgi-bin/showqrcode'||address.hash||address.username||address.password||address.searchParams.size!==1||address.searchParams.getAll('ticket').length!==1||!address.searchParams.get('ticket'))throw Error('公众号分享码地址无效');
  return value;
}
