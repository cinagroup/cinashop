import {and,asc,desc,eq,gte,inArray,isNull,lte,or,sql} from 'drizzle-orm';
import {withTx,type Container,type DbClient} from '@/lib/di';
import {memberRight,storeCouponIssue,storeCouponIssueUser,storeCouponUser,systemConfig,user} from '@/models/schema';
import {ApiException,ValidateException} from '@/utils/errors';
import {normalizeConfigScalar,parseConfigInteger} from '@/utils/config';
import {themeDeadlines} from '@/services/content/ThemeReadService';
import {membershipCouponId} from './MembershipCouponInput';

type Issue=typeof storeCouponIssue.$inferSelect;
type Owned=typeof storeCouponUser.$inferSelect;
export interface MembershipOwnedCoupon{id:number;issue_id:number;title:string;benefit_type:number;benefit_value:string;minimum:string;status:number;start_time:number|null;end_time:number|null;is_fail:boolean}
export interface MembershipCouponEligibility{member_enabled:boolean;coupon_right_enabled:boolean;is_svip:boolean;eligible:boolean;reason:string}
export interface MembershipCouponReceipt{owner_uid:number;issue_id:number;state:'received'|'unknown';coupon:MembershipOwnedCoupon|null}
export interface MembershipCouponClaim{owner_uid:number;issue_id:number;replayed:boolean;coupon:MembershipOwnedCoupon}
export const membershipCouponConflict=()=>new ApiException('会员券领取结果待核对，请重新读取原领取状态',409);
const epoch=(value:Date|null)=>value===null?null:Math.floor(value.getTime()/1000);
function text(value:string|null,maximum:number){return(value??'').replace(/<[^>]*>/gu,'').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu,'').slice(0,maximum);}
function money(value:string):string{if(!/^(?:0|[1-9]\d{0,9})(?:\.\d{1,2})?$/u.test(value))throw new ValidateException('会员券金额配置无效');const[w,p='']=value.split('.');return w+'.'+p.padEnd(2,'0');}
function rule(value:string|null){const result=text(value,Number.MAX_SAFE_INTEGER);if(result.length>64000)throw new ValidateException('会员券完整规则不能超过64000字符');return result;}
export function membershipOwnedCoupon(row:Owned):MembershipOwnedCoupon{return{id:row.id,issue_id:row.issueCouponId,title:text(row.couponTitle,255),benefit_type:row.type,benefit_value:money(row.couponPrice),minimum:money(row.useMinPrice),status:row.status,start_time:epoch(row.startTime),end_time:epoch(row.endTime),is_fail:row.isFail!==0};}
async function owned(tx:DbClient,uid:number,issueId:number){return(await tx.select().from(storeCouponUser).where(and(eq(storeCouponUser.uid,uid),eq(storeCouponUser.issueCouponId,issueId))).orderBy(desc(storeCouponUser.receiveTime),desc(storeCouponUser.id)).limit(1))[0];}
function genuine(account:typeof user.$inferSelect|undefined,now:number){return !!account&&account.status===1&&account.isDel===0&&(account.isEverLevel>0||(account.isMoneyLevel>0&&account.overdueTime>now));}
/** Existing rows are held through grant. NOWAIT avoids an issue->user wait cycle
 * against payment/gift transactions that can already hold user->issue locks.
 * Config/right edits blocked by these locks cannot revoke halfway through a grant.
 * Reads use the same predicates in a single repeatable-read read-only snapshot. */
