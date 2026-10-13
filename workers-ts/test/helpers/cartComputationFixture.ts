import { eq } from 'drizzle-orm';
import { createPcCheckoutQuoteFixture } from './pcCheckoutQuoteFixture';
import { storeActivity,storeBargain,storeBargainUser,storeCart,storeCombination,storeCouponIssue,storeCouponIssueUser,
  storeCouponProduct,storeCouponUser,storeIntegral,storeNewcomer,storeProduct,storeProductAttrValue,
  storeProductCategory,storeSeckill,storeSeckillTime,systemConfig,systemUserLevel,user } from '../../src/models/schema';

export async function cartComputationFixture(){
  const f=await createPcCheckoutQuoteFixture([storeActivity,storeBargain,storeBargainUser,storeCombination,storeCouponIssue,
    storeCouponIssueUser,storeCouponProduct,storeCouponUser,storeIntegral,storeNewcomer,storeProductCategory,storeSeckill,storeSeckillTime,systemUserLevel]);
  const setBudgetConfig=async(values:Record<string,string>)=>{
    for(const [menuName,value] of Object.entries(values)){
      const found=await f.db.update(systemConfig).set({value}).where(eq(systemConfig.menuName,menuName)).returning({id:systemConfig.id});
      if(!found.length)await f.db.insert(systemConfig).values({menuName,value});
      f.config[menuName]=value;
    }
    f.cache.clear();
  };
  try{
    await setBudgetConfig({member_func_status:'0',member_card_status:'1',svip_price_status:'1',newcomer_status:'1',first_order_status:'0',newcomer_limit_status:'0'});
    await f.db.update(user).set({pwd:'budget-password',isEverLevel:0,isMoneyLevel:0}).where(eq(user.uid,11));
    await f.db.insert(user).values({uid:22,account:'budget-other-owner',pwd:'other-password'});
    await f.db.update(storeCart).set({isNew:0});
    await f.db.update(storeProduct).set({price:'19.99',vipPrice:'10.00',freight:1,tempId:0,deliveryType:'1,2,3'});
    await f.db.update(storeProductAttrValue).set({price:'19.99',vipPrice:'10.00'});
    const snapshot=async()=>({...await f.snapshot(),issues:await f.db.select().from(storeCouponIssue).orderBy(storeCouponIssue.id),
      coupons:await f.db.select().from(storeCouponUser).orderBy(storeCouponUser.id),
      evidence:await f.db.select().from(storeCouponIssueUser).orderBy(storeCouponIssueUser.issueCouponId),
      relations:await f.db.select().from(storeCouponProduct).orderBy(storeCouponProduct.couponId,storeCouponProduct.productId)});
    return {...f,setBudgetConfig,snapshot};
  }catch(error){await f.close();throw error;}
}
