import { and, eq, inArray, sql } from 'drizzle-orm';
import { createContainerFromDb, withTx, type Container, type DbClient } from '@/lib/di';
import { storeCouponIssueUser, storeCouponUser, storeProduct } from '@/models/schema';
import { V2CouponCompatibilityService } from '@/services/activity/V2CouponCompatibilityService';
import { readMembershipCouponEligibility } from '@/services/activity/MembershipCouponService';
import { actorInDatabase, type BuyerReviewActor } from '@/services/order/BuyerReviewSession';
import { publicOrdinaryProductIdentitySql } from './OrdinaryProductReadData';
import { NotFoundException, ValidateException } from '@/utils/errors';
import { readProductCouponRules, renderProductCouponRules } from './ProductCouponRulePolicy';

const invalid = () => new ValidateException('商品优惠券资料无效，请重新读取');
export function productCouponId(raw: string | undefined): number {
  if (!raw || !/^[1-9]\d{0,9}$/.test(raw) || Number(raw) > 2147483647) throw invalid();
  return Number(raw);
}
export function productCouponPage(url: string, legacy = false) {
  const query = new URL(url).searchParams;
  const keys = legacy ? ['product_id', 'page', 'limit'] : ['page', 'limit', ...(query.get('view') === 'uni_product_coupons' ? ['view'] : [])];
  if ([...query.keys()].some(key => !keys.includes(key) || query.getAll(key).length !== 1)) throw invalid();
  const read = (key: string, fallback: number, max: number) => {
    const raw = query.get(key); if (raw === null) return fallback;
    if (!/^[1-9]\d*$/.test(raw) || Number(raw) > max) throw invalid(); return Number(raw);
  };
  const page = read('page', 1, 1000), limit = read('limit', 10, 50);
  if ((page - 1) * limit >= 10000) throw invalid();
  return { page, limit };
}
const money = (raw: string) => {
  if (!/^(0|[1-9]\d{0,9})(\.\d{1,2})?$/.test(raw)) throw invalid();
  const [whole, part = ''] = raw.split('.'); return whole + '.' + part.padEnd(2, '0');
};
const epoch = (raw: Date | null) => raw === null ? null : Math.floor(raw.getTime() / 1000);

/** Product catalogue and claim readback are read-only. Existing manual/member
 * claim services remain the sole grant authority, including their stock locks. */