async function eligibility(tx:DbClient,uid:number,now:number,lock=false):Promise<MembershipCouponEligibility>{
 const users=tx.select().from(user).where(eq(user.uid,uid)).limit(1),configs=tx.select().from(systemConfig).where(and(eq(systemConfig.menuName,'member_card_status'),eq(systemConfig.isStore,0))).orderBy(desc(systemConfig.sort),desc(systemConfig.id)),rights=tx.select().from(memberRight).where(eq(memberRight.rightType,'coupon')).orderBy(asc(memberRight.id));
 const [accounts,settings,entitlements]=lock?await Promise.all([users.for('share',{noWait:true}),configs.for('share',{noWait:true}),rights.for('share',{noWait:true})]):await Promise.all([users,configs,rights]);
 const member_enabled=parseConfigInteger(normalizeConfigScalar(settings[0]?.value??''),1)===1,coupon_right_enabled=entitlements[0]?.status===1,is_svip=genuine(accounts[0],now),eligible=member_enabled&&coupon_right_enabled&&is_svip;
 const reason=!member_enabled?'会员功能暂未开启':!coupon_right_enabled?'会员优惠券权益暂未开启':!is_svip?'请先购买有效的付费会员后领取':'';
 return{member_enabled,coupon_right_enabled,is_svip,eligible,reason};
}
function admission(issue:Issue,now:Date):string{
 if(issue.category!==2||issue.receiveType!==1||issue.appType!==0)return'该优惠券不允许手动领取';
 if(issue.status!==1||issue.isDel!==0)return'优惠券不存在或已停发';
 if(issue.startTime&&issue.startTime>now)return'优惠券未开始';if(issue.endTime&&issue.endTime<now)return'优惠券已结束';
 if(![1,2].includes(issue.type)||![0,1,2,3].includes(issue.couponType)||issue.receiveLimit<0||![0,1].includes(issue.isPermanent))return'优惠券配置无效';
 try{money(issue.couponPrice);money(issue.useMinPrice);}catch{return'优惠券金额配置无效';}
 if(issue.type===2&&(Number(issue.couponPrice)<=0||Number(issue.couponPrice)>100))return'折扣优惠券配置无效';
 if((issue.couponTitle||issue.title).length>64)return'优惠券名称超过可领取范围';
 if(!issue.isPermanent&&issue.remainCount<=0)return'优惠券已领完';
 if(!Number.isSafeInteger(issue.day)||issue.day<0||!Number.isFinite(now.getTime()+issue.day*86400000)||Math.abs(now.getTime()+issue.day*86400000)>8640000000000000)return'优惠券有效期配置无效';
 if(issue.day===0&&(!issue.useEndTime||!Number.isFinite(issue.useEndTime.getTime())||issue.useEndTime<now))return'优惠券固定使用期已过期或未配置';
 if(issue.day===0&&issue.useStartTime&&issue.useEndTime&&issue.useStartTime>issue.useEndTime)return'优惠券固定使用期配置无效';return'';
}
export function membershipCouponLockError(error:unknown):boolean{let current:unknown=error;for(let n=0;n<5&&current&&typeof current==='object';n++){const row=current as {code?:unknown;cause?:unknown};if(['55P03','40P01','40001'].includes(String(row.code)))return true;current=row.cause;}return false;}
/** Caller owns this exact issue FOR UPDATE; ordinary ActivityService code is
 * deliberately not rewritten. Legacy receives a fresh grant or a true refusal;
 * only the modern caller can replay its already-owned coupon without a grant. */
