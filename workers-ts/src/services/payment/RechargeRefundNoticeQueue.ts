/** Address-only discovery and processing, not signed-body/send authority. */
import {rechargeRefundSuccessNoticeKey}from './RechargeRefundSuccessNoticeKey';
import {ServiceUnavailableException}from '@/utils/errors';
export interface RechargeRefundNoticeMessage{action:'processRechargeRefundNotice';outboxId:number;eventKey:string}
export interface RechargeRefundNoticeDispatch{action:'dispatchRechargeRefundNotices';afterId:number;cutoff:number|null}
const fail=():never=>{throw new ServiceUnavailableException('充值退款通知消息无效');};
function object(v:unknown,keys:string[]){if(!v||typeof v!=='object'||Array.isArray(v)||![Object.prototype,null].includes(Object.getPrototypeOf(v)))return fail();const d=Object.getOwnPropertyDescriptors(v);if(Reflect.ownKeys(d).length!==keys.length||keys.some(k=>!d[k]?.enumerable||!('value'in d[k])))return fail();return Object.fromEntries(keys.map(k=>[k,d[k].value]));}
export function captureRechargeRefundNoticeMessage(v:unknown):Readonly<RechargeRefundNoticeMessage>{const r=object(v,['action','outboxId','eventKey']);if(r.action!=='processRechargeRefundNotice'||!Number.isSafeInteger(r.outboxId)||Number(r.outboxId)<1||Number(r.outboxId)>2147483647||!rechargeRefundSuccessNoticeKey(r.eventKey))return fail();return Object.freeze(r)as unknown as Readonly<RechargeRefundNoticeMessage>;}
export function captureRechargeRefundNoticeDispatch(v:unknown):Readonly<RechargeRefundNoticeDispatch>{const r=object(v,['action','afterId','cutoff']);if(r.action!=='dispatchRechargeRefundNotices'||!Number.isSafeInteger(r.afterId)||Number(r.afterId)<0||Number(r.afterId)>2147483647||r.cutoff!==null&&(!Number.isSafeInteger(r.cutoff)||Number(r.cutoff)<1||Number(r.cutoff)>2147483647))return fail();return Object.freeze(r)as unknown as Readonly<RechargeRefundNoticeDispatch>;}
export const createRechargeRefundNoticeRoot=():Readonly<RechargeRefundNoticeDispatch>=>Object.freeze({action:'dispatchRechargeRefundNotices',afterId:0,cutoff:null});
export function isRechargeRefundNoticeMessage(v:unknown):v is RechargeRefundNoticeMessage{try{captureRechargeRefundNoticeMessage(v);return true;}catch{return false;}}
export function isRechargeRefundNoticeDispatch(v:unknown):v is RechargeRefundNoticeDispatch{try{captureRechargeRefundNoticeDispatch(v);return true;}catch{return false;}}
