import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {eq,sql} from 'drizzle-orm';
import {systemRole,storeProductRule,storeProduct,systemLog} from '@/models/schema';
import {AdminRuleAuthorService} from '@/services/admin/AdminRuleAuthorService';
import {AdminProductRuleService} from '@/services/admin/AdminProductRuleService';
import {ruleActionHash} from '@/services/admin/AdminRuleAuthorInput';
import {createAdminRuleAuthorFixture} from './helpers/adminRuleAuthorFixture';
import {seedRules,ruleActor,ruleBody} from './helpers/adminProductRules';
import {ruleProjection,type RuleAction,type RuleOperation} from '../../view/common/ruleAuthor';
const query=new URLSearchParams();
describe('recoverable platform SKU templates: full raw source and explicit whole replacement',()=>{
 let f:Awaited<ReturnType<typeof createAdminRuleAuthorFixture>>,service:AdminRuleAuthorService;
 beforeAll(async()=>{f=await createAdminRuleAuthorFixture();service=new AdminRuleAuthorService(f.container);vi.spyOn(globalThis,'fetch').mockRejectedValue(Error('Rule author forbids external I/O'));},30000);
 beforeEach(async()=>{await f.reset();await seedRules(f.db);await f.exec("SELECT setval('public.store_product_rule_id_seq',100,false)");});
 afterAll(async()=>{try{expect(fetch).not.toHaveBeenCalled();}finally{vi.restoreAllMocks();await f?.close();}});
 const catalog=(id=101)=>f.asAdmin(()=>service.catalog(query,ruleActor(id)));
 async function intent(operation:RuleOperation,target_id=11,payload:Record<string,unknown>={},actor_id=101):Promise<RuleAction>{const a={operation_id:crypto.randomUUID(),actor_id,operation,target_id,revision:(await catalog()).revision,payload};return {...a,payload_hash:ruleActionHash(a)};}
 const mutate=(a:RuleAction)=>f.asAdmin(()=>service.mutate(a,ruleActor(a.actor_id)));
 const replace=(patch={})=>({rule_name:'新规格',mode:'replace',spec:ruleBody().spec,...patch});
 async function snapshot(){return {rules:await f.db.select().from(storeProductRule).orderBy(storeProductRule.id),products:await f.db.select().from(storeProduct).orderBy(storeProduct.id),logs:await f.db.select().from(systemLog).orderBy(systemLog.id),receipts:Array.from(await f.db.execute(sql`SELECT * FROM public.admin_rule_operation ORDER BY operation_id`))};}
 async function unchanged(run:()=>Promise<unknown>){const before=await snapshot();try{return await run();}finally{expect(await snapshot()).toEqual(before);}}
 it('reads every platform raw value without leaking private owner rows or row versions',()=>unchanged(async()=>{const c=await catalog(106);expect(c).toMatchObject({count:2,write_ready:true,can_create:true,list:[{id:11,rule_name:'包装'},{id:10,rule_name:'服装'}]});expect(c.list.every(row=>Object.keys(row).join(',')==='id,type,relation_id,rule_name,rule_value')).toBe(true);expect(JSON.stringify(c)).not.toMatch(/rowVersion|供应商|异常平台|pwd/);}));
 const rawHistory=[null,'','0','null','false','[]','{}','{broken','[{"value":"颜色","detail":["红"],"unknown":{"keep":true}}]','[{"value":"颜色","detail":["红",7]}]','[{"value":"颜色","detail":["红","红"]}]',JSON.stringify(Array.from({length:4},(_,i)=>({value:String(i),detail:['x']}))),' [ { "detail" : [" 红 ","蓝"], "value" : " 颜色 " } ] '];
 for(const raw of rawHistory)it('preserves exact raw history on read, no-op and name-only save '+JSON.stringify(raw),async()=>{
  await f.db.update(storeProductRule).set({ruleValue:raw}).where(eq(storeProductRule.id,11));const before=await catalog();
  expect(before.list.find(row=>row.id===11)?.rule_value).toBe(raw);
  await mutate(await intent('update',11,{rule_name:'包装',mode:'preserve'}));expect((await catalog()).revision).toBe(before.revision);
  await mutate(await intent('update',11,{rule_name:'只改名称',mode:'preserve'}));expect((await snapshot()).rules.find(row=>row.id===11)).toMatchObject({ruleName:'只改名称',ruleValue:raw});
 });
 it('replaces invalid raw only through explicit complete spec and preserves every foreign row',async()=>{
  await f.db.update(storeProductRule).set({ruleValue:'{"unknown":"keep until explicit replacement"}'}).where(eq(storeProductRule.id,11));const foreign=(await snapshot()).rules.filter(row=>row.id>=20);
  await mutate(await intent('update',11,replace({rule_name:'明确修复',spec:[{value:' 颜色 ',detail:[' 红 ',' 蓝 ']}]})));
  expect((await snapshot()).rules.find(row=>row.id===11)?.ruleValue).toBe('[{"value":"颜色","detail":["红","蓝"]}]');expect((await snapshot()).rules.filter(row=>row.id>=20)).toEqual(foreign);
 });
 it('preserves same empty or control historical names while a changed name follows modern32 Unicode limits',async()=>{
  for(const ruleName of ['','x\u0085y']){await f.db.update(storeProductRule).set({ruleName}).where(eq(storeProductRule.id,11));await mutate(await intent('update',11,{rule_name:ruleName,mode:'preserve'}));expect((await snapshot()).rules.find(row=>row.id===11)?.ruleName).toBe(ruleName);}
 });
 it('creates full32/32/64 Unicode dimensions at3x50 without truncation and remains below the bounded body',async()=>{
  const spec=Array.from({length:3},(_,i)=>({value:'😀'.repeat(31)+i,detail:Array.from({length:50},(_,j)=>'🧭'.repeat(62)+String(j).padStart(2,'0'))}));const a=await intent('create',0,replace({rule_name:'😀'.repeat(32),spec}));expect(new TextEncoder().encode(JSON.stringify(a)).length).toBeLessThan(65536);const receipt=await mutate(a);expect(receipt.result).toMatchObject({id:100,created:1,count:3});expect((await snapshot()).rules.find(row=>row.id===100)).toMatchObject({ruleName:'😀'.repeat(32),ruleValue:JSON.stringify(spec)});
 });
 it('uses Set uniqueness rather than object prototype keys and keeps modern name0 valid',async()=>{
  await mutate(await intent('create',0,replace({rule_name:'0',spec:[{value:'__proto__',detail:['constructor','__proto__']}]})));expect((await snapshot()).rules.find(row=>row.id===100)?.ruleName).toBe('0');expect(Object.prototype).not.toHaveProperty('polluted');
 });
 for(const patch of [{rule_name:''},{rule_name:'x'.repeat(33)},{rule_name:'x\u0085y'},{rule_name:'x\ud800'},{spec:[{value:'',detail:['x']}]},{spec:[{value:'x'.repeat(33),detail:['x']}]},{spec:[{value:'a',detail:['x'.repeat(65)]}]},{spec:[{value:'a',detail:['x',' x ']}]},{spec:[{value:'a',detail:['x']},{value:' a ',detail:['y']}]}])it('rejects invalid normalized replacements atomically '+JSON.stringify(patch),()=>unchanged(async()=>expect(mutate(await intent('create',0,replace(patch)))).rejects.toThrow()));
 for(const payload of [{rule_name:'x',mode:'preserve'},{rule_name:'x',mode:'replace',spec:[]},{rule_name:'x',mode:'replace',spec:[{value:'a',detail:[],extra:true}]},{rule_name:'x',mode:'replace',spec:[{value:'a',detail:[7]}]}])it('refuses incomplete or fabricated create protocol '+JSON.stringify(payload),async()=>{const a=await intent('create',0,replace());await unchanged(()=>expect(mutate({...a,payload})).rejects.toThrow());});
 for(const extra of [{rule_value:'null'},{type:2},{relation_id:4},{status:1},{sort:1},{is_del:1}])it('does not accept unrelated or echoed stored values '+JSON.stringify(extra),async()=>{const a=await intent('update',11,{rule_name:'包装',mode:'preserve'});await unchanged(()=>expect(mutate({...a,payload:{...a.payload,...extra}})).rejects.toThrow());});
 it('physically deletes a copy source even when a product keeps its independent SKU-related data',async()=>{
  await f.db.insert(storeProduct).values({id:88,storeName:'已经复制规格的商品',specType:1,storeInfo:'copied price/stock remain independent'});const before=(await snapshot()).products;await mutate(await intent('delete'));expect((await snapshot()).rules.find(row=>row.id===11)).toBeUndefined();expect((await snapshot()).products).toEqual(before);
 });
 for(const id of [10,20,21,22])it('binds complete five-column xmin including restored private ABA '+id,async()=>{const a=await intent('delete'),original=(await snapshot()).rules.find(row=>row.id===id)!;await f.db.update(storeProductRule).set({ruleValue:'[1]'}).where(eq(storeProductRule.id,id));await f.db.update(storeProductRule).set({ruleValue:original.ruleValue}).where(eq(storeProductRule.id,id));await unchanged(()=>expect(mutate(a)).rejects.toMatchObject({httpStatus:409}));});
 for(const id of [20,21,22,30,999])it('refuses hidden/foreign/missing target '+id,async()=>unchanged(async()=>expect(mutate(await intent('delete',id))).rejects.toMatchObject({code:404})));
 it('replays original UUID before source CAS with one audit and refuses different original content',async()=>{
  const a=await intent('update',11,{rule_name:'一次编辑',mode:'preserve'}),receipt=await mutate(a);await f.db.update(storeProductRule).set({ruleValue:'null'}).where(eq(storeProductRule.id,20));
  await unchanged(async()=>{expect(await mutate(a)).toEqual(receipt);expect(await f.asAdmin(()=>service.receipt(a.operation_id,query,ruleActor()))).toEqual(receipt);const b={...a,payload:{rule_name:'不同原稿',mode:'preserve'}};b.payload_hash=ruleActionHash(b);await expect(mutate(b)).rejects.toMatchObject({httpStatus:409});});expect((await snapshot()).logs).toHaveLength(1);
 });
 it('keeps404 unknown and allows original live owner to seal after grants disappear without commit authority',async()=>{
  const a=await intent('delete');await f.db.update(systemRole).set({rules:''}).where(eq(systemRole.id,1));await unchanged(async()=>{await expect(f.asAdmin(()=>service.receipt(a.operation_id,query,ruleActor()))).rejects.toMatchObject({code:404});await expect(mutate(a)).rejects.toThrow();});const receipt=await f.asAdmin(()=>service.resolve(a,ruleActor()));expect(receipt.state).toBe('not_applied');await f.db.update(systemRole).set({rules:'product.manage'}).where(eq(systemRole.id,1));await unchanged(()=>expect(mutate(a)).rejects.toMatchObject({httpStatus:409}));
 });
 it('keeps mature legacy CRUD DTO and modern writer executable without using new receipt as its authority',async()=>{const old=new AdminProductRuleService(f.container);await f.asAdmin(()=>old.save(0,ruleBody({rule_name:'成熟旧写入'}),ruleActor()));expect((await catalog()).list.some(row=>row.rule_name==='成熟旧写入')).toBe(true);expect(await f.asAdmin(()=>old.detail(11,query,ruleActor()))).toHaveProperty('info.spec');});
 it('refuses a duplicate changed name while no-op preserves the original xmin',async()=>{const before=await catalog();await mutate(await intent('update',11,{rule_name:'包装',mode:'preserve'}));expect((await catalog()).revision).toBe(before.revision);await unchanged(async()=>expect(mutate(await intent('update',11,{rule_name:'服装',mode:'preserve'}))).rejects.toThrow('已存在'));});
 for(const deferred of [false,true])it('rolls back every effect when '+(deferred?'deferred':'immediate')+' audit mutates a private raw source',async()=>{
  await f.exec(`CREATE FUNCTION owned_rule_corrupt() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN UPDATE public.store_product_rule SET rule_value='null' WHERE id=20;RETURN NEW;END$$;CREATE ${deferred?'CONSTRAINT ':''}TRIGGER owned_rule_corrupt AFTER INSERT ON public.system_log ${deferred?'DEFERRABLE INITIALLY DEFERRED ':''}FOR EACH ROW EXECUTE FUNCTION owned_rule_corrupt()`);
  try{await unchanged(async()=>expect(mutate(await intent('update',11,{rule_name:'审计改名',mode:'preserve'}))).rejects.toThrow('完整写后回读不一致'));}finally{await f.exec('DROP TRIGGER owned_rule_corrupt ON public.system_log;DROP FUNCTION owned_rule_corrupt()');}
 });
 it('strict whole-document projection never exposes a safe partial subset as writable history',()=>{for(const raw of rawHistory.slice(0,-1))expect(ruleProjection(raw).spec).toBeNull();const raw=rawHistory.at(-1)!;expect(ruleProjection(raw).spec).toEqual([{value:' 颜色 ',detail:[' 红 ','蓝']}]);});
});
