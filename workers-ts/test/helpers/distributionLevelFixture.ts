import { randomUUID, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { eq, inArray, sql } from 'drizzle-orm';
import { expect, vi } from 'vitest';
import type { Env } from '@/env';
import { createContainerFromDb } from '@/lib/di';
import { createToken, md5 } from '@/utils/jwt';
import { agentLevel, agentLevelTask, agentLevelTaskRecord, storeOrder, storeProduct, storeProductAttrValue,
  storeBargain, storeBrand, storeProductLabel, systemAttachment, systemConfig, user } from '@/models/schema';
import { installRuntimeAgentLevelCatalogBoundaryInTransaction } from '@/migrations/runtimeAgentLevelCatalogBoundary';
import { refundRuntimeFixture } from './refundRuntimeFixture';
import { sortedDiyState, type DiyStateSnapshot, type DiyStateRow as Row } from './diyStateFixture';

export const DISTRIBUTOR = { a:660011,b:660012,parent:660021,grand:660031,down1:660041,down2:660042,unrelated:660099,
  first:660101,next:660102,empty:660103,gift:660105,media:660201,bargain:660401,product:660301 } as const;
export const distributorImageKey='attachments/admin/1/2026/10/66000000-0000-4000-8000-000000000001.png';
const ids=DISTRIBUTOR, ownedUsers=[ids.a,ids.b,ids.parent,ids.grand,ids.down1,ids.down2,ids.unrelated];
/** Read closure of evaluator, hot projection, normal/bargain detail, finance,
 * theme and invitation targets. The full snapshot uses maintenance, never App.
 * These SELECT grants contain no other financial, configuration or write power. */
export const DISTRIBUTION_APP_READ_TABLES=[
 'agent_level','agent_level_task','agent_level_task_record','user','store_order','system_config','system_attachment',
 'user_level','system_user_level','member_right','store_product','store_brand','store_product_label','store_product_relation',
 'store_promotions','store_promotions_auxiliary','store_product_attr','store_product_attr_value','store_product_attr_result','store_product_category',
 'store_activity','store_bargain','store_bargain_user','store_bargain_user_help','store_combination','store_seckill','store_seckill_time','store_newcomer',
 'store_discounts','store_discounts_products','store_product_description','store_product_ensure','store_product_reply','store_product_reply_comment',
 'community','community_relevance','user_relation','store_cart','system_dise','system_group','system_group_data','system_form','wechat_user',
 'user_brokerage','user_bill','user_extract','user_money','user_spread','user_friends','system_store','system_supplier','store_coupon_issue','store_coupon_product',
 'store_product_log','store_visit'
].sort();
export type DistributionScenario='normal'|'hidden'|'deleted'|'max'|'zero'|'disabled'|'missing'|'restored'|'empty-hot'|'restore-hot'|'rollback';
const id=(value:string)=>{if(!/^[a-z_][a-z_0-9]*$/.test(value))throw Error('Invalid owned distributor identifier');return '"'+value+'"';};
const one=(rows:Row[],key:string,value:unknown)=>{const found=rows.filter(r=>r[key]===value);expect(found).toHaveLength(1);return found[0]!;};
const cents=(value:unknown)=>{const raw=String(value);expect(raw).toMatch(/^\d+(?:\.\d{1,2})?$/);const[w,f='']=raw.split('.');return BigInt(w)*100n+BigInt(f.padEnd(2,'0'));};
const scalar=(value:unknown)=>{let raw=String(value??'').trim();try{raw=String(JSON.parse(raw));}catch{}return raw;};
function serial(expected:DiyStateSnapshot,name:string){const row=one(expected.__sequences,'name',name),next=BigInt(row.last)+(row.called?1n:0n);row.last=String(next);row.called=true;return Number(next);}

/** Independent raw-row oracle. Never invokes the production plan/progress code. */
export function distributionEvaluationPlan(before:DiyStateSnapshot,uid:number,at:number){
 const config=(name:string,fallback:string)=>scalar(before.system_config.filter(r=>r.is_store===0&&r.menu_name===name).sort((a,b)=>b.sort-a.sort||b.id-a.id)[0]?.value??fallback);
 if(config('brokerage_func_status','0')!=='1')return{users:[] as number[],ranks:[] as {uid:number;level:number}[],records:[] as Row[],failure:false};
 const policy={self:config('is_self_brokerage','0')==='1',mode:Number(config('store_brokerage_binding_status','1')),days:Number(config('store_brokerage_binding_time','30'))};
 const account=(value:number)=>before.user.find(r=>r.uid===value&&r.is_del===0);
 const parent=(value:number)=>{const row=account(value);return row&&([1,3].includes(policy.mode)||policy.mode===2&&row.spread_time+policy.days*86400>at)?row.spread_uid:0;};
 const first=policy.self?uid:parent(uid),second=first>0?parent(first):0;
 const users=[...new Set([uid,first,second].filter(x=>Number.isSafeInteger(x)&&x>0))].sort((a,b)=>a-b);expect(users.length).toBeLessThanOrEqual(3);
 const levels=before.agent_level.filter(r=>r.status===1&&r.is_del===0).sort((a,b)=>a.grade-b.grade||b.id-a.id);
 const ranks:{uid:number;level:number}[]=[],records:Row[]=[];
 const tasks=before.agent_level_task.filter(r=>r.status===1&&r.is_del===0).sort((a,b)=>a.level_id-b.level_id||b.sort-a.sort||b.id-a.id);
 for(const target of users){const row=account(target);if(!row)continue;
  const assigned=before.agent_level.find(r=>r.id===row.agent_level),grade=assigned?.grade??0;
  if(row.agent_level>0&&!assigned||levels.some((r,i)=>i>0&&levels[i-1].grade===r.grade))return{users,ranks,records,failure:true};
  const valid=before.store_order.filter(r=>r.paid===1&&r.pid===0&&[0,3].includes(r.refund_status)&&r.is_del===0&&r.is_system_del===0);
  const own=valid.filter(r=>r.uid===target),down=valid.filter(r=>before.user.some(u=>u.uid===r.uid&&u.spread_uid===target));
  const values=[0n,BigInt(before.user.filter(u=>u.spread_uid===target).length),own.reduce((n,r)=>n+cents(r.pay_price),0n),BigInt(own.length),down.reduce((n,r)=>n+cents(r.pay_price),0n),BigInt(down.length)];
  const done=new Set(before.agent_level_task_record.filter(r=>r.uid===target).map(r=>r.level_id+':'+r.task_id)),pending:Row[]=[];let next=row.agent_level,failed=false;
  for(const level of levels){if(level.grade<=grade)continue;const requirements=tasks.filter(t=>t.level_id===level.id);if(!requirements.length)continue;
   for(const task of requirements){const key=level.id+':'+task.id;if(done.has(key))continue;
    if(![1,2,3,4,5].includes(task.type)||!Number.isSafeInteger(task.number)||task.number<=0){failed=true;break;}
    const threshold=BigInt(task.number)*([2,4].includes(task.type)?100n:1n);if(values[task.type]<threshold)continue;
    pending.push({uid:target,level_id:level.id,task_id:task.id});done.add(key);
   }
   if(failed)break;if(!requirements.every(task=>done.has(level.id+':'+task.id)))break;next=level.id;
  }
  if(failed)return{users,ranks,records,failure:true};records.push(...pending);if(next!==row.agent_level)ranks.push({uid:target,level:next});
 }
 return{users,ranks,records,failure:false};
}
export function assertDistributionEvaluation(before:DiyStateSnapshot,after:DiyStateSnapshot,uid:number,start:number,end:number){
 const plan=distributionEvaluationPlan(before,uid,Math.floor(start/1000)),expected=structuredClone(before),added:Row[]=[];
 // A plan is computed per account before its inserts. Earlier accounts may have
 // allocated sequence IDs before a later account fails and the transaction rolls back.
 for(const record of plan.records){const recordId=serial(expected,'agent_level_task_record_id_seq');
  if(!plan.failure){const actual=one(after.agent_level_task_record,'id',recordId),at=actual.add_time;expect(at).toBeGreaterThanOrEqual(Math.floor(start/1000));expect(at).toBeLessThanOrEqual(Math.floor(end/1000));
   const value={id:recordId,...record,status:0,add_time:at};expect(actual).toEqual(value);expected.agent_level_task_record.push(value);added.push(value);}
 }
 if(!plan.failure)for(const rank of plan.ranks)one(expected.user,'uid',rank.uid).agent_level=rank.level;
 expect(after).toEqual(sortedDiyState(expected));return{kind:plan.failure?'evaluation-rollback-with-serial-allocation':'evaluation-get',owner:uid,evaluated_users:plan.users,
  expected_upgrades:plan.failure?[]:plan.ranks,new_records:added,attempted_record_allocations:plan.records.length,failure:plan.failure};
}
export function assertDistributionVisit(before:DiyStateSnapshot,after:DiyStateSnapshot,uid:number,productId:number,start:number,end:number){
 const expected=structuredClone(before),logId=serial(expected,'store_product_log_id_seq'),actual=one(after.store_product_log,'id',logId),at=actual.add_time;
 expect(at).toBeGreaterThanOrEqual(Math.floor(start/1000));expect(at).toBeLessThanOrEqual(Math.floor(end/1000));
 expected.store_product_log.push({id:logId,type:'visit',product_id:productId,uid,visit_num:1,cart_num:0,order_num:0,pay_num:0,pay_price:0,cost_price:0,pay_uid:0,refund_num:0,refund_price:0,collect_num:0,add_time:at,delete_time:null});
 const existing=expected.store_visit.filter(r=>r.uid===uid&&r.product_id===productId&&r.product_type==='product').sort((a,b)=>b.id-a.id)[0];
 if(!existing)expected.store_visit.push({id:serial(expected,'store_visit_id_seq'),product_id:productId,product_type:'product',cate_id:productId,type:'view'.padEnd(50,' '),uid,count:1,content:'',add_time:at});
 else if(existing.add_time+20<at)Object.assign(existing,{count:existing.count+1,cate_id:productId,add_time:at});
 expect(after).toEqual(sortedDiyState(expected));return{kind:'ordinary-detail-visit',owner:uid,product_id:productId,log_id:logId,at};
}
export async function distributionLevelFixture(){
 const f=await refundRuntimeFixture();
 try{
  const tables=(await f.exec("SELECT tablename AS name FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).map(r=>String(r.name));
  const sequences=(await f.exec("SELECT sequencename AS name FROM pg_sequences WHERE schemaname='public' ORDER BY sequencename")).map(r=>String(r.name));
  expect(tables).toHaveLength(283);expect(sequences).toHaveLength(229);[...tables,...sequences].forEach(id);
  const snapshot=async()=>{const s:DiyStateSnapshot={};for(const r of await f.db.execute<{name:string;rows:Row[]}>(sql.join(tables.map(name=>sql`SELECT ${name}::text AS name,coalesce(jsonb_agg(to_jsonb(t)),'[]'::jsonb) AS rows FROM ${sql.identifier(name)} t`),sql` UNION ALL `)))s[r.name]=r.rows;
   s.__sequences=await f.db.execute(sql.join(sequences.map(name=>sql`SELECT ${name}::text AS name,last_value::text AS last,is_called AS called FROM ${sql.identifier(name)}`),sql` UNION ALL `));return sortedDiyState(s);};
  const before=await snapshot(),now=Math.floor(Date.now()/1000),password=md5('synthetic-distribution-level-'+randomUUID()),png=await readFile(resolve(import.meta.dirname,'../../../view/uniapp-ts/src/static/php-distribution-level/agent_level_2.png'));
  const objects=new Map<string,{bytes:Uint8Array;type:string}>([[distributorImageKey,{bytes:png,type:'image/png'}]]),assetReads:Row[]=[],kvReads:Row[]=[];
  const forbidden=vi.fn(()=>{throw Error('Distributor proof forbids provider/queue/resource writes');});
  const appKey=randomUUID()+randomUUID(),tokens=new Map<number,string>(),productIds=Array.from({length:23},(_,i)=>ids.product+i),image='/api/assets/'+ids.media;
  await f.db.insert(user).values(ownedUsers.map(uid=>({uid,pwd:password,nickname:uid===ids.a?'PHP分销自然升级':uid===ids.b?'PHP历史赠予等级':'关联账户'+uid,avatar:'/static/logo.png',status:1,isDel:0,isPromoter:1,spreadOpen:1,
   agentLevel:uid===ids.b?ids.gift:0,spreadUid:uid===ids.a?ids.parent:uid===ids.parent?ids.grand:[ids.down1,ids.down2].includes(uid as typeof ids.down1)?ids.a:0,spreadTime:now,level:0,levelStatus:0,exp:'0.00'})));
  await f.db.delete(agentLevelTaskRecord);await f.db.delete(agentLevelTask);await f.db.delete(agentLevel);
  await f.db.insert(agentLevel).values([
   {id:ids.first,name:'PHP初级分销',grade:1,image,color:'#D97E1D',oneBrokerage:20,twoBrokerage:10},
   {id:ids.next,name:'PHP进阶分销',grade:2,image,color:'#CA6541',oneBrokerage:30,twoBrokerage:15},
   {id:ids.empty,name:'PHP无任务等级',grade:3,image,color:'#6859A3',oneBrokerage:40,twoBrokerage:20},
   {id:ids.gift,name:'PHP赠予隐藏等级',grade:5,image,color:'#3377AA',oneBrokerage:50,twoBrokerage:25,status:0},
  ]);
  await f.db.insert(agentLevelTask).values([...Array.from({length:5},(_,i)=>({id:660501+i,levelId:ids.first,type:i+1,number:[1,100,2,50,2][i],name:['邀请好友成为下级','自身消费金额','自身消费单数','下级消费金额','下级消费单数'][i],sort:50-i,isMust:0})),
   {id:660511,levelId:ids.next,type:2,number:101,name:'自身消费满101元',sort:1,isMust:0},
   {id:660512,levelId:ids.next,type:1,number:3,name:'邀请三位好友',sort:0,isMust:0}]);
  await f.db.insert(storeOrder).values([[660601,ids.a,'99.99',0],[660602,ids.a,'0.01',3],[660603,ids.down1,'25.01',0],[660604,ids.down2,'24.99',3]].map(([orderId,uid,payPrice,refundStatus])=>({id:Number(orderId),uid:Number(uid),orderId:'distributor-native-'+orderId,unique:'distributor-native-'+orderId,payPrice:String(payPrice),paid:1,pid:0,refundStatus:Number(refundStatus),isDel:0,isSystemDel:0})));
  await f.db.insert(systemAttachment).values({attId:ids.media,name:distributorImageKey,type:1,relationId:0,moduleType:1,fileType:1,imageType:8,attDir:image,sattDir:image,attType:'image/png',attSize:String(png.length)});
  const settings={brokerage_func_status:'1',is_self_brokerage:'0',store_brokerage_binding_status:'1',store_brokerage_binding_time:'30',
   store_brokerage_statu:'1',brokerage_level:'2',store_brokerage_ratio:'5',store_brokerage_two:'3',division_status:'0',
   member_func_status:'0',member_card_status:'0',svip_price_status:'0',level_activate_status:'0',station_open:'1',site_name:'"分销等级真实验收"'};
  const configCache=new Map<string,string>();
  const cache=async()=>{configCache.clear();for(const r of(await f.db.select().from(systemConfig)).filter(r=>r.isStore===0).sort((a,b)=>b.sort-a.sort||b.id-a.id))if(!configCache.has(r.menuName))configCache.set(r.menuName,String(r.value??''));};
  for(const[menuName,value]of Object.entries(settings)){await f.db.update(systemConfig).set({value,sort:30000,isStore:0}).where(eq(systemConfig.menuName,menuName));const found=await f.db.select().from(systemConfig).where(eq(systemConfig.menuName,menuName));if(!found.length)await f.db.insert(systemConfig).values({menuName,value,sort:30000,isStore:0});}
  await f.db.update(storeProduct).set({isHot:0});
  // Deliberately unequal rendered cards expose shared grid-row gaps: the first
  // hot card stays short; the next has a two-line title and wrapped labels.
  await f.db.insert(storeBrand).values({id:660801,brandName:'原版品牌'});
  await f.db.insert(storeProductLabel).values([
   {id:660802,labelName:'原版推荐长标签',styleType:1,color:'#A74D16',bgColor:'#FFF3E6',borderColor:'#D97E1D'},
   {id:660803,labelName:'分销好物精选标签',styleType:1,color:'#A74D16',bgColor:'#FFF3E6',borderColor:'#D97E1D'},
  ]);
  await f.db.insert(storeProduct).values(productIds.map((productId,i)=>({id:productId,type:0,relationId:0,
   storeName:i===21?'PHP分销推荐商品22长标题展示两行与标签自然换行的独立瀑布列':'PHP分销推荐商品'+String(i+1).padStart(2,'0'),
   brandId:i===21?660801:0,storeLabelId:i===21?'660802,660803':i%4===0?'660802':'',
   image,sliderImage:JSON.stringify([image]),price:'12.30',otPrice:'20.00',vipPrice:'0.00',isVip:0,stock:100,isShow:1,isDel:0,isVerify:1,sort:1000,isHot:1,activity:i===21?'2,0':'0'})));
  await f.db.insert(storeProductAttrValue).values(productIds.map((productId,i)=>({id:660701+i,productId,unique:'dd'+productId,suk:'默认',type:0,price:'12.30',otPrice:'20.00',stock:100,image})));
  await f.db.insert(storeBargain).values({id:ids.bargain,productId:ids.product+21,type:0,relationId:0,status:1,isDel:0,storeName:'PHP分销推荐砍价',title:'PHP分销推荐砍价',image,images:JSON.stringify([image]),price:'12.30',minPrice:'1.00',stock:100,quota:100,people:1,
   startTime:new Date((now-86400)*1000),stopTime:new Date((now+86400)*1000)});
  await f.db.insert(storeProductAttrValue).values({id:660724,productId:ids.bargain,unique:'db660401',suk:'默认',type:2,price:'12.30',stock:100,quota:100,image});
  await cache();for(const uid of[ids.a,ids.b])tokens.set(uid,(await createToken(uid,'api',md5(password),appKey)).token);
  const resources=()=>({forbidden:forbidden.mock.calls.length,objects:[...objects].map(([key,v])=>({key,bytes:v.bytes.length,type:v.type,sha256:createHash('sha256').update(v.bytes).digest('hex')})).sort((a,b)=>a.key.localeCompare(b.key))});
  async function control(scenario:DistributionScenario){
   const before=await snapshot(),expected=structuredClone(before),resourceBefore=resources();
   if(['normal','hidden','deleted','max','zero'].includes(scenario)){
    const state=scenario==='hidden'?{status:0,is_del:0}:scenario==='deleted'?{status:1,is_del:1}:{status:0,is_del:0};
    await f.db.update(agentLevel).set({status:state.status,isDel:state.is_del}).where(eq(agentLevel.id,ids.gift));Object.assign(one(expected.agent_level,'id',ids.gift),state);
    const level=scenario==='normal'?ids.first:scenario==='zero'?ids.empty:ids.gift;
    await f.db.update(user).set({agentLevel:level}).where(eq(user.uid,ids.b));one(expected.user,'uid',ids.b).agent_level=level;
   }else if(scenario==='disabled'){
    await f.db.update(systemConfig).set({value:'0'}).where(eq(systemConfig.menuName,'brokerage_func_status'));for(const r of expected.system_config)if(r.menu_name==='brokerage_func_status')r.value='0';
   }else if(scenario==='empty-hot'||scenario==='restore-hot'){
    const hot=scenario==='empty-hot'?0:1;await f.db.update(storeProduct).set({isHot:hot}).where(inArray(storeProduct.id,productIds));for(const r of expected.store_product)if(productIds.includes(r.id))r.is_hot=hot;
   }else if(scenario==='missing')objects.delete(distributorImageKey);
   else if(scenario==='restored')objects.set(distributorImageKey,{bytes:png,type:'image/png'});
   else if(scenario==='rollback'){
    await f.db.delete(agentLevelTaskRecord);expected.agent_level_task_record=[];
    await f.db.update(user).set({agentLevel:0}).where(inArray(user.uid,[ids.a,ids.parent,ids.grand]));for(const r of expected.user)if([ids.a,ids.parent,ids.grand].includes(r.uid))r.agent_level=0;
    await f.db.update(agentLevelTask).set({status:0});for(const r of expected.agent_level_task)r.status=0;
    await f.db.insert(agentLevelTask).values([{id:660521,levelId:ids.first,type:1,number:1,name:'回滚前可完成',status:1},{id:660522,levelId:ids.next,type:0,number:-1,name:'后置异常',status:1}]);
    // ORM defaults are compared independently, including is_must/status/add_time.
    expected.agent_level_task.push(...[{id:660521,level_id:ids.first,type:1,number:1,name:'回滚前可完成'},{id:660522,level_id:ids.next,type:0,number:-1,name:'后置异常'}].map(r=>({...r,desc:'',is_must:0,sort:0,status:1,is_del:0,add_time:0})));
    const inserted=await f.db.insert(agentLevelTaskRecord).values({uid:ids.a,levelId:ids.next,taskId:660522,status:0,addTime:now}).returning();
    const recordId=serial(expected,'agent_level_task_record_id_seq');expect(inserted[0].id).toBe(recordId);expected.agent_level_task_record.push({id:recordId,uid:ids.a,level_id:ids.next,task_id:660522,status:0,add_time:now});
   }
   await cache();const after=await snapshot();expect(after).toEqual(sortedDiyState(expected));return{kind:'qa-finite-distributor-fixture',nonproof:true,scenario,before,after,resources_before:resourceBefore,resources_after:resources()};
  }
  async function withApplication<T>(run:(runtime:{env:Env;container:ReturnType<typeof createContainerFromDb>;role:string;pid:number;identities:Row[]})=>Promise<T>){
   return f.withRuntimeRole!(app=>f.withRuntimeRole!(async admin=>{
    await f.db.transaction(tx=>installRuntimeAgentLevelCatalogBoundaryInTransaction(tx,{maintenance:'finance_test',app:app.role,admin:admin.role}));
    for(const table of DISTRIBUTION_APP_READ_TABLES){expect(tables).toContain(table);await f.exec('GRANT SELECT ON public.'+id(table)+' TO '+id(app.role));}
    await f.exec('GRANT UPDATE(agent_level) ON public.user TO '+id(app.role));
    await f.exec('GRANT INSERT ON public.agent_level_task_record,public.store_product_log,public.store_visit TO '+id(app.role));
    await f.exec('GRANT UPDATE(id,count,cate_id,add_time) ON public.store_visit TO '+id(app.role));
    for(const sequence of['agent_level_task_record_id_seq','store_product_log_id_seq','store_visit_id_seq'])await f.exec('GRANT USAGE ON SEQUENCE public.'+id(sequence)+' TO '+id(app.role));
    const[identity]=await app.exec("SELECT current_user AS role,session_user AS session,pg_backend_pid() AS pid,current_setting('server_version_num') AS version,rolsuper,rolinherit,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls,rolcanlogin FROM pg_roles WHERE rolname=current_user");
    expect(identity.role).toBe(app.role);expect(identity.session).toBe(app.role);expect(identity.pid).toBe(app.pid);expect(identity.rolcanlogin).toBe(true);expect(Math.floor(Number(identity.version)/10000)).toBe(16);
    for(const name of['rolsuper','rolinherit','rolcreatedb','rolcreaterole','rolreplication','rolbypassrls'])expect(identity[name]).toBe(false);
    const reads=await app.exec("SELECT table_name FROM information_schema.role_table_grants WHERE grantee=current_user AND privilege_type='SELECT' ORDER BY table_name");
    expect(reads).toEqual(DISTRIBUTION_APP_READ_TABLES.map(table_name=>({table_name})));
    const grants=await app.exec("SELECT table_name,privilege_type FROM information_schema.role_table_grants WHERE grantee=current_user AND privilege_type<>'SELECT' ORDER BY table_name,privilege_type");
    expect(grants).toEqual(['agent_level_task_record','store_product_log','store_visit'].map(table_name=>({table_name,privilege_type:'INSERT'})));
    const columns=await app.exec("SELECT table_name,column_name FROM information_schema.role_column_grants WHERE grantee=current_user AND privilege_type='UPDATE' ORDER BY table_name,column_name");
    expect(columns).toEqual(['add_time','cate_id','count','id'].map(column_name=>({table_name:'store_visit',column_name})).concat([{table_name:'user',column_name:'agent_level'}]));
    const seqs:string[]=[];for(const name of sequences){const[r]=await app.db.execute<{allowed:boolean}>(sql`SELECT has_sequence_privilege(current_user,${'public.'+name},'USAGE,SELECT,UPDATE') AS allowed`);if(r.allowed)seqs.push(name);}
    expect(seqs).toEqual(['agent_level_task_record_id_seq','store_product_log_id_seq','store_visit_id_seq']);
    const env={...f.env,APP_KEY:appKey,NODE_ENV:'test',UPSTASH_REDIS_URL:'',UPSTASH_REDIS_TOKEN:'',HYPERDRIVE:{connectionString:app.connectionString},
     CONFIG_KV:{get:async(key:string)=>{kvReads.push({key,at_ms:Date.now()});return key.startsWith('cfg_')?(configCache.get(key.slice(4))??''):null;},put:forbidden,delete:forbidden,list:forbidden},
     ASSETS_BUCKET:{get:async(key:string)=>{const value=objects.get(key);assetReads.push({key,found:!!value,at_ms:Date.now(),bytes:value?.bytes.length??0});if(!value)return null;const bytes=Uint8Array.from(value.bytes),etag=createHash('sha256').update(bytes).digest('hex');return{size:bytes.length,etag,httpEtag:'"'+etag+'"',body:new Response(bytes).body,httpMetadata:{contentType:value.type},writeHttpMetadata:(h:Headers)=>h.set('Content-Type',value.type)};},put:forbidden,delete:forbidden,head:forbidden,list:forbidden},
     ORDER_QUEUE:{send:forbidden,sendBatch:forbidden},TOKEN_BUCKET:undefined,SEQUENCE:{idFromName:forbidden,get:forbidden},IMAGES:{input:forbidden}}as unknown as Env;
    return run({env,container:createContainerFromDb(app.db),role:app.role,pid:app.pid,identities:[{...identity,select_tables:reads,table_grants:grants,column_updates:columns,sequence_permissions:seqs}]});
   }));
  }
  return{...f,tables,sequences,tokens,png,objects,assetReads,kvReads,resources,forbidden,snapshot,control,withApplication,productIds,
   setup:{before,after:await snapshot(),seconds:now,owned_users:ownedUsers,product_ids:productIds,image_id:ids.media,expected_page_sizes:[10,10,3],shopping_membership_enabled:false}};
 }catch(error){await f.close();throw error;}
}

