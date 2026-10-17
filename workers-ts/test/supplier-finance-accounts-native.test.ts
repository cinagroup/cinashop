/** Actual App/JWT, independent restricted PostgreSQL LOGIN and real xmin/CAS.
 * Object and queue boundaries are owned local bytes; no real payee or R2 claim. */
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {eq,sql} from 'drizzle-orm';
import {createApp} from '@/app';
import {createContainerFromDb,withTx,type Container} from '@/lib/di';
import {systemAdmin,systemAttachment,systemRole,systemSupplier} from '@/models/schema';
import {SupplierFinanceAccountsService,assertSupplierFinanceAccountsReady,type SupplierFinanceAccountsContext} from '@/services/supplier/SupplierFinanceAccountsService';
import {SupplierExtractApplicationService} from '@/services/supplier/SupplierExtractApplicationService';
import {md5} from '@/utils/jwt';
import {supplierFinanceAccountsFixture} from './helpers/supplierFinanceAccounts';
import {supplierExtractReadPassword} from './helpers/supplierExtractRead';
const wiring=vi.hoisted(()=>({container:undefined as Container|undefined}));
vi.mock('@/lib/di',async original=>({...await original<typeof import('@/lib/di')>(),createContainer:()=>{if(!wiring.container)throw Error('Missing owned accounts LOGIN');return wiring.container;}}));
const app=createApp(),path='/supplierapi/finance/info',actor={id:21,supplierId:7,authVersion:md5(supplierExtractReadPassword),expiresAt:2147483647};
const columns=['bank_code','bank_address','alipay_account','alipay_qrcode_url','wechat','wechat_qrcode_url'];
const canonical=(state:Record<string,any[]>)=>Object.fromEntries(Object.entries(state).map(([name,rows])=>[name,rows.map(row=>JSON.stringify(row)).sort()]));
describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('Supplier finance accounts actual App and PG16',()=>{
 let f:Awaited<ReturnType<typeof supplierFinanceAccountsFixture>>;
 beforeEach(async()=>{f=await supplierFinanceAccountsFixture();vi.spyOn(globalThis,'fetch').mockRejectedValue(Error('No payee/provider outbound I/O'));},30000);
 afterEach(async()=>{try{expect(fetch).not.toHaveBeenCalled();await f?.close();}finally{wiring.container=undefined;vi.restoreAllMocks();}});
 async function request(body?:unknown,query='?selection=accounts',identity:'reader'|'viewer'|'denied'|'other'|'anonymous'='reader'){
  const response=await app.request(path+query,{method:body===undefined?'GET':'POST',headers:{...(identity==='anonymous'?{}:{Authorization:'Bearer '+f.tokens[identity]}),...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})},f.env);
  expect(response.headers.get('cache-control')).toContain('private, no-store');return response.json<{status:number;data:any}>();
 }
 async function context(){const response=await request();expect(response.status).toBe(200);return response.data as SupplierFinanceAccountsContext;}
 const body=(seed:SupplierFinanceAccountsContext,changes:Record<string,string>={})=>({...seed.accounts,...changes,revision:seed.revision});
 async function noWrite(work:()=>Promise<unknown>){const before=await f.snapshot(),sequence=await f.sequence(),images=await f.imageSequence(),value=await work();expect(await f.snapshot()).toEqual(before);expect(await f.sequence()).toEqual(sequence);expect(await f.imageSequence()).toEqual(images);return value;}
 async function onlySettings(before:Awaited<ReturnType<typeof f.snapshot>>){
  const after=await f.snapshot(),old=before.system_supplier.find((r:any)=>r.row.id===7)!,current=after.system_supplier.find((r:any)=>r.row.id===7)!;
  expect(old&&current).toBeTruthy();for(const[key,value]of Object.entries(old.row))if(!columns.includes(key))expect(current.row[key]).toEqual(value);
  after.system_supplier=after.system_supplier.map((r:any)=>r.row.id===7?old:r);expect(canonical(after)).toEqual(canonical(before));
 }
 it('reads closed8 current context and unchanged legacy6 through a pure reader without any mutation',async()=>{
  await f.withReader(async runtime=>{wiring.container=runtime.container;const[rights]=await runtime.db.execute(sql`SELECT EXISTS(SELECT 1 FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relkind IN('r','p') AND(has_table_privilege(current_user,c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR has_any_column_privilege(current_user,c.oid,'INSERT,UPDATE,REFERENCES'))) AS dml,EXISTS(SELECT 1 FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relkind='S' AND has_sequence_privilege(current_user,c.oid,'USAGE,SELECT,UPDATE')) AS sequence`);expect(rights).toEqual({dml:false,sequence:false});await noWrite(async()=>{const value=await context();expect(Object.keys(value).sort()).toEqual(['version','actor_id','supplier_id','revision','accounts','ready','previews','bounded'].sort());expect(value).toMatchObject({version:'supplier-finance-accounts-v1',actor_id:21,supplier_id:7,bounded:true,ready:{bank:true,alipay:true,weixin:true}});expect(value.revision).toMatch(/^[a-f0-9]{64}$/);expect(Object.keys(value.accounts).sort()).toEqual([...columns].sort());expect(Object.keys(value.previews).sort()).toEqual(['alipay','weixin']);for(const preview of Object.values(value.previews)){expect(Object.keys(preview).sort()).toEqual(['reference','status','src','expires_at'].sort());expect(preview.status).toBe('ready');expect(preview.src).toBe(preview.reference);expect(preview.expires_at).toBeNull();}expect((await request(undefined,'')).data).toEqual(value.accounts);});});
 });
 it('saves exact six fields atomically and advances real xmin/revision even for the next same-value modern save',async()=>{
  await f.withWriter(async runtime=>{wiring.container=runtime.container;const seed=await context(),before=await f.snapshot(),seq=await f.sequence(),images=await f.imageSequence(),input=body(seed,{bank_code:'0000000123',bank_address:'新开户行',alipay_qrcode_url:'/api/assets/31',wechat_qrcode_url:'/api/assets/32'}),saved=await request(input);expect(saved.status).toBe(200);expect(saved.data.accounts).toEqual(Object.fromEntries(columns.map(k=>[k,input[k as keyof typeof input]])));expect(saved.data.revision).not.toBe(seed.revision);await onlySettings(before);expect(await f.sequence()).toEqual(seq);expect(await f.imageSequence()).toEqual(images);
   const prior=saved.data.revision,next=await request({...saved.data.accounts,revision:prior});expect(next.status).toBe(200);expect(next.data.revision).not.toBe(prior);expect(next.data.accounts).toEqual(saved.data.accounts);
  });
 });
 it('normalizes modern zero sentinel and keeps all incomplete or cleared channels saveable',async()=>{
  await f.withWriter(async runtime=>{wiring.container=runtime.container;const seed=await context(),saved=await request(body(seed,{bank_code:'0',bank_address:'',alipay_qrcode_url:'',wechat:''}));expect(saved).toMatchObject({status:200,data:{accounts:{bank_code:'',bank_address:'',alipay_qrcode_url:'',wechat:''},ready:{bank:false,alipay:false,weixin:false}}});expect(saved.data.previews.alipay).toEqual({reference:'',status:'unavailable',src:'',expires_at:null});expect((await request({bank_code:'0'},'')).status).toBe(200);expect((await request(undefined,'')).data.bank_code).toBe('');});
 });
 it('keeps legacy partial semantics while invalidating every earlier modern version including account ABA',async()=>{
  await f.withWriter(async runtime=>{wiring.container=runtime.container;const seed=await context();expect(await request({bank_address:'临时开户行'},'')).toMatchObject({status:200,data:null});expect((await context()).accounts).toEqual({...seed.accounts,bank_address:'临时开户行'});await noWrite(async()=>expect((await request(body(seed))).status).toBe(409));expect((await request({bank_address:seed.accounts.bank_address},'')).status).toBe(200);expect((await context()).accounts).toEqual(seed.accounts);await noWrite(async()=>expect((await request(body(seed))).status).toBe(409));});
 });
 it('serializes two independent modern writers so exactly one current version is accepted',async()=>{
  await f.withWriter(async one=>f.withWriter(async two=>{const a=new SupplierFinanceAccountsService(one.container,f.env.APP_KEY),b=new SupplierFinanceAccountsService(two.container,f.env.APP_KEY),seed=await a.context(actor),before=await f.snapshot();const results=await Promise.allSettled([a.save(body(seed,{bank_address:'甲开户行'}),actor,true),b.save(body(seed,{bank_address:'乙开户行'}),actor,true)]);expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);const rejected=results.find(r=>r.status==='rejected');expect(rejected?.status==='rejected'&&rejected.reason).toMatchObject({httpStatus:409});await onlySettings(before);}));
 });
 it('delegates finance-view previews only to the two current owned QR rows without granting any material-library access',async()=>{
  await f.db.update(systemSupplier).set({alipayQrcodeUrl:'/api/assets/31',wechatQrcodeUrl:'/api/assets/32'}).where(eq(systemSupplier.id,7));
  await f.withReader(async runtime=>{wiring.container=runtime.container;await noWrite(async()=>{const response=await request(undefined,'?selection=accounts','viewer');expect(response.status).toBe(200);const seed=response.data as SupplierFinanceAccountsContext;expect(seed.actor_id).toBe(22);for(const channel of['alipay','weixin'] as const){const preview=seed.previews[channel];expect(preview.status).toBe('ready');const url=new URL(preview.src,'http://owned.invalid');expect(url.pathname).toBe(preview.reference);expect(preview.expires_at).toBe(Number(url.searchParams.get('expires')));expect(preview.expires_at!).toBeGreaterThan(Math.floor(Date.now()/1000));expect(preview.expires_at!).toBeLessThanOrEqual(Math.floor(Date.now()/1000)+3600);const image=await app.request(preview.src,{},f.env);expect(image.status).toBe(200);expect(new Uint8Array(await image.arrayBuffer())).toEqual(f.png);}const library=await app.request('/supplierapi/file/file',{headers:{Authorization:'Bearer '+f.tokens.viewer}},f.env);expect((await library.json<{status:number}>()).status).toBe(400011);});});
 });
 it.each([41,42,43,44,999])('never signs or accepts a newly selected foreign absent or wrong-scope private QR %s',async id=>{
  await f.withWriter(async runtime=>{wiring.container=runtime.container;const seed=await context();await noWrite(async()=>expect((await request(body(seed,{alipay_qrcode_url:'/api/assets/'+id}))).status).toBe(400));await f.db.update(systemSupplier).set({alipayQrcodeUrl:'/api/assets/'+id}).where(eq(systemSupplier.id,7));await noWrite(async()=>{const current=await context();expect(current.previews.alipay).toEqual({reference:'/api/assets/'+id,status:'unavailable',src:'',expires_at:null});expect(current.ready.alipay).toBe(true);});});
 });
 it('pins a newly selected owned QR with NOWAIT so an uncommitted attachment writer cannot change its binding',async()=>{
  await f.withWriter(async runtime=>{const service=new SupplierFinanceAccountsService(runtime.container,f.env.APP_KEY),seed=await service.context(actor),before=await f.snapshot(),rollback=Error('owned image release');await expect(f.db.transaction(async tx=>{await tx.update(systemAttachment).set({relationId:8}).where(eq(systemAttachment.attId,31));await expect(service.save(body(seed,{alipay_qrcode_url:'/api/assets/31'}),actor,true)).rejects.toMatchObject({code:400});throw rollback;})).rejects.toBe(rollback);expect(await f.snapshot()).toEqual(before);expect((await service.save(body(seed,{alipay_qrcode_url:'/api/assets/31'}),actor,true))?.previews.alipay.status).toBe('ready');});
 });
 it('preserves unchanged unsafe historical URL with unavailable preview but rejects changing to another unsafe reference',async()=>{
  await f.db.update(systemSupplier).set({alipayQrcodeUrl:'http://legacy.invalid/old.png'}).where(eq(systemSupplier.id,7));await f.withWriter(async runtime=>{wiring.container=runtime.container;const seed=await context();expect(seed.previews.alipay).toEqual({reference:'http://legacy.invalid/old.png',status:'unavailable',src:'',expires_at:null});expect((await request(body(seed,{bank_address:'仍可更新开户行'}))).status).toBe(200);const next=await context();await noWrite(async()=>expect((await request(body(next,{alipay_qrcode_url:'http://legacy.invalid/new.png'}))).status).toBe(400));});
 });
 it.each(['x\ny','x\u0000y','\ud800','\udfff'])('closes malformed scalar %j on both legacy and modern HTTP writers before touching any row',async bank_address=>{
  await f.withWriter(async runtime=>{wiring.container=runtime.container;const seed=await context();await noWrite(async()=>{expect((await request(body(seed,{bank_address}))).status).toBe(400);expect((await request({bank_address},'')).status).toBe(400);});});
 });
 it('uses actual Unicode codepoint widths for full settings snapshots and rejects overflowing scalar values',async()=>{
  await f.withWriter(async runtime=>{wiring.container=runtime.container;const seed=await context(),saved=await request(body(seed,{bank_address:'🌷'.repeat(256),wechat:'🌷'.repeat(15)}));expect(saved.status).toBe(200);expect(saved.data.accounts.bank_address).toBe('🌷'.repeat(256));await noWrite(async()=>expect((await request({...saved.data.accounts,revision:saved.data.revision,wechat:'🌷'.repeat(16)})).status).toBe(400));});
 });
 it('rejects wrong body query tenant and role contexts while preserving default shape and private auth failures',async()=>{
  await f.withWriter(async runtime=>{wiring.container=runtime.container;const seed=await context();await noWrite(async()=>{
   for(const data of[{}, {revision:seed.revision}, {...body(seed),supplier_id:8},{...body(seed),previews:{}}])expect((await request(data)).status).toBe(400);
   for(const data of[{}, {bank_code:1},{supplier_id:8,bank_code:'1'},{revision:seed.revision,bank_code:'1'}])expect((await request(data,'')).status).toBe(400);
   for(const query of['?selection=x','?selection=accounts&selection=accounts','?supplier_id=8','?selection=accounts&unknown=x'])expect((await request(undefined,query)).status).toBe(400);
   expect((await request(body(seed),'?selection=accounts','viewer')).status).toBe(400011);expect((await request(undefined,'?selection=accounts','denied')).status).toBe(400011);expect((await request(undefined,'?selection=accounts','anonymous')).status).toBe(410000);expect((await request(undefined,'?selection=accounts','other')).data.supplier_id).toBe(8);
  });});
 });
 it('fails closed against an uncommitted role writer and accepts after its rollback without partial account changes',async()=>{
  await f.withWriter(async runtime=>{const service=new SupplierFinanceAccountsService(runtime.container,f.env.APP_KEY),seed=await service.context(actor),before=await f.snapshot(),rollback=Error('owned authority release');await expect(f.db.transaction(async tx=>{await tx.update(systemRole).set({rules:'supplier.finance.view'}).where(eq(systemRole.id,21));await expect(service.save(body(seed),actor,true)).rejects.toMatchObject({httpStatus:409});throw rollback;})).rejects.toBe(rollback);expect(await f.snapshot()).toEqual(before);expect((await service.save(body(seed),actor,true))?.accounts).toEqual(seed.accounts);});
 });
 it('observes live password expiry and finance permission revocation inside the transaction',async()=>{
  await f.withWriter(async runtime=>{const service=new SupplierFinanceAccountsService(runtime.container,f.env.APP_KEY),seed=await service.context(actor);await expect(service.save(body(seed),{...actor,expiresAt:1},true)).rejects.toMatchObject({code:410001});await f.db.update(systemAdmin).set({pwd:'owned changed password'}).where(eq(systemAdmin.id,21));const before=await f.snapshot();await expect(service.save(body(seed),actor,true)).rejects.toMatchObject({code:410001});expect(await f.snapshot()).toEqual(before);await f.db.update(systemAdmin).set({pwd:supplierExtractReadPassword}).where(eq(systemAdmin.id,21));await f.db.update(systemRole).set({rules:'supplier.finance.view'}).where(eq(systemRole.id,21));await expect(service.save(body(seed),actor,true)).rejects.toMatchObject({code:400011});});
 });
 it('proves minimum settings privileges and preflights missing SELECT without aborting the same SQL transaction',async()=>{
  await f.withWriter(async runtime=>{const[rights]=await runtime.db.execute(sql`SELECT has_table_privilege(current_user,'public.system_supplier','INSERT,DELETE,TRUNCATE') AS supplier_write,has_column_privilege(current_user,'public.system_supplier','mark','UPDATE') AS mark,has_column_privilege(current_user,'public.system_role','rules','UPDATE') AS rules,has_column_privilege(current_user,'public.system_admin','pwd','UPDATE') AS password,has_table_privilege(current_user,'public.supplier_extract','INSERT') AS application,has_sequence_privilege(current_user,'public.supplier_extract_id_seq','USAGE,SELECT,UPDATE') AS sequence,has_table_privilege(current_user,'public.system_attachment','INSERT,DELETE,TRUNCATE') AS images`);expect(rights).toEqual({supplier_write:false,mark:false,rules:false,password:false,application:false,sequence:false,images:false});});
  await f.withReader(async runtime=>{await f.exec(`REVOKE SELECT ON public.system_attachment FROM "${runtime.role}"`);await withTx(runtime.container,async tx=>{await tx.execute(sql`SET TRANSACTION READ ONLY`);await expect(assertSupplierFinanceAccountsReady(tx)).rejects.toMatchObject({code:503});expect((await tx.execute(sql`SELECT 1 AS alive`))[0].alive).toBe(1);});});
  await expect(new SupplierFinanceAccountsService(createContainerFromDb(f.db),f.env.APP_KEY).context(actor)).rejects.toMatchObject({code:503});
 });
 it('makes settings exclusive locks and actual application authority SHARE reject the conflicting peer in both directions',async()=>{
  await f.withWriter(async settings=>f.withApplicant(async application=>{const a=new SupplierFinanceAccountsService(settings.container,f.env.APP_KEY),b=new SupplierExtractApplicationService(application.container,f.env.APP_KEY),seed=await a.context(actor),quote=await b.seed(actor),input={operation_id:randomUUID(),revision:quote.revision,extract_type:'bank',money:'10.00',mark:''},before=await f.snapshot(),rollback=Error('owned settings release');
   await expect(f.db.transaction(async tx=>{await tx.update(systemSupplier).set({bankAddress:'尚未提交开户行'}).where(eq(systemSupplier.id,7));await expect(b.execute(input,actor)).rejects.toMatchObject({httpStatus:409});throw rollback;})).rejects.toBe(rollback);
   await withTx(application.container,async tx=>{await tx.select({id:systemSupplier.id}).from(systemSupplier).where(eq(systemSupplier.id,7)).for('share');await expect(a.save(body(seed),actor,true)).rejects.toMatchObject({httpStatus:409});});expect(await f.snapshot()).toEqual(before);
  }));
 });
 it('invalidates stale withdrawal admission after real account save but preserves the original committed UUID snapshot across later settings and permission changes',async()=>{
  await f.withWriter(async settings=>f.withApplicant(async application=>{const a=new SupplierFinanceAccountsService(settings.container,f.env.APP_KEY),b=new SupplierExtractApplicationService(application.container,f.env.APP_KEY),seed=await a.context(actor),old=await b.seed(actor),input={operation_id:randomUUID(),revision:old.revision,extract_type:'bank',money:'10.00',mark:'原开户行快照'};
   await a.save(body(seed,{bank_code:'000099998888',bank_address:'新真实开户行'}),actor,true);const before=await f.snapshot();await expect(b.execute(input,actor)).rejects.toMatchObject({httpStatus:409});expect(await f.snapshot()).toEqual(before);
   const next=await b.seed(actor),admitted={...input,operation_id:randomUUID(),revision:next.revision},original=await b.execute(admitted,actor);expect(original.result).toMatchObject({bank_code:'000099998888',bank_address:'新真实开户行',extract_price:'10.00'});
   await a.save({bank_address:'再一次收款设置修改'},actor,false);await f.db.update(systemRole).set({rules:'supplier.order.view'}).where(eq(systemRole.id,21));const saved=await f.snapshot(),seq=await f.sequence();expect(await b.receipt(original.operation_id,actor)).toEqual(original);expect(await b.execute(admitted,actor)).toEqual(original);expect(await f.snapshot()).toEqual(saved);expect(await f.sequence()).toEqual(seq);
  }));
 });
 it('rolls back a deferred unexpected supplier column mutation instead of publishing a successful settings context',async()=>{
  await f.exec("CREATE FUNCTION public.owned_accounts_late() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$BEGIN UPDATE public.system_supplier SET mark='unpublished mutation' WHERE id=NEW.id; RETURN NEW; END$$; REVOKE ALL ON FUNCTION public.owned_accounts_late() FROM PUBLIC; CREATE CONSTRAINT TRIGGER owned_accounts_late AFTER UPDATE OF bank_address ON public.system_supplier DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.owned_accounts_late()");
  await f.withWriter(async runtime=>{wiring.container=runtime.container;const seed=await context(),before=await f.snapshot();expect((await request(body(seed,{bank_address:'更新触发回滚'}))).status).toBe(503);expect(await f.snapshot()).toEqual(before);});
 });
});
