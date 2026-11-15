import { orderDetailId } from './orderDetailIdentity';
export interface BuyerReviewScores { replyScore: number; productScore: number; serviceScore: number; logisticsScore: number }
export interface BuyerReviewRecord {
  id: number; uid: number; orderId: number; cartInfoId: number; unique: string;
  comment: string; replyScore: number | null; productScore: number | null; serviceScore: number | null; logisticsScore: number | null;
  pics: string[]; addTime: string; visible: boolean;
}
export interface BuyerReviewLine {
  id: number; unique: string; productId: number; name: string; sku: string; price: string | null; image: string;
  isGift: boolean; revision: string; canReply: boolean; reason: string; review: BuyerReviewRecord | null;
}
export interface BuyerReviewPage {
  version: 1; uid: number; orderId: number; orderNo: string; paid: boolean; status: number;
  canReview: boolean; reason: string; lines: BuyerReviewLine[];
}
export interface BuyerReviewDraft extends BuyerReviewScores { comment: string; pics: string[] }
export interface BuyerReviewBody extends BuyerReviewDraft {
  version: 1; orderId: number; orderNo: string; cartInfoId: number; unique: string; revision: string;
}
export interface BuyerReviewAck {
  version: 1; uid: number; orderId: number; orderNo: string; cartInfoId: number; unique: string; replyId: number; completed: boolean; toLottery: boolean;
}
export const MAX_BUYER_REVIEW_IMAGES = 8;
const fail = (): never => { throw Error('评价资料与当前账号或订单不一致，请重新读取'); };
function object(v: unknown): Record<string, unknown> { return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string,unknown> : fail(); }
function integer(v: unknown, minimum = 1, maximum = 2147483647): number { return typeof v === 'number' && Number.isInteger(v) && v >= minimum && v <= maximum ? v : fail(); }
function boolean(v: unknown): boolean { return typeof v === 'boolean' ? v : fail(); }
function text(v: unknown, max: number): string {
  if (typeof v !== 'string' || v.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(v)) return fail();
  for (const c of v) if (c.length === 1 && c.charCodeAt(0) >= 0xd800 && c.charCodeAt(0) <= 0xdfff) return fail();
  return v;
}
function revision(v: unknown): string { return typeof v === 'string' && /^[a-f0-9]{64}$/.test(v) ? v : fail(); }
export function buyerReviewImageReference(v: unknown): string {
  const value = text(v, 64), match = /^\/api\/assets\/([1-9]\d{0,9})$/.exec(value);
  if (!match || Number(match[1]) > 2147483647) return fail(); return value;
}
export function buyerReviewImageSource(v: unknown): string {
  const value = text(v, 2048); if (!value) return '';
  if (/[\\\s]/.test(value) || value.startsWith('//')) return fail();
  if (/^\/api\/assets(?:\/|$)/i.test(value)) {
    const offset=value.indexOf('?');if(offset<0||value.includes('#'))return fail();
    buyerReviewImageReference(value.slice(0,offset));
    let entries:[string,string][];
    try {const decode=(part:string)=>decodeURIComponent(part.replace(/\+/g,' '));entries=value.slice(offset+1).split('&').map<[string,string]>(part=>{const at=part.indexOf('=');return [decode(at<0?part:part.slice(0,at)),decode(at<0?'':part.slice(at+1))];});}
    catch {return fail();}
    const params=new Map(entries);
    if(entries.length!==2||params.size!==2||!params.has('expires')||!params.has('signature')
      ||!/^\d{1,12}$/.test(params.get('expires')??'')||!/^[A-Za-z0-9_-]{43}$/.test(params.get('signature')??''))return fail();
    return value;
  }
  if (/^\/(?!\/)/.test(value) || /^https?:\/\/(?:\[[0-9a-f:]+\]|[a-z0-9.-]+)(?::\d{1,5})?(?:[/?#][^\s]*)?$/i.test(value)) return value;
  return fail();
}
function storedScore(value: unknown, max: number): number | null { return value === null ? null : integer(value,1,max); }
function record(v: unknown, page: {uid:number;orderId:number}, line: {id:number;unique:string}): BuyerReviewRecord {
  const r=object(v), uid=integer(r.uid), orderId=integer(r.orderId), cartInfoId=integer(r.cartInfoId), unique=text(r.unique,50);
  if (uid!==page.uid || orderId!==page.orderId || cartInfoId!==line.id || unique!==line.unique || !Array.isArray(r.pics) || r.pics.length>9) return fail();
  const addTime=text(r.addTime,32); if (addTime!=='' && !/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(addTime)) return fail();
  return {id:integer(r.id),uid,orderId,cartInfoId,unique,comment:text(r.comment,4096),replyScore:storedScore(r.replyScore,3),
    productScore:storedScore(r.productScore,5),serviceScore:storedScore(r.serviceScore,5),logisticsScore:storedScore(r.logisticsScore,5),
    pics:r.pics.map(buyerReviewImageSource),addTime,visible:boolean(r.visible)};
}
export function parseBuyerReviewPage(raw: unknown, reference: string, uid: number): BuyerReviewPage {
  const r=object(raw), orderNo=orderDetailId(r.orderNo), orderId=integer(r.orderId), paid=boolean(r.paid), status=integer(r.status,-3,5), canReview=boolean(r.canReview), reason=text(r.reason,1000);
  if (r.version!==1 || integer(r.uid)!==integer(uid) || orderNo!==orderDetailId(reference) || !Array.isArray(r.lines) || r.lines.length>200 || canReview&&(!paid||status!==2||reason)) return fail();
  const ids=new Set<number>(), uniqueIds=new Set<string>();
  const lines=r.lines.map(v=>{const row=object(v),id=integer(row.id),unique=text(row.unique,50),isGift=boolean(row.isGift),canReply=boolean(row.canReply),lineReason=text(row.reason,1000);
    if (ids.has(id) || unique&&uniqueIds.has(unique)) return fail(); ids.add(id); if (unique) uniqueIds.add(unique);
    const review=row.review===null?null:record(row.review,{uid,orderId},{id,unique});
    if (canReply&&(!canReview||isGift||review||!unique||lineReason) || !canReply&&!lineReason) return fail();
    const price=row.price===null?null:text(row.price,32); if (price!==null&&!/^\d{1,10}\.\d{2}$/.test(price)) return fail();
    return {id,unique,productId:integer(row.productId,0),name:text(row.name,200),sku:text(row.sku,512),price,image:buyerReviewImageSource(row.image),
      isGift,revision:revision(row.revision),canReply,reason:lineReason,review};});
  return {version:1,uid,orderId,orderNo,paid,status,canReview,reason,lines};
}
export function buyerReviewDraft(): BuyerReviewDraft { return {replyScore:3,productScore:5,serviceScore:5,logisticsScore:5,comment:'',pics:[]}; }
export function validateBuyerReviewBody(value: unknown): BuyerReviewBody {
  const r=object(value), keys=['version','orderId','orderNo','cartInfoId','unique','revision','replyScore','productScore','serviceScore','logisticsScore','comment','pics'];
  if (Object.keys(r).length!==keys.length || Object.keys(r).some(k=>!keys.includes(k)) || r.version!==1 || !Array.isArray(r.pics) || r.pics.length>MAX_BUYER_REVIEW_IMAGES) return fail();
  const comment=text(r.comment,512).trim(),unique=text(r.unique,50),pics=r.pics.map(buyerReviewImageReference);
  if (!comment||!unique||new Set(pics).size!==pics.length) return fail();
  return {version:1,orderId:integer(r.orderId),orderNo:orderDetailId(r.orderNo),cartInfoId:integer(r.cartInfoId),unique,revision:revision(r.revision),
    replyScore:integer(r.replyScore,1,3),productScore:integer(r.productScore,1,5),serviceScore:integer(r.serviceScore,1,5),logisticsScore:integer(r.logisticsScore,1,5),comment,pics};
}
export function parseBuyerReviewAck(raw: unknown, body: BuyerReviewBody, uid: number): BuyerReviewAck {
  const r=object(raw);
  if (r.version!==1||integer(r.uid)!==uid||r.orderId!==body.orderId||r.orderNo!==body.orderNo||r.cartInfoId!==body.cartInfoId||r.unique!==body.unique) return fail();
  return {version:1,uid,orderId:body.orderId,orderNo:body.orderNo,cartInfoId:body.cartInfoId,unique:body.unique,replyId:integer(r.replyId),completed:boolean(r.completed),toLottery:boolean(r.toLottery)};
}
