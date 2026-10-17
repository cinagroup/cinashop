import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {eq,sql} from 'drizzle-orm';
import {createApp} from '@/app';
import {withTx,type Container} from '@/lib/di';
import {supplierExtract,systemAdmin,systemAttachment,systemRole,systemSupplier} from '@/models/schema';
import {assertSupplierExtractMediaReady,SupplierExtractMediaService} from '@/services/supplier/SupplierExtractMediaService';
import {md5} from '@/utils/jwt';
import {supplierExtractMediaFixture} from './helpers/supplierExtractMedia';
import {supplierExtractReadPassword} from './helpers/supplierExtractRead';
const wiring=vi.hoisted(()=>({container:undefined as Container|undefined}));
vi.mock('@/lib/di',async original=>({...await original<typeof import('@/lib/di')>(),createContainer:()=>{if(!wiring.container)throw Error('Missing owned media LOGIN');return wiring.container;}}));
const app=createApp(),actor={id:22,supplierId:7,authVersion:md5(supplierExtractReadPassword),expiresAt:2147483647};
describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('Supplier historical extract media actual App and PG16',()=>{
 let f:Awaited<ReturnType<typeof supplierExtractMediaFixture>>;
 beforeEach(async()=>{f=await supplierExtractMediaFixture();vi.spyOn(globalThis,'fetch').mockRejectedValue(Error('No historical media outbound network'));},30000);
 afterEach(async()=>{try{expect(fetch).not.toHaveBeenCalled();await f?.close();}finally{wiring.container=undefined;vi.restoreAllMocks();}});
 async function request(id=3,revision?:string,identity:'viewer'|'reader'|'denied'|'other'|'anonymous'='viewer',suffix=''){
  const response=await app.request(`/supplierapi/finance/supplier_extract/${id}/media?revision=${revision??await f.revision(id)}${suffix}`,{headers:identity==='anonymous'?{}:{Authorization:'Bearer '+f.tokens[identity]}},f.env);
  expect(response.headers.get('cache-control')).toContain('private, no-store');return response.json<{status:number;data:any}>();
 }
 async function unchanged<T>(work:()=>Promise<T>){const before=await f.snapshot(),sequence=await f.sequence(),images=await f.imageSequence(),result=await work();expect(await f.snapshot()).toEqual(before);expect(await f.sequence()).toEqual(sequence);expect(await f.imageSequence()).toEqual(images);return result;}
 async function media(id=3){const response=await request(id);expect(response.status).toBe(200);return response.data;}
 const unavailable=(reference:string)=>({reference,status:'unavailable',src:'',expires_at:null});
 it('delegates both historical images to a finance-only viewer through six SELECTs without UUID or gallery permissions',async()=>f.withMediaReader(async runtime=>{
  wiring.container=runtime.container;expect(await f.exec('SELECT count(*)::int AS operations FROM public.supplier_extract_application_operation_v1')).toEqual([{operations:0}]);await unchanged(async()=>{expect((await media()).previews.qrcode.status).toBe('ready');const response=await app.request('/supplierapi/file/file',{headers:{Authorization:'Bearer '+f.tokens.viewer}},f.env);expect((await response.json<{status:number}>()).status).toBe(400011);});
 }));
 it('returns closed7 plus two closed4 projections, actual signed PNG bytes and exact five minute expiry without writes',async()=>f.withMediaReader(async runtime=>{
  wiring.container=runtime.container;await unchanged(async()=>{const result=await media();expect(Object.keys(result).sort()).toEqual(['version','actor_id','supplier_id','id','revision','previews','bounded'].sort());expect(result).toMatchObject({version:'supplier-extract-media-v1',actor_id:22,supplier_id:7,id:3,bounded:true});expect(Object.keys(result.previews).sort()).toEqual(['qrcode','voucher']);
   for(const[k,id]of[['qrcode',32],['voucher',42]]as const){const p=result.previews[k];expect(Object.keys(p).sort()).toEqual(['reference','status','src','expires_at'].sort());expect(p.reference).toBe('/api/assets/'+id);expect(p.status).toBe('ready');const url=new URL(p.src,'http://owned.invalid');expect(url.pathname).toBe('/api/assets/'+id);expect(Number(url.searchParams.get('expires'))).toBe(p.expires_at);expect(p.expires_at).toBeGreaterThan(Math.floor(Date.now()/1000));expect(p.expires_at).toBeLessThanOrEqual(Math.floor(Date.now()/1000)+300);const image=await app.request(p.src,{},f.env);expect(image.status).toBe(200);expect(new Uint8Array(await image.arrayBuffer())).toEqual(f.png);}
  });
 }));
 it('renews an expired Kefu alias only after historical row and own supplier scope checks',async()=>f.withMediaReader(async runtime=>{wiring.container=runtime.container;await unchanged(async()=>{const result=await media(2);expect(result.previews.qrcode.reference).toContain('/kefuapi/assets/31?expires=1');expect(result.previews.qrcode.src).toMatch(/^\/api\/assets\/31\?expires=\d+&signature=[A-Za-z0-9_-]{43}$/);expect(result.previews.voucher).toEqual(unavailable(''));});}));
 it('keeps legacy records readable after current settings change and original applicant permissions are withdrawn',async()=>{
  await f.db.update(systemSupplier).set({alipayQrcodeUrl:'/api/assets/41',wechatQrcodeUrl:'/api/assets/41'}).where(eq(systemSupplier.id,7));await f.db.update(systemRole).set({rules:'supplier.order.view'}).where(eq(systemRole.id,21));
  await f.withMediaReader(async runtime=>{wiring.container=runtime.container;await unchanged(async()=>expect((await media()).previews.qrcode.status).toBe('ready'));});
 });
 it('accepts the disabled historical Admin identity but never treats a supplier administrator as its voucher publisher',async()=>{
  await f.db.update(systemAdmin).set({status:0}).where(eq(systemAdmin.id,102));
  await f.withMediaReader(async runtime=>{wiring.container=runtime.container;expect((await media()).previews.voucher.status).toBe('ready');await f.db.update(supplierExtract).set({adminId:21}).where(eq(supplierExtract.id,3));await unchanged(async()=>expect((await media()).previews.voucher).toEqual(unavailable('/api/assets/42')));await f.db.update(supplierExtract).set({adminId:999}).where(eq(supplierExtract.id,3));await unchanged(async()=>expect((await media()).previews.voucher.status).toBe('unavailable'));});
 });
 it.each([41,43,44,51,999])('refuses a historical QR with absent or wrong tenant namespace kind %s',async id=>{
  await f.db.update(supplierExtract).set({qrcodeUrl:'/api/assets/'+id}).where(eq(supplierExtract.id,3));await f.withMediaReader(async runtime=>{wiring.container=runtime.container;await unchanged(async()=>{const result=await media();expect(result.previews.qrcode).toEqual(unavailable('/api/assets/'+id));expect(result.previews.voucher.status).toBe('ready');});});
 });
 it('never borrows one media kind authorization for the other when both stored references name the same id',async()=>{
  await f.withMediaReader(async runtime=>{wiring.container=runtime.container;await f.db.update(supplierExtract).set({qrcodeUrl:'/api/assets/42',voucherImage:'/api/assets/42'}).where(eq(supplierExtract.id,3));await unchanged(async()=>{const result=await media();expect(result.previews.qrcode.status).toBe('unavailable');expect(result.previews.voucher.status).toBe('ready');});await f.db.update(supplierExtract).set({qrcodeUrl:'/api/assets/32',voucherImage:'/api/assets/32'}).where(eq(supplierExtract.id,3));await unchanged(async()=>{const result=await media();expect(result.previews.qrcode.status).toBe('ready');expect(result.previews.voucher.status).toBe('unavailable');});await f.db.update(supplierExtract).set({qrcodeUrl:'/api/assets/32'}).where(eq(supplierExtract.id,1));await unchanged(async()=>expect((await media(1)).previews.qrcode).toEqual(unavailable('/api/assets/32')));});
 });
 it.each([{status:0},{payStatus:0},{payTime:0},{adminId:0}])('does not publish a voucher without complete approved-paid evidence %j',async change=>{
  await f.db.update(supplierExtract).set(change).where(eq(supplierExtract.id,3));await f.withMediaReader(async runtime=>{wiring.container=runtime.container;await unchanged(async()=>expect((await media()).previews.voucher).toEqual(unavailable('/api/assets/42')));});
 });
 it('preserves safe public history exactly and returns unavailable for unsafe historical values',async()=>{
  await f.db.update(supplierExtract).set({qrcodeUrl:'/owned-media/legacy.png?x=1&y=2',voucherImage:'javascript:legacy'}).where(eq(supplierExtract.id,3));await f.withMediaReader(async runtime=>{wiring.container=runtime.container;await unchanged(async()=>{const result=await media();expect(result.previews.qrcode).toEqual({reference:'/owned-media/legacy.png?x=1&y=2',status:'ready',src:'/owned-media/legacy.png?x=1&y=2',expires_at:null});expect(result.previews.voucher).toEqual(unavailable('javascript:legacy'));});});
 });
 it('returns409 after any row revision change including notes and account ABA instead of signing stale details',async()=>f.withMediaReader(async runtime=>{
  wiring.container=runtime.container;const revision=await f.revision(3);await f.db.update(supplierExtract).set({supplierMark:'历史备注已改'}).where(eq(supplierExtract.id,3));await unchanged(async()=>expect((await request(3,revision)).status).toBe(409));const second=await f.revision(3);await f.db.update(supplierExtract).set({supplierMark:'微信申请说明'}).where(eq(supplierExtract.id,3));await unchanged(async()=>expect((await request(3,second)).status).toBe(409));
 }));
 it('rejects foreign records, revoked roles, anonymous requests and extra query media selectors',async()=>f.withMediaReader(async runtime=>{
  wiring.container=runtime.container;await unchanged(async()=>{expect((await request(5)).status).toBe(404);expect((await request(3,undefined,'other')).status).toBe(404);expect((await request(3,undefined,'denied')).status).toBe(400011);expect((await request(3,undefined,'anonymous')).status).toBe(410000);expect((await request(3,undefined,'viewer','&id=31')).status).toBe(400);expect((await request(3,undefined,'viewer','&revision='+'a'.repeat(64))).status).toBe(400);});await f.db.update(systemRole).set({rules:'supplier.order.view'}).where(eq(systemRole.id,22));await unchanged(async()=>expect((await request()).status).toBe(400011));
 }));
 it('preflights a missing attachment SELECT without aborting the same read-only transaction and proves no business DML or sequence privileges',async()=>f.withMediaReader(async runtime=>{
  const[rights]=await runtime.db.execute(sql`SELECT EXISTS(SELECT 1 FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relkind IN('r','p') AND(has_table_privilege(current_user,c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR has_any_column_privilege(current_user,c.oid,'INSERT,UPDATE,REFERENCES'))) AS dml,EXISTS(SELECT 1 FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relkind='S' AND has_sequence_privilege(current_user,c.oid,'USAGE,SELECT,UPDATE')) AS sequence`);expect(rights).toEqual({dml:false,sequence:false});await f.exec(`REVOKE SELECT ON public.system_attachment FROM "${runtime.role}"`);await withTx(runtime.container,async tx=>{await tx.execute(sql`SET TRANSACTION READ ONLY`);await expect(assertSupplierExtractMediaReady(tx)).rejects.toMatchObject({httpStatus:503});expect(await tx.execute(sql`SELECT 1 AS alive`)).toEqual([{alive:1}]);});
 }));
 it('does not expose private media from a changed attachment binding on the next real snapshot',async()=>f.withMediaReader(async runtime=>{
  wiring.container=runtime.container;const revision=await f.revision(3);expect((await media()).previews.qrcode.status).toBe('ready');await f.db.update(systemAttachment).set({relationId:8}).where(eq(systemAttachment.attId,32));await unchanged(async()=>expect((await request(3,revision)).data.previews.qrcode.status).toBe('unavailable'));
 }));
 it('reads row revision and media facts within one actual repeatable-read readonly snapshot',async()=>f.withMediaReader(async runtime=>{
  let wrote=false;const revision=await f.revision(3),original=runtime.db.transaction.bind(runtime.db);
  const intercepted=vi.spyOn(runtime.db,'transaction').mockImplementation((work,options)=>original(async tx=>{
   const execute=tx.execute.bind(tx),observer=vi.spyOn(tx,'execute').mockImplementation(statement=>{
    const query=execute(statement),run=query.execute.bind(query);query.execute=async()=>{const rows=await run();if(!wrote&&Object.hasOwn(rows[0]??{},'rowVersion')&&Object.hasOwn(rows[0]??{},'qrcodeUrl')){wrote=true;expect(await tx.execute(sql`SELECT current_setting('transaction_read_only') AS readonly,current_setting('transaction_isolation') AS isolation`)).toEqual([{readonly:'on',isolation:'repeatable read'}]);await f.db.update(systemAttachment).set({relationId:8}).where(eq(systemAttachment.attId,32));}return rows;};return query;
   });try{return await work(tx);}finally{observer.mockRestore();}
  },options));
  try{const result=await new SupplierExtractMediaService(runtime.container,f.env.APP_KEY).read(actor,3,revision);expect(wrote).toBe(true);expect(result.previews.qrcode.status).toBe('ready');}finally{intercepted.mockRestore();}
  wiring.container=runtime.container;expect((await request(3,revision)).data.previews.qrcode.status).toBe('unavailable');
 }));
});
