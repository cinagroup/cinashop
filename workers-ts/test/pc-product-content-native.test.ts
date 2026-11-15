import { expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { storeBrand, storeProductCategory, storeProduct, storeCouponIssue, storeCouponProduct, storeCouponUser, storeCouponIssueUser, systemConfig, user, systemSupplier, memberRight } from '@/models/schema';
import { withBuyerInvoices } from './helpers/buyerInvoices';
type S=Parameters<Parameters<typeof withBuyerInvoices>[0]>[0];
const path='/api/product/detail/70/coupons';
async function seed(s:S){
  await s.f.db.update(storeCouponIssue).set({status:0});
  await s.f.db.insert(storeProductCategory).values([{id:951,pid:950},{id:950}]);
  await s.f.db.insert(storeBrand).values([{id:951,pid:950},{id:950}]);
  await s.f.db.update(storeProduct).set({cateId:'951',brandId:951}).where(eq(storeProduct.id,70));
  const now=Date.now(),base={couponTitle:'商品适用券',title:'商品适用券',couponPrice:'5.00',useMinPrice:'20.00',day:7,
    category:1,receiveType:1,appType:0,type:1,status:1,remainCount:5,totalCount:5,receiveLimit:1};
  await s.f.db.insert(storeCouponIssue).values([
    ...Array.from({length:17},(_,i)=>({...base,id:951000+i,couponType:0,sort:100-i})),
    {...base,id:951020,couponType:2,productId:'70',sort:200},
    {...base,id:951021,couponType:2,sort:199},
    {...base,id:951022,couponType:1,category_id:'950',sort:198},
    {...base,id:951023,couponType:3,legacyBrandId:950,type:2,couponPrice:'85.00',day:0,useStartTime:new Date(now-86400000),useEndTime:new Date(now+86400000),sort:197},
    {...base,id:951024,couponType:2,productId:'170'},
    {...base,id:951025,couponType:1,category_id:'952'},
    {...base,id:951026,couponType:3,brandId:'952'},
    {...base,id:951027,couponType:0,status:0},
    {...base,id:951028,couponType:0,isDel:1},
    {...base,id:951029,couponType:0,endTime:new Date(now-1000)},
    {...base,id:951030,couponType:0,startTime:new Date(now+86400000)},
    {...base,id:951031,couponType:0,remainCount:0},
    {...base,id:951032,couponType:0,receiveType:3},
    {...base,id:951033,couponType:0,appType:1},
    {...base,id:951034,couponType:0,category:3},
  ]);
  await s.f.db.insert(storeCouponProduct).values([{couponId:951021,productId:70},{couponId:951021,productId:70}]);
}
const couponState=async(s:S)=>({issues:await s.f.db.select().from(storeCouponIssue).orderBy(storeCouponIssue.id),owned:await s.f.db.select().from(storeCouponUser).orderBy(storeCouponUser.id),logs:await s.f.db.select().from(storeCouponIssueUser).orderBy(storeCouponIssueUser.uid,storeCouponIssueUser.issueCouponId,storeCouponIssueUser.addTime)});
async function ok(s:S,url=path,bearer?:string|null){const r=await s.request(url,undefined,bearer);expect(r.status,r.msg).toBe(200);expect(r.headers.get('cache-control')).toContain('no-store');return r.data;}
it('reads all four product coupon scopes and exact complete 10/10/1 pages on the commissioned LOGIN without writes',async()=>withBuyerInvoices(async s=>{
  await seed(s);const before=await couponState(s),first=await ok(s,path, null);
  expect(first).toMatchObject({version:1,uid:0,productId:70,page:1,limit:10,total:21});
  expect(first.items.slice(0,4).map((x:{id:number})=>x.id)).toEqual([951020,951021,951022,951023]);
  expect(first.items[3]).toMatchObject({scopeType:3,benefitType:2,benefitValue:'85.00',minimum:'20.00',validity:{kind:'fixed',days:0},claimable:false,claimReason:'登录后领取'});
  const second=await ok(s,path+'?page=2'),third=await ok(s,path+'?page=3'),empty=await ok(s,path+'?page=4');
  expect(second.items).toHaveLength(10);expect(third.items).toHaveLength(1);expect(empty.items).toEqual([]);
  expect(new Set([...first.items,...second.items,...third.items].map((x:{id:number})=>x.id)).size).toBe(21);
  const legacy=await ok(s,'/api/coupons?product_id=70&limit=50');expect(legacy).toHaveLength(21);expect(legacy[3]).toMatchObject({type:3,coupon_type:2,coupon_price:85,is_use:false});
  expect(await couponState(s)).toEqual(before);
}),120000);
it('binds normal self-claim and readonly receipts to this UID including issue exhaustion and surviving historical issue evidence',async()=>withBuyerInvoices(async s=>{
  await seed(s);await s.f.db.update(storeCouponIssue).set({remainCount:1,totalCount:1}).where(eq(storeCouponIssue.id,951020));
  const before=await s.f.state(),grant=await s.request('/api/coupon/receive',{id:951020});expect(grant.status,grant.msg).toBe(200);
  const receipt=await ok(s,path+'/951020/receipt');expect(receipt).toMatchObject({version:1,uid:11,productId:70,couponId:951020,receivedCount:1,latestCouponUserId:grant.data.couponUserId});
  expect((await ok(s)).items.some((x:{id:number})=>x.id===951020)).toBe(false);
  expect(await ok(s,path+'/951020/receipt',await s.token(22))).toMatchObject({uid:22,receivedCount:0,latestCouponUserId:null});
  expect((await s.request('/api/coupon/receive',{id:951020})).status).not.toBe(200);
  await s.f.db.delete(storeCouponUser).where(eq(storeCouponUser.id,grant.data.couponUserId));
  expect(await ok(s,path+'/951020/receipt')).toMatchObject({receivedCount:1,latestCouponUserId:null});
  expect((await s.request('/api/coupon/receive',{id:951020})).status).not.toBe(200);
  expect(await s.f.state()).toEqual(before);
}),120000);
it('projects current membership entitlement and never grants a member coupon to an ordinary actor',async()=>withBuyerInvoices(async s=>{
  await seed(s);const rights=await s.f.db.update(memberRight).set({status:1}).where(eq(memberRight.rightType,'coupon')).returning({id:memberRight.id});if(!rights.length)await s.f.db.insert(memberRight).values({id:951200,rightType:'coupon',status:1,number:1});await s.f.db.update(storeCouponIssue).set({category:2}).where(eq(storeCouponIssue.id,951020));
  const before=await couponState(s),row=(await ok(s)).items.find((x:{id:number})=>x.id===951020);
  expect(row).toMatchObject({isMember:true,claimable:false,receivedCount:0});expect(row.claimReason).toBeTruthy();
  expect((await s.request('/api/coupon/receive',{id:951020})).status).not.toBe(200);expect(await couponState(s)).toEqual(before);
  await s.f.db.update(user).set({isEverLevel:1}).where(eq(user.uid,11));
  await s.f.db.delete(systemConfig).where(eq(systemConfig.menuName,'member_card_status'));await s.f.db.insert(systemConfig).values({menuName:'member_card_status',value:'"1"'});
  const allowed=(await ok(s)).items.find((x:{id:number})=>x.id===951020);expect(allowed).toMatchObject({isMember:true,claimable:true,claimReason:''});
}),120000);
it('rejects malformed/duplicate selectors and identity injection, private parents and stale tokens without writes',async()=>withBuyerInvoices(async s=>{
  await seed(s);const before=await couponState(s),bearer=await s.token();
  for(const url of [path+'?page=1&page=2',path+'?uid=22',path+'?limit=51',path+'?page=0',path+'?page=1001',path.replace('/70/','/070/'),path+'/951020/receipt?uid=22','/api/coupons?product_id=70&product_id=71'])expect((await s.request(url)).status).not.toBe(200);
  expect((await s.request(path+'/951020/receipt',undefined,null)).status).not.toBe(200);
  await s.f.db.update(systemSupplier).set({isShow:0}).where(eq(systemSupplier.id,7));expect((await s.request(path)).status).not.toBe(200);
  await s.f.db.update(systemSupplier).set({isShow:1}).where(eq(systemSupplier.id,7));
  await s.f.db.update(user).set({pwd:'changed-synthetic-password'}).where(eq(user.uid,11));expect(await ok(s,path,bearer)).toMatchObject({uid:0});expect((await s.request(path+'/951020/receipt',undefined,bearer)).status).not.toBe(200);
  expect(await couponState(s)).toEqual(before);
}),120000);
it('keeps one-receive PC display semantics even if the existing grant contract allows a configured repeat',async()=>withBuyerInvoices(async s=>{
  await seed(s);await s.f.db.update(storeCouponIssue).set({receiveLimit:2}).where(eq(storeCouponIssue.id,951020));
  expect((await s.request('/api/coupon/receive',{id:951020})).status).toBe(200);
  const before=await couponState(s),row=(await ok(s)).items.find((x:{id:number})=>x.id===951020);
  expect(row).toMatchObject({receiveLimit:2,receivedCount:1,claimable:false,claimReason:'已领取'});expect(await couponState(s)).toEqual(before);
}),120000);
