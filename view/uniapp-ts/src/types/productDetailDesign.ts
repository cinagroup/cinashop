import type {ProductDetailDesignValue} from '../../../common/productDetailDesign';
/** Pure projection types may be referenced by shared catalogues without loading frontend APIs. */
export interface ProductReviewListItem {
  id:number;product_id:number;uid:number;nickname:string;avatar:string;comment:string;suk:string;sku:string;
  product_score:number;service_score:number;delivery_score:number;star:number;pics:string[];
  merchant_reply:string;merchant_reply_content:string;merchant_reply_time:string;add_time:string;praise:number;is_praise:boolean;
}
export interface DetailCard {id:number;name:string;image:string;price:string}
export interface DetailCommunity {id:number;title:string;image:string;contentType:number}
export interface ActivityDetailProjection {data:DetailDesignData;images:string[]}
export interface DetailDesignData {
  design:ProductDetailDesignValue;configured:boolean;issues:string[];
  description:string;video:string;ensure:Array<{id:number;name:string;image:string;desc:string}>;
  specs:Array<{name:string;value:string}>;rank:number;rankType:number;rankName:string;
  recommend:DetailCard[];community:DetailCommunity[];communityCount:number;
  siteUrl:string;siteName:string;shareQrcode:0|1;posterTitle:string;contactType:number;
  replies:ProductReviewListItem[];replyCount:number;replyChance:number;
  memberDisplay:{enabled:boolean;price:string;priceType:''|'level'|'member';levelName:string;vipPrice:string;levelPrice:string};
}
