import {AsyncLocalStorage} from 'node:async_hooks';
import {createHash} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {beforeAll,beforeEach,afterAll,describe,it,expect,vi} from 'vitest';
import {eq,sql} from 'drizzle-orm';
import {createApp} from '@/app';
import type {Env} from '@/env';
import {createContainerFromDb,type Container,type DbClient} from '@/lib/di';
import {memberShip,otherOrder,systemAttachment,user} from '@/models/schema';
import {createToken,md5} from '@/utils/jwt';
import {membershipHomeFixture} from './helpers/membershipHomeFixture';
import {withFinancePeers,outcome} from './helpers/financePeers';
import {sortedDiyState,type DiyStateRow as Row} from './helpers/diyStateFixture';
const wiring=vi.hoisted(()=>({context:undefined as AsyncLocalStorage<Container>|undefined}));
vi.mock('@/lib/di',async original=>({...await original<typeof import('@/lib/di')>(),createContainer:()=>{
 const value=wiring.context?.getStore();if(!value)throw Error('Missing request-local membership-home container');return value;
}}));
const UUID='71000000-0000-4000-8000-000000000001',NEXT='71000000-0000-4000-8000-000000000002';
const purchase=(plan=11002,from='weixinh5',request=UUID)=>({member_type:plan,from,request_id:request});
const derive=(uid:number,id=UUID)=>'hy'+createHash('sha256').update('membership-purchase:v1\n'+uid+'\n'+id).digest('base64url').slice(0,30);
const one=(rows:Row[],key:string,id:unknown)=>{const found=rows.filter(row=>row[key]===id);expect(found).toHaveLength(1);return found[0]!;};
const replace=(rows:Row[],key:string,id:unknown,value:Row)=>rows.map(row=>row[key]===id?value:row);
const advance=(rows:Row[],name:string)=>rows.map(row=>row.name===name?{...row,last:String(BigInt(String(row.last))+(row.called?1n:0n)),called:true}:row);
async function blocked(observer:DbClient,writers:[number,number],holder:number){
 const owned=[...writers,holder],deadline=performance.now()+4000;
 do{
  const rows=await observer.execute<{pid:number;blockers:number[]}>(sql`SELECT ${writers[0]}::int AS pid,pg_blocking_pids(${writers[0]}::int) AS blockers UNION ALL SELECT ${writers[1]}::int AS pid,pg_blocking_pids(${writers[1]}::int) AS blockers UNION ALL SELECT ${holder}::int AS pid,pg_blocking_pids(${holder}::int) AS blockers`);
  if(rows.some(row=>row.blockers.some(pid=>!owned.includes(pid))))throw Error('Unexpected external purchase blocker');
  const graph=new Map(rows.map(row=>[row.pid,row.blockers]));
  const path=(pid:number,seen:number[]=[]):number[]|null=>{if(seen.includes(pid))return null;const next=[...seen,pid];if(pid===holder)return next;for(const p of graph.get(pid)??[]){const result=path(p,next);if(result)return result;}return null;};
  const a=path(writers[0]),b=path(writers[1]);if(a&&b)return{writers,holder,observed_blockers:rows,paths:[a,b]};await delay(25);
 }while(performance.now()<deadline);throw Error('Both native purchase waiter paths were not observed');
}

/** Registered HTTP/JWT/services and actual SQL. Native PG16 proves the blocker
 * graph; PGlite fallback keeps accounting assertions without a lock claim.
 * External payment initiation stays disabled, not replaced by a mock success. */