export async function claimMembershipCouponLocked(tx:DbClient,uid:number,issue:Issue|undefined,modern:boolean):Promise<{row:Owned;replayed:boolean}>{
 if(!issue||issue.category!==2)throw new ValidateException('该优惠券不允许手动领取');
 const previous=await owned(tx,uid,issue.id);
 if(modern&&previous)return{row:previous,replayed:true};
 if(!modern){const[account]=await tx.select().from(user).where(eq(user.uid,uid)).limit(1).for('share',{noWait:true});if(!genuine(account,Math.floor(Date.now()/1000)))throw new ValidateException('该优惠券不允许手动领取，请先购买有效的付费会员后领取');}
 const evidence=await tx.select().from(storeCouponIssueUser).where(and(eq(storeCouponIssueUser.uid,uid),eq(storeCouponIssueUser.issueCouponId,issue.id))).limit(1);
 if(previous||evidence.length){if(modern)throw membershipCouponConflict();throw new ValidateException('已领取过该优惠券，每人限领1张');}
 const now=new Date(),reason=admission(issue,now);if(reason)throw new ValidateException(reason);
 const allowed=await eligibility(tx,uid,Math.floor(now.getTime()/1000),true);if(!allowed.eligible)throw new ValidateException('该优惠券不允许手动领取：'+allowed.reason);
 if(!issue.isPermanent){const[changed]=await tx.update(storeCouponIssue).set({remainCount:sql`${storeCouponIssue.remainCount}-1`}).where(and(eq(storeCouponIssue.id,issue.id),gte(storeCouponIssue.remainCount,1))).returning({id:storeCouponIssue.id});if(!changed)throw new ValidateException('优惠券已领完');}
 const[row]=await tx.insert(storeCouponUser).values({uid,issueCouponId:issue.id,couponTitle:issue.couponTitle||issue.title,couponPrice:issue.couponPrice,useMinPrice:issue.useMinPrice,status:0,startTime:issue.day>0?now:issue.useStartTime??now,endTime:issue.day>0?new Date(now.getTime()+issue.day*86400000):issue.useEndTime!,type:issue.type,receiveTime:Math.floor(now.getTime()/1000),receiveSource:'get',isFail:0}).returning();if(!row)throw Error('会员券领取失败');await tx.insert(storeCouponIssueUser).values({uid,issueCouponId:issue.id,addTime:Math.floor(now.getTime()/1000)});return{row,replayed:false};
}
export class MembershipCouponService{
 constructor(private readonly container:Container){}
 async receipt(uid:number,idValue:unknown):Promise<MembershipCouponReceipt>{const issueId=membershipCouponId(idValue);return withTx(this.container,async tx=>{await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ,READ ONLY`);await themeDeadlines(tx);const result=await owned(tx,uid,issueId);return{owner_uid:uid,issue_id:issueId,state:result?'received':'unknown',coupon:result?membershipOwnedCoupon(result):null};});}
 async list(uid:number,page:number,limit:number){return withTx(this.container,async tx=>{
  await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ,READ ONLY`);await themeDeadlines(tx);const now=new Date(),server_now=Math.floor(now.getTime()/1000),allowed=await eligibility(tx,uid,server_now);
  const visible=await tx.select().from(storeCouponIssue).where(and(eq(storeCouponIssue.category,2),eq(storeCouponIssue.status,1),eq(storeCouponIssue.isDel,0),eq(storeCouponIssue.receiveType,1),eq(storeCouponIssue.appType,0),or(isNull(storeCouponIssue.startTime),lte(storeCouponIssue.startTime,now)),or(isNull(storeCouponIssue.endTime),gte(storeCouponIssue.endTime,now)))).orderBy(desc(storeCouponIssue.sort),desc(storeCouponIssue.addTime),desc(storeCouponIssue.id)).limit(limit+1).offset((page-1)*limit),issues=visible.slice(0,limit),ids=issues.map(v=>v.id);
  const received=ids.length?await tx.select().from(storeCouponUser).where(and(eq(storeCouponUser.uid,uid),inArray(storeCouponUser.issueCouponId,ids))).orderBy(desc(storeCouponUser.receiveTime),desc(storeCouponUser.id)):[],logs=ids.length?await tx.select().from(storeCouponIssueUser).where(and(eq(storeCouponIssueUser.uid,uid),inArray(storeCouponIssueUser.issueCouponId,ids))):[];
  const list=issues.map(issue=>{const actual=received.find(v=>v.issueCouponId===issue.id),reason=actual?'已领取':logs.some(v=>v.issueCouponId===issue.id)?'领取记录待核对，请查看原领取状态':admission(issue,now)||allowed.reason;return{issue_id:issue.id,title:text(issue.couponTitle||issue.title,255),benefit_type:issue.type,benefit_value:money(issue.couponPrice),minimum:money(issue.useMinPrice),scope_type:issue.couponType,validity:{kind:issue.day>0?'relative' as const:'fixed' as const,days:issue.day,start_time:issue.day>0?null:epoch(issue.useStartTime),end_time:issue.day>0?null:epoch(issue.useEndTime)},claim_start_time:epoch(issue.startTime),claim_end_time:epoch(issue.endTime),remaining:issue.isPermanent?null:issue.remainCount,rule:rule(issue.rule),owned:actual?membershipOwnedCoupon(actual):null,claimable:!reason,claim_reason:reason};});return{owner_uid:uid,server_now,page,limit,next_page:visible.length>limit?page+1:null,eligibility:allowed,list};
 });}
 async claim(uid:number,idValue:unknown):Promise<MembershipCouponClaim>{const issueId=membershipCouponId(idValue);try{return await withTx(this.container,async tx=>{await tx.execute(sql`SET LOCAL lock_timeout='5s'`);await tx.execute(sql`SET LOCAL statement_timeout='8s'`);const[issue]=await tx.select().from(storeCouponIssue).where(eq(storeCouponIssue.id,issueId)).limit(1).for('update');if(!issue)throw new ValidateException('优惠券不存在或已停发');const result=await claimMembershipCouponLocked(tx,uid,issue,true);return{owner_uid:uid,issue_id:issueId,replayed:result.replayed,coupon:membershipOwnedCoupon(result.row)};});}catch(error){if(membershipCouponLockError(error))throw membershipCouponConflict();throw error;}}
}
