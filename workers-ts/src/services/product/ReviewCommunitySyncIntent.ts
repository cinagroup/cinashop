import { eq } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { storeProductReply } from '@/models/schema';
import { checkoutFingerprint } from '@/services/order/CheckoutConfirmation';
import { ValidateException } from '@/utils/errors';

type Reply = typeof storeProductReply.$inferSelect;
export type ReviewSyncPayload = Pick<Reply,'uid'|'oid'|'orderCartInfoId'|'unique'|'productId'|'comment'|'pics'>;
export function reviewSyncRequested(value: unknown): boolean {
  if(value===undefined||value===false||value===0||value==='0')return false;
  if(value===true||value===1||value==='1')return true;
  throw new ValidateException('同步社区选项无效');
}
export function reviewSyncPictures(value: string|null): string[] {
  if(typeof value!=='string'||value.length>20000)throw new ValidateException('同步评价图片资料异常');
  let pics:unknown;try{pics=JSON.parse(value);}catch{throw new ValidateException('同步评价图片资料异常');}
  if(!Array.isArray(pics)||pics.length>9||pics.some(p=>typeof p!=='string'||p.length>2048))throw new ValidateException('同步评价图片资料异常');
  return pics;
}
/** Persisted at the original review insert, never regenerated from edited text. */
export async function reviewSyncDigest(row:ReviewSyncPayload):Promise<string> {
  return checkoutFingerprint({version:'review-community-v1',uid:row.uid,orderId:row.oid,cartInfoId:row.orderCartInfoId,
    unique:row.unique,productId:row.productId,comment:row.comment,pics:reviewSyncPictures(row.pics)});
}
export async function verifyReviewSyncIntent(db:DbClient,id:number,digest:string):Promise<void> {
  const [row]=await db.select().from(storeProductReply).where(eq(storeProductReply.id,id)).limit(1);
  if(!row||row.communitySyncRequested!==1||row.communitySyncPostId!==0||row.communitySyncDigest!==digest
    ||await reviewSyncDigest(row)!==digest)throw new ValidateException('评价同步凭据已变化，请重新读取');
}