describe('membership home explicit purchase recovery and server accounting',()=>{
 let f:Awaited<ReturnType<typeof membershipHomeFixture>>,env:Env,app:ReturnType<typeof createApp>,network:ReturnType<typeof vi.spyOn>;
 let tokens=new Map<number,string>();
 beforeAll(async()=>{f=await membershipHomeFixture();network=vi.spyOn(globalThis,'fetch').mockRejectedValue(Error('Membership home forbids external provider requests'));wiring.context=new AsyncLocalStorage<Container>();app=createApp();},45000);
 beforeEach(async()=>{
  await f.restore();env={...f.env,APP_KEY:'owned-member-home-purchase-jwt',UPSTASH_REDIS_URL:'',UPSTASH_REDIS_TOKEN:''};tokens=new Map();
  for(const uid of[11,22]){const [row]=await f.db.select().from(user).where(eq(user.uid,uid));tokens.set(uid,(await createToken(uid,'api',md5(row!.pwd),env.APP_KEY)).token);}
 },30000);
 afterAll(async()=>{try{expect(network).not.toHaveBeenCalled();}finally{wiring.context?.disable();wiring.context=undefined;network?.mockRestore();await f?.close();}},30000);
 async function request(path:string,options:{method?:string;body?:unknown;uid?:number;token?:string;form?:string;container?:Container;environment?:Env}={}){
  const uid=options.uid??11,token=options.token??tokens.get(uid)??'',before=await f.snapshot(),resources=f.resources(),sequence=f.sequence(),started=Math.floor(Date.now()/1000);
  const response=await wiring.context!.run(options.container??f.container,()=>app.request(path,{method:options.method??'GET',headers:{'Content-Type':'application/json','Form-type':options.form??'h5',...(token?{'Authori-zation':'Bearer '+token}:{})},...(options.body!==undefined?{body:typeof options.body==='string'?options.body:JSON.stringify(options.body)}:{})},options.environment??env));
  const raw=await response.text(),value=JSON.parse(raw) as {status:number;msg:string;data:Row|null};expect(response.status,raw).toBe(200);expect(response.headers.get('content-type')).toContain('application/json');expect(f.resources()).toEqual(resources);
  return{...value,response,raw,before,after:await f.snapshot(),sequence_before:sequence,sequence_after:f.sequence(),started,completed:Math.floor(Date.now()/1000)};
 }
 const create=(input:unknown=purchase(),options:Omit<NonNullable<Parameters<typeof request>[1]>,'method'|'body'>={})=>request('/api/user/member/card/create',{...options,method:'POST',body:input});
 const receipt=(id=UUID,options:NonNullable<Parameters<typeof request>[1]>={})=>request('/api/user/member/card/index?purchase_request='+encodeURIComponent(id),options);
 const pay=(id:string,options:NonNullable<Parameters<typeof request>[1]>={})=>request('/api/user/member/card/pay',{...options,method:'POST',body:options.body??{uni:id,paytype:'yue',from:'weixinh5'}});
 function noWrite(result:Awaited<ReturnType<typeof request>>){expect(result.after).toEqual(result.before);expect(result.sequence_after).toEqual(result.sequence_before);}
 function created(result:Awaited<ReturnType<typeof create>>,plan=11002,uid=11,channel='weixinh5',orderId=derive(uid)){
  expect(result.status,result.msg).toBe(200);expect(result.data).toBeTruthy();const data=result.data!;
  expect(Object.keys(data).sort()).toEqual(['id','order_id','overdue_time','paid','pay_price']);expect(data.order_id).toBe(orderId);expect(String(data.order_id)).toMatch(/^[A-Za-z0-9_-]{2,32}$/u);
  const orders=result.after.other_order.filter(row=>!result.before.other_order.some(old=>old.id===row.id));expect(orders).toHaveLength(1);const order=orders[0]!,term=f.plans.find(row=>row.id===plan)!,free=term.type==='free',permanent=term.type==='ever',account=one(result.before.user,'uid',uid),now=Number(order.add_time);
  expect(now).toBeGreaterThanOrEqual(result.started);expect(now).toBeLessThanOrEqual(result.completed);
  const expiry=permanent?-1:(Number(account.is_money_level)>0&&Number(account.overdue_time)>now?Number(account.overdue_time):now)+term.vipDay*86400;
  expect(data).toEqual({id:order.id,order_id:orderId,pay_price:term.prePrice,paid:free,overdue_time:expiry});
  expect(order).toEqual({id:order.id,store_id:0,staff_id:0,uid,type:free?0:1,order_id:orderId,member_type:String(plan),code:'',pay_type:free?'yue':'',paid:free?1:0,pay_price:Number(term.prePrice),member_price:Number(term.prePrice),pay_time:free?now:0,trade_no:'',channel_type:channel,is_free:free?1:0,is_permanent:permanent?1:0,overdue_time:expiry,is_del:0,vip_day:term.vipDay,add_time:now,money:Number(term.prePrice),remarks:`会员套餐 ${plan}: ${term.title}`});
  const expected=structuredClone(result.before);expected.other_order.push(order);expected.other_order_status.push({oid:order.id,change_type:'create_member_order',change_message:'会员订单生成',shop_type:free?0:1,change_time:now});
  if(free){expected.user=replace(expected.user,'uid',uid,{...account,is_money_level:1,is_ever_level:0,overdue_time:expiry});expected.other_order_status.push({oid:order.id,change_type:'pay_success',change_message:'免费会员领取成功',shop_type:0,change_time:now});}
  expected.__sequences=advance(expected.__sequences,'other_order_id_seq');expect(result.after).toEqual(sortedDiyState(expected));
  if(orderId.startsWith('hy_home_legacy_'))expect(result.sequence_after.allocated-result.sequence_before.allocated).toBe(1);else expect(result.sequence_after).toEqual(result.sequence_before);
  return data;
 }
 it('keeps the default and rights DTO exact while home=1 adds only a server UUID and writes no SQL or owned resource',async()=>{
  const legacy=await request('/api/user/member/card/index');expect(legacy.status,legacy.msg).toBe(200);noWrite(legacy);
  expect(Object.keys(legacy.data!).sort()).toEqual(['is_get_free','member_coupons','member_explain','member_rights','member_type']);
  const home=await request('/api/user/member/card/index?home=1');expect(home.status,home.msg).toBe(200);noWrite(home);expect(home.response.headers.get('cache-control')).toContain('no-store');
  expect(home.data!.purchase_request_id).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u);
  const{purchase_request_id:_id,...original}=home.data!;expect(original).toEqual(legacy.data);expect((home.data!.is_get_free as Row).user_info.uid).toBe(11);
  const rights=await request('/api/user/member/card/index?rights=1');expect(rights.status).toBe(200);noWrite(rights);expect(rights.data!.rights_owner_uid).toBe(11);expect(rights.data).not.toHaveProperty('purchase_request_id');
  expect((home.data!.member_coupons as Row[]).map(row=>row.id)).toEqual([11001,11002,11003,11004]);expect((home.data!.is_get_free as Row).user_info.economize_money).toBe('15.30');
 });
 it('issues independent server UUIDs across reads and owners without allocating a business order',async()=>{
  const ids:string[]=[];for(const uid of[11,11,22]){const result=await request('/api/user/member/card/index?home=1',{uid});expect(result.status).toBe(200);noWrite(result);ids.push(String(result.data!.purchase_request_id));expect((result.data!.is_get_free as Row).user_info.uid).toBe(uid);}expect(new Set(ids).size).toBe(3);
 });
 it.each(['home=0','home=1&home=1','home=1&rights=1','home=1&other=1','purchase_request='+UUID+'&home=1','purchase_request='+UUID+'&purchase_request='+UUID,'purchase_request=NOT-A-UUID','rights=1&purchase_request='+UUID])('rejects explicit query %s before any SQL or sequence mutation',async query=>{const result=await request('/api/user/member/card/index?'+query);expect(result.status).toBe(400);noWrite(result);});
 it('retains ignored legacy index query keys when no explicit view is requested',async()=>{const result=await request('/api/user/member/card/index?legacy_unused=1');expect(result.status).toBe(200);expect(result.data).not.toHaveProperty('purchase_request_id');noWrite(result);});
 it.each([{label:'H5 ordinary',header:'h5',from:'weixinh5',channel:'weixinh5'},{label:'H5 WeChat',header:'h5',from:'weixin',channel:'wechat'},{label:'MP',header:'routine',from:'routine',channel:'routine'},{label:'PHP App',header:'app',from:'weixin',channel:'wechat'}])('creates and exactly replays $label server-priced order with no DO allocation',async row=>{
  const result=await create(purchase(11002,row.from),{form:row.header});created(result,11002,11,row.channel);const replay=await create(purchase(11002,row.from),{form:row.header});expect(replay.status,replay.msg).toBe(200);expect(replay.data).toEqual(result.data);noWrite(replay);
 });
 it('treats missing receipts as unknown, then returns the owner-bound committed original snapshot with no write',async()=>{
  const missing=await receipt();expect(missing.status).toBe(200);expect(missing.data).toEqual({owner_uid:11,request_id:UUID,state:'unknown',order:null});noWrite(missing);
  const original=created(await create()),found=await receipt();expect(found.status).toBe(200);expect(found.data).toEqual({owner_uid:11,request_id:UUID,state:'committed',order:{...original,member_type:11002}});noWrite(found);
  const other=await receipt(UUID,{uid:22});expect(other.data).toEqual({owner_uid:22,request_id:UUID,state:'unknown',order:null});noWrite(other);
 });
 it('same public UUID creates distinct owner-bound orders and never lets a body UID redirect authority',async()=>{
  const first=created(await create()),second=created(await create(purchase(),{uid:22}),11002,22);expect(first.order_id).not.toBe(second.order_id);
  const changed=await create({...purchase(),uid:22});expect(changed.status).toBe(400);noWrite(changed);
 });
 it('preserves the same idempotence mapping after APP_KEY and JWT rotation',async()=>{
  const first=created(await create()),[account]=await f.db.select().from(user).where(eq(user.uid,11)),rotated={...env,APP_KEY:'owned-member-home-rotated-jwt-key'};
  const token=(await createToken(11,'api',md5(account!.pwd),rotated.APP_KEY)).token;
  const replay=await create(purchase(),{environment:rotated,token});expect(replay.status,replay.msg).toBe(200);expect(replay.data).toEqual(first);noWrite(replay);
  const found=await receipt(UUID,{environment:rotated,token});expect(found.data!.order).toEqual({...first,member_type:11002});noWrite(found);
 });
 it.each([{label:'plan',input:purchase(11003)},{label:'normalized channel',input:purchase(11002,'routine')}])('rejects a changed $label for the same request with PHP HTTP200/business409 and zero writes',async row=>{
  created(await create());const result=await create(row.input);expect(result.response.status).toBe(200);expect(result.status).toBe(409);noWrite(result);
 });
 it('accepts the legacy weixin/wechat spelling as the same normalized request channel',async()=>{const first=created(await create(purchase(11002,'weixin')),11002,11,'wechat'),replay=await create(purchase(11002,'wechat'));expect(replay.status).toBe(200);expect(replay.data).toEqual(first);noWrite(replay);});
 it('replays a free claim before free eligibility and never extends the expiry or adds another success status',async()=>{
  const first=created(await create(purchase(11001)),11001);const replay=await create(purchase(11001));expect(replay.status).toBe(200);expect(replay.data).toEqual(first);noWrite(replay);
  const next=await create(purchase(11001,'weixinh5',NEXT));expect(next.status).toBe(400);expect(next.msg).toContain('免费');noWrite(next);
 });
 it('returns the original priced order after plan repricing/deletion, disabled new purchases and a permanent current membership',async()=>{
  const first=created(await create());await f.db.update(memberShip).set({prePrice:'99.00',vipDay:90,isDel:1}).where(eq(memberShip.id,11002));await f.config('member_card_status','0');await f.db.update(user).set({isMoneyLevel:1,isEverLevel:1,overdueTime:0}).where(eq(user.uid,11));
  const replay=await create();expect(replay.status,replay.msg).toBe(200);expect(replay.data).toEqual(first);noWrite(replay);
  const next=await create(purchase(11002,'weixinh5',NEXT));expect(next.status).toBe(400);expect(next.msg).toContain('暂未开启');noWrite(next);
 });
 it('preserves legacy non-request create behavior and its separate DO allocation',async()=>{const first=created(await create({member_type:'11002',from:'h5',price:'0.01',uid:22}),11002,11,'h5','hy_home_legacy_1');const second=created(await create({member_type:11002,from:'h5'}),11002,11,'h5','hy_home_legacy_2');expect(first.order_id).not.toBe(second.order_id);});
 it('reads real vip cashier state, pays once from balance and replays without a second debit, bill, extension or sequence allocation',async()=>{
  const order=created(await create()),id=String(order.order_id),cashier=await request('/api/order/cashier/'+id+'/vip');expect(cashier.status,cashier.msg).toBe(200);expect(cashier.data).toMatchObject({type:'vip',order_id:id,pay_price:'9.90',paid:false,payable:true,methods:{yue:{enabled:true}}});noWrite(cashier);
  const result=await pay(id);expect(result.status,result.msg).toBe(200);expect(result.data).toMatchObject({order_id:id,paid:true,pay_type:'yue'});
  const old=one(result.before.other_order,'order_id',id),account=one(result.before.user,'uid',11),after=one(result.after.other_order,'order_id',id),when=Number(after.pay_time),expiry=when+30*86400;
  expect(result.data!.overdue_time).toBe(expiry);expect(after).toEqual({...old,paid:1,pay_type:'yue',pay_time:when,overdue_time:expiry});
  const expected=structuredClone(result.before);expected.other_order=replace(expected.other_order,'order_id',id,after);expected.user=replace(expected.user,'uid',11,{...account,now_money:90.10,is_money_level:1,is_ever_level:0,overdue_time:expiry});expected.other_order_status.push({oid:old.id,change_type:'pay_success',change_message:'用户付款成功',shop_type:1,change_time:when});
  const bills=result.after.user_bill.filter(row=>!result.before.user_bill.some(old=>old.id===row.id));expect(bills).toHaveLength(1);expect(bills[0]).toEqual({id:bills[0]!.id,uid:11,link_id:id,pm:0,title:'购买会员',category:'now_money',type:'pay_member',event_key:'membership_balance',number:9.90,balance:90.10,mark:'余额支付会员订单 '+id,status:1,add_time:when,take:0,frozen_time:0});expected.user_bill.push(bills[0]!);expected.__sequences=advance(expected.__sequences,'user_bill_id_seq');expect(result.after).toEqual(sortedDiyState(expected));expect(result.sequence_after).toEqual(result.sequence_before);
  const repeated=await pay(id);expect(repeated.status).toBe(200);expect(repeated.data).toMatchObject({order_id:id,paid:true,overdue_time:expiry});noWrite(repeated);
  const replay=await create();expect(replay.data).toEqual({...order,paid:true,overdue_time:expiry});noWrite(replay);
  const found=await receipt();expect(found.data!.order).toEqual({...order,member_type:11002,paid:true,overdue_time:expiry});noWrite(found);
  const settled=await request('/api/order/cashier/'+id+'/vip');expect(settled.data).toMatchObject({paid:true,payable:false,payable_reason:'订单已支付'});noWrite(settled);
 });
 it('settles a permanent plan only once and never charges or extends after its paid replay',async()=>{const order=created(await create(purchase(11004)),11004),paid=await pay(String(order.order_id));expect(paid.status,paid.msg).toBe(400);expect(paid.msg).toContain('余额不足');noWrite(paid);await f.db.update(user).set({nowMoney:'300.00'}).where(eq(user.uid,11));const settled=await pay(String(order.order_id));expect(settled.status,settled.msg).toBe(200);expect(one(settled.after.user,'uid',11)).toMatchObject({now_money:101,is_money_level:1,is_ever_level:1,overdue_time:0});const replay=await create(purchase(11004));expect(replay.data).toEqual({...order,paid:true});noWrite(replay);const repeat=await pay(String(order.order_id));expect(repeat.status).toBe(200);noWrite(repeat);});
 it('rejects insufficient balance and foreign-owner known-order payment without any SQL, ledger or sequence mutation',async()=>{const order=created(await create());await f.db.update(user).set({nowMoney:'0.01'}).where(eq(user.uid,11));const poor=await pay(String(order.order_id));expect(poor.status).toBe(400);expect(poor.msg).toContain('余额不足');noWrite(poor);const other=await pay(String(order.order_id),{uid:22});expect(other.status).toBe(400);noWrite(other);});
 it.each([{label:'duplicate',patch:{},duplicate:true},{label:'other owner',patch:{uid:22}},{label:'card domain',patch:{type:2}},{label:'deleted',patch:{isDel:1}}])('fails closed for a persisted $label instead of creating a replacement or claiming unknown',async row=>{
  created(await create());if(row.duplicate){const[order]=await f.db.select().from(otherOrder).where(eq(otherOrder.orderId,derive(11)));await f.db.insert(otherOrder).values({...order!,id:50001});}else await f.db.update(otherOrder).set(row.patch).where(eq(otherOrder.orderId,derive(11)));
  const replay=await create();expect(replay.status).toBe(409);noWrite(replay);const found=await receipt();expect(found.status).toBe(409);noWrite(found);
 });
 it.each([
  {label:'uppercase UUID',input:purchase(11002,'h5','AAAAAAAA-0000-4000-8000-000000000001')},
  {label:'non-v4 UUID',input:purchase(11002,'h5','71000000-0000-1000-8000-000000000001')},
  {label:'numeric UUID',input:{...purchase(),request_id:11}},
  {label:'string plan',input:{...purchase(),member_type:'11002'}},
  {label:'unbounded plan',input:purchase(2147483648)},
  {label:'unknown price',input:{...purchase(),price:'0.01'}},
  {label:'body app channel',input:purchase(11002,'app')},
  {label:'missing channel',input:{member_type:11002,request_id:UUID}},
  {label:'nested intent',input:{...purchase(),from:{from:'h5'}}},
  {label:'duplicate request',input:'{"member_type":11002,"from":"h5","request_id":"'+UUID+'","request_id":"'+NEXT+'"}'},
  {label:'escaped duplicate',input:'{"member_type":11002,"from":"h5","request_id":"'+UUID+'","request_\\u0069d":"'+NEXT+'"}'},
  {label:'duplicate plan',input:'{"member_type":11002,"member_type":11003,"from":"h5","request_id":"'+UUID+'"}'},
  {label:'modern body over cap',input:JSON.stringify(purchase())+' '.repeat(4096)},
 ])('rejects $label before inserting orders or allocating DO/SQL sequences',async row=>{const result=await create(row.input);expect(result.status,result.msg).toBe(400);noWrite(result);});
 it('binds every explicit read/create to actual live JWT authentication without guest or Admin-role writes',async()=>{
  const[account]=await f.db.select().from(user).where(eq(user.uid,11)),admin=(await createToken(11,'admin',md5(account!.pwd),env.APP_KEY)).token;
  for(const token of['',admin])for(const action of[()=>request('/api/user/member/card/index?home=1',{token}),()=>receipt(UUID,{token}),()=>create(purchase(),{token})]){const result=await action();expect(result.status).toBeGreaterThan(400);noWrite(result);}
 });
 it('selects the actual App profile from Form-type=app with PHP body weixin and refuses missing App configuration before provider/accounting writes',async()=>{
  const order=created(await create(purchase(11002,'weixin'),{form:'app'}),11002,11,'wechat');
  for(const[key,value]of Object.entries({pay_weixin_open:'1',pay_weixin_mchid:'1900000109',pay_weixin_serial_no:'AB12CD34',site_url:'https://member.example.invalid',wechat_appid:'wx-owned-public',routine_appId:'wx-owned-routine',wechat_app_appid:''}))await f.config(key,value);
  env={...env,WECHAT_MCH_PRIVATE_KEY:'owned-unused-private-key',WECHAT_API_V3_KEY:'x'.repeat(32),WECHAT_PLATFORM_PUBLIC_KEY:'-----BEGIN PUBLIC KEY-----\\nowned-unused\\n-----END PUBLIC KEY-----'};
  const result=await pay(String(order.order_id),{form:'app',body:{uni:order.order_id,paytype:'weixin',from:'weixin'}});expect(result.status,result.msg).toBe(400);expect(result.msg).toBe('App AppID 未配置');noWrite(result);expect(network).not.toHaveBeenCalled();
  const invalid=await pay(String(order.order_id),{form:'app',body:{uni:order.order_id,paytype:'weixin',from:'app'}});expect(invalid.status).toBe(400);expect(invalid.msg).toBe('非法渠道');noWrite(invalid);
 });
 it('forwards real explicit VIP recommendation pages, excludes invisible identities and keeps the old unpaged DTO',async()=>{
  const ids:number[]=[];for(const page of[1,2,3,4]){const result=await request('/api/groom/list/5?page='+page+'&limit=10');expect(result.status,result.msg).toBe(200);expect(Object.keys(result.data!).sort()).toEqual(['banner','list']);expect(result.data!.banner).toEqual([]);for(const row of result.data!.list as Row[])expect(row.image).toMatch(/^\/api\/assets\/[1-9]\d*\?expires=\d+&signature=[A-Za-z0-9_-]+$/u);const pageIds=(result.data!.list as Row[]).map(row=>Number(row.id));expect(pageIds).toHaveLength(page<3?10:page===3?4:0);ids.push(...pageIds);noWrite(result);}
  expect(ids).toEqual(f.products.map(row=>row.id));expect(new Set(ids).size).toBe(24);expect(ids.every(id=>id<12031)).toBe(true);
  const legacy=await request('/api/groom/list/5');expect(legacy.status,legacy.msg).toBe(200);expect((legacy.data!.list as Row[]).map(row=>Number(row.id))).toEqual(ids);noWrite(legacy);
 });
 it.each([{label:'wrong attachment owner',patch:{type:2,relationId:999}},{label:'wrong media module',patch:{moduleType:2}},{label:'contradictory MIME',patch:{attType:'image/svg+xml'}}])('never signs VIP recommendation images with $label',async row=>{
  const id=Number(f.platformImage.url.split('/').at(-1));await f.db.update(systemAttachment).set(row.patch).where(eq(systemAttachment.attId,id));
  const result=await request('/api/groom/list/5?page=1&limit=10');expect(result.status,result.msg).toBe(200);expect((result.data!.list as Row[]).map(row=>row.image)).toEqual(Array(10).fill(''));noWrite(result);
 });
 it('reads an actually card-activated membership level 2 in home without coercing its original value or writing state',async()=>{await f.db.update(user).set({isMoneyLevel:2,overdueTime:Math.floor(Date.now()/1000)+7*86400}).where(eq(user.uid,11));const result=await request('/api/user/member/card/index?home=1');expect(result.status,result.msg).toBe(200);expect((result.data!.is_get_free as Row).user_info.is_money_level).toBe(2);noWrite(result);});
 it.each(['page=0&limit=10','page=1&limit=101','page=1.5&limit=10','page=9007199254740992&limit=10','page=1&page=2&limit=10','page=1&limit=10&unknown=1'])('rejects explicit VIP pagination %s before business mutation',async query=>{const result=await request('/api/groom/list/5?'+query);expect(result.status).toBe(400);noWrite(result);});
 it('observes two native user-row waiter paths, then commits one order and exactly replays the other while an inflight receipt stays unknown',async()=>{
  if(!process.env.TEST_FINANCE_POSTGRES_URL){const first=created(await create()),again=await create();expect(again.data).toEqual(first);noWrite(again);return;}
  await withFinancePeers(f.db,async([holder,a,b])=>{
   await holder.exec('BEGIN');let held=true;const work:Array<Promise<{ok:true;value:Awaited<ReturnType<typeof create>>}|{ok:false;error:unknown}>>=[];
   try{
    await holder.exec('SELECT uid FROM "user" WHERE uid=11 FOR UPDATE');const before=await f.snapshot(),resources=f.resources(),sequence=f.sequence();
    work.push(outcome(create(purchase(),{container:createContainerFromDb(a.db)})),outcome(create(purchase(),{container:createContainerFromDb(b.db)})));
    const proof=await blocked(f.db,[a.pid,b.pid],holder.pid);console.log('MEMBERSHIP_PURCHASE_NATIVE_BLOCKERS '+JSON.stringify(proof));
    const pending=await receipt();expect(pending.data).toEqual({owner_uid:11,request_id:UUID,state:'unknown',order:null});noWrite(pending);expect(await f.snapshot()).toEqual(before);
    await holder.exec('COMMIT');held=false;const results=await Promise.all(work);expect(results.every(row=>row.ok)).toBe(true);const values=results.map(row=>{if(!row.ok)throw row.error;return row.value;});
    expect(values.map(row=>row.status)).toEqual([200,200]);expect(values[0]!.data).toEqual(values[1]!.data);expect(f.resources()).toEqual(resources);expect(f.sequence()).toEqual(sequence);
    created({...values[0]!,before,after:await f.snapshot(),sequence_before:sequence,sequence_after:f.sequence()});
    const result=await receipt();expect(result.data!.state).toBe('committed');noWrite(result);
   }finally{if(held)await holder.exec('ROLLBACK');await Promise.all(work);}
  });
 },20000);
});