export class ProductCouponDirectoryService {
  constructor(private readonly container: Container, private readonly actor?: BuyerReviewActor,
    private readonly authorize: () => Promise<void> = async () => {}) {}
  private get uid() { return this.actor?.uid ?? 0; }
  private async snapshot<T>(productId: number, work: (db: DbClient) => Promise<T>) {
    await this.authorize();
    const result = await withTx(this.container, async db => {
      await db.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
      await db.execute(sql`SET LOCAL statement_timeout='5s'`);
      await db.execute(sql`SET LOCAL lock_timeout='250ms'`);
      await db.execute(sql`SET LOCAL idle_in_transaction_session_timeout='5s'`);
      if (this.actor) await actorInDatabase(db, this.actor);
      const [product] = await db.select({id:storeProduct.id}).from(storeProduct)
        .where(and(eq(storeProduct.id, productId), publicOrdinaryProductIdentitySql(),
          sql`octet_length(${storeProduct.cateId})<=20000`)).limit(1);
      if (!product) throw new NotFoundException('商品不存在或已下架');
      return work(db);
    });
    await this.authorize();
    if (this.actor) await actorInDatabase(this.container.db, this.actor);
    return result;
  }
  private async receipts(db: DbClient, ids: number[]) {
    if (!this.uid || !ids.length) return new Map<number, {receivedCount:number;latestCouponUserId:number|null}>();
    const owned = await db.select({id:storeCouponUser.issueCouponId,n:sql<number>`count(*)::int`,latest:sql<number>`max(${storeCouponUser.id})::int`})
      .from(storeCouponUser).where(and(eq(storeCouponUser.uid,this.uid),inArray(storeCouponUser.issueCouponId,ids))).groupBy(storeCouponUser.issueCouponId);
    const evidence = await db.select({id:storeCouponIssueUser.issueCouponId,n:sql<number>`count(*)::int`})
      .from(storeCouponIssueUser).where(and(eq(storeCouponIssueUser.uid,this.uid),inArray(storeCouponIssueUser.issueCouponId,ids))).groupBy(storeCouponIssueUser.issueCouponId);
    return new Map(ids.map(id => { const row=owned.find(row=>row.id===id), log=evidence.find(row=>row.id===id);
      return [id,{receivedCount:Math.max(Number(row?.n??0),Number(log?.n??0)),latestCouponUserId:row?.latest??null}]; }));
  }
  async directory(productId: number, page: number, limit: number, includeRules = false, appKey?: string) {
    const result = await this.snapshot(productId, async db => {
      const now=new Date(), {issues,total}=await new V2CouponCompatibilityService(createContainerFromDb(db)).productDirectoryIssues(productId,page,limit,now,includeRules);
      const rules=includeRules?await readProductCouponRules(db,issues.map(row=>row.rule)):[];
      const receipts=await this.receipts(db,issues.map(row=>row.id));
      const member=issues.some(row=>row.category===2)&&this.uid ? await readMembershipCouponEligibility(db,this.uid,Math.floor(now.getTime()/1000)) : null;
      const items=issues.map((row,index)=>{
        if (![0,1,2,3].includes(row.couponType)||![1,2].includes(row.type)||row.receiveLimit<0||row.day<0||row.day>36500) throw invalid();
        const benefitValue=money(row.couponPrice),minimum=money(row.useMinPrice);
        if(row.type===2&&(Number(benefitValue)<=0||Number(benefitValue)>100)) throw invalid();
        const startTime=row.day?null:epoch(row.useStartTime),endTime=row.day?null:epoch(row.useEndTime);
        if(!row.day&&(endTime===null||startTime!==null&&startTime>endTime))throw invalid();
        const receivedCount=receipts.get(row.id)?.receivedCount??0,isMember=row.category===2;
        // PHP PC marks any previously received issue as already claimed. The
        // grant API's configured multi-claim limit remains unchanged elsewhere.
        const claimReason=receivedCount?'已领取':!this.uid?'登录后领取':isMember&&!member?.eligible?member?.reason||'请先购买有效的付费会员后领取':'';
        return {id:row.id,title:(row.couponTitle||row.title).replace(/<[^>]*>/gu,'').slice(0,255),scopeType:row.couponType,
          benefitType:row.type,benefitValue,minimum,validity:{kind:row.day?'relative' as const:'fixed' as const,days:row.day,startTime,endTime},
          receivedCount,receiveLimit:row.receiveLimit||1,claimable:!claimReason,claimReason,isMember,...(includeRules?{rule:rules[index]}:{})};
      });
      return {version:1,uid:this.uid,productId,page,limit,total,items,...(includeRules?{view:'uni_product_coupons' as const}:{})};
    });
    if(includeRules){
      const rules=await renderProductCouponRules(appKey,result.items.map(row=>row.rule!));
      if(rules.some(rule=>rule.length>64000))throw new ValidateException('商品优惠券完整规则超过读取容量');
      result.items.forEach((row,index)=>{row.rule=rules[index];});
      if(new TextEncoder().encode(JSON.stringify(result)).byteLength>1048576)throw new ValidateException('商品优惠券整页资料超过完整读取容量');
      await this.authorize();
      if(this.actor)await actorInDatabase(this.container.db,this.actor);
    }
    return result;
  }
  async receipt(productId:number,couponId:number){
    if(!this.actor)throw invalid();
    return this.snapshot(productId,async db=>({version:1,uid:this.uid,productId,couponId,
      ...((await this.receipts(db,[couponId])).get(couponId)??{receivedCount:0,latestCouponUserId:null})}));
  }
}
