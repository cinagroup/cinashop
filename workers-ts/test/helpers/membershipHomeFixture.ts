import {vi,expect} from 'vitest';
import {eq,sql,SQL} from 'drizzle-orm';
import {PgDialect,getTableConfig} from 'drizzle-orm/pg-core';
import {createHash} from 'node:crypto';
import type {Env} from '@/env';
import {agreement,memberRight,memberShip,storeCouponIssue,storeProduct,storeOrderEconomize,systemConfig,systemDise,user,wechatUser} from '@/models/schema';
import {membershipCardActivationBrowserFixture} from './membershipCardActivationBrowserFixture';
import {sortedDiyState,type DiyStateSnapshot,type DiyStateRow as Row} from './diyStateFixture';

/** Independent owned setup extends the previous exact fixture without changing
 * it. Real catalogue, membership, cashier and payment code use the registered
 * Worker; only local storage/sequence bindings and QA sessions are synthetic. */
export async function membershipHomeFixture(){
 const f=await membershipCardActivationBrowserFixture();
 try{
  const dialect=new PgDialect(),definition=getTableConfig(wechatUser);
  if(!(await f.db.execute(sql`SELECT to_regclass(${definition.name}) AS name`))[0]?.name){
   const columns=definition.columns.map(c=>{const v=c.default,initial=v===undefined?'':` default ${v instanceof SQL?dialect.sqlToQuery(v).sql:dialect.sqlToQuery(sql`${v}`.inlineParams()).sql}`;return `"${c.name}" ${c.getSQLType()}${initial}${c.notNull?' not null':''}${c.primary?' primary key':''}`;});
   await f.exec(`CREATE TABLE "${definition.name}" (${columns.join(',')})`);
  }
  const tables=(await f.db.execute<{name:string}>(sql`SELECT tablename AS name FROM pg_tables WHERE schemaname=current_schema() ORDER BY tablename`)).map(row=>row.name);
  const sequences=(await f.db.execute<{name:string}>(sql`SELECT sequencename AS name FROM pg_sequences WHERE schemaname=current_schema() ORDER BY sequencename`)).map(row=>row.name);
  async function snapshot():Promise<DiyStateSnapshot>{
   const state:DiyStateSnapshot={};for(const row of await f.db.execute<{name:string;rows:Row[]}>(sql.join(tables.map(name=>sql`SELECT ${name}::text AS name,COALESCE(jsonb_agg(to_jsonb(t)),'[]'::jsonb) AS rows FROM ${sql.identifier(name)} t`),sql` UNION ALL `)))state[row.name]=row.rows;
   state.__sequences=await f.db.execute(sql.join(sequences.map(name=>sql`SELECT ${name}::text AS name,last_value::text AS last,is_called AS called FROM ${sql.identifier(name)}`),sql` UNION ALL `));return sortedDiyState(state);
  }
  const resources=()=>({puts:f.bucket.put.mock.calls.length,deletes:f.bucket.delete.mock.calls.length,queue:vi.mocked(f.env.ORDER_QUEUE.send).mock.calls.length,objects:[...f.objects].map(([key,item])=>({key,type:item.type,bytes:item.bytes.length,sha256:createHash('sha256').update(item.bytes).digest('hex')})).sort((a,b)=>a.key.localeCompare(b.key))});
  const before=await snapshot(),resourcesBefore=resources(),now=Math.floor(Date.now()/1000);
  const plans=[{id:11001,title:'免费体验',type:'free',vipDay:7,price:'0.00',prePrice:'0.00',sort:40},
   {id:11002,title:'月度会员',type:'month',vipDay:30,price:'29.90',prePrice:'9.90',sort:30,isLabel:1},
   {id:11003,title:'年度会员',type:'year',vipDay:365,price:'199.00',prePrice:'59.90',sort:20},
   {id:11004,title:'永久会员',type:'ever',vipDay:0,price:'599.00',prePrice:'199.00',sort:10}];
  await f.db.insert(memberShip).values(plans);
  for(const uid of [11,22])await f.db.update(user).set({nickname:'原版会员首页'+uid,avatar:'/static/logo.png',nowMoney:uid===11?'100.00':'88.50',isMoneyLevel:0,isEverLevel:0,overdueTime:0,addTime:now-30*86400}).where(eq(user.uid,uid));
  await f.db.update(memberRight).set({showTitle:'会员折扣',image:f.platformImage.url,explain:'会员专享价格',content:'<p>会员价格以结算为准。</p>'}).where(eq(memberRight.id,1));
  const legal='<p>付费会员服务协议：请在购买前阅读会员权益、价格和有效期，订单以服务端实际结果为准。</p>';
  const existing=await f.db.select({id:agreement.id}).from(agreement).where(eq(agreement.type,1));
  if(existing.length)await f.db.update(agreement).set({title:'付费会员服务协议',content:legal,status:1}).where(eq(agreement.type,1));
  else await f.db.insert(agreement).values({id:11001,type:1,title:'付费会员服务协议',content:legal,status:1});
  await f.db.insert(storeCouponIssue).values([1,2,3,4].map(n=>({id:11000+n,category:2,couponType:0,couponTitle:'会员专享'+(n*5)+'元券',couponPrice:String(n*5)+'.00',useMinPrice:'0.00',day:30,remainCount:100,status:1,sort:10000-n,addTime:now})));
  await f.db.insert(storeOrderEconomize).values({uid:11,orderId:'membership-home-prior-saving',postagePrice:'2.30',memberPrice:'10.00',offlinePrice:'0.00',couponPrice:'3.00'});
  await f.db.update(storeProduct).set({isVip:0});
  const products=Array.from({length:24},(_,n)=>({id:12001+n,type:0,relationId:0,storeName:'会员推荐商品'+String(n+1).padStart(2,'0'),image:f.platformImage.url,sliderImage:JSON.stringify([f.platformImage.url]),price:'12.00',otPrice:'20.00',vipPrice:'8.00',stock:100,isVip:1,isVerify:1,isShow:1,isDel:0,sort:50000-n,productType:0}));
  await f.db.insert(storeProduct).values(products);
  await f.db.insert(storeProduct).values([
   {...products[0]!,id:12031,storeName:'隐藏会员推荐旁观',isShow:0},
   {...products[0]!,id:12032,storeName:'删除会员推荐旁观',isDel:1},
   {...products[0]!,id:12033,storeName:'未审核会员推荐旁观',isVerify:0},
   {...products[0]!,id:12034,storeName:'门店副本会员推荐旁观',type:1,relationId:77},
   {...products[0]!,id:12035,storeName:'停用供应商会员推荐旁观',type:2,relationId:999},
  ]);
  await f.db.insert(wechatUser).values([{uid:11,userType:'wechat',openid:'owned-member-home-wechat-11'},{uid:11,userType:'routine',openid:'owned-member-home-routine-11'}]);
  async function config(key:string,value:string){
   const rows=await f.db.select({id:systemConfig.id}).from(systemConfig).where(eq(systemConfig.menuName,key));
   if(rows.length)await f.db.update(systemConfig).set({value}).where(eq(systemConfig.menuName,key));else await f.db.insert(systemConfig).values({menuName:key,value});f.cache.delete('cfg_'+key);
  }
  for(const [key,value]of Object.entries({member_card_status:'1',balance_func_status:'1',yue_pay_status:'1',pay_weixin_open:'0',ali_pay_status:'0',site_name:'原版会员商城'}))await config(key,value);
  const blocks=structuredClone(f.blocks),footer=blocks.find(row=>row.name==='pageFoot')!;
  footer.menuList=[{name:'会员中心',link:'/pages/annex/vip_paid/index',imgList:[f.platformImage.url,f.platformImage.url]},{name:'我的',link:'/pages/user/index',imgList:[f.platformImage.url,f.platformImage.url]}];
  for(const id of[1,2])await f.db.update(systemDise).set({value:JSON.stringify(blocks),version:'owned-membership-home-1'}).where(eq(systemDise.id,id));
  const sequenceCalls:Row[]=[];let next=0;const identity={toString:()=> 'owned-membership-home-sequence'};
  f.env.SEQUENCE={idFromName:(name:string)=>{expect(name).toBe('seq');sequenceCalls.push({kind:'idFromName',name});return identity;},get:(id:unknown)=>{expect(id).toBe(identity);sequenceCalls.push({kind:'get'});return{fetch:async(input:Request|string|URL)=>{const url=String(input instanceof Request?input.url:input);expect(url).toBe('https://internal/next-order-id?prefix=hy');const value='hy_home_legacy_'+(++next);sequenceCalls.push({kind:'allocate',url,value});return new Response(value);}};}} as unknown as Env['SEQUENCE'];
  const baseline=await snapshot();f.cache.clear();
  async function restore(){
   await f.exec('TRUNCATE '+tables.map(name=>'"'+name+'"').join(',')+' RESTART IDENTITY');
   await f.db.transaction(async tx=>{
    for(const table of tables)if(baseline[table].length)await tx.execute(sql`INSERT INTO ${sql.identifier(table)} SELECT * FROM jsonb_populate_recordset(NULL::${sql.identifier(table)},${JSON.stringify(baseline[table])}::jsonb)`);
    for(const sequence of baseline.__sequences)await tx.execute(sql`SELECT setval(${String(sequence.name)}::regclass,${String(sequence.last)}::bigint,${Boolean(sequence.called)})`);
   });
   next=0;sequenceCalls.length=0;f.cache.clear();
  }
  return{...f,tables,sequences,snapshot,resources,config,plans,products,restore,baseline,sequence:()=>({allocated:next,calls:structuredClone(sequenceCalls)}),setup:{before,after:baseline,resources_before:resourcesBefore,resources_after:resources(),legacy_entry:'/pages/annex/vip_paid/index',target:'/pages/user/vipOpen',plan_ids:plans.map(row=>row.id),product_ids:products.map(row=>row.id)}};
 }catch(error){await f.close();throw error;}
}
