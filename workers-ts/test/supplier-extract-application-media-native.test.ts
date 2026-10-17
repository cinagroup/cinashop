/** Actual original application, App/JWT and SELECT-only independent PG LOGIN.
 * Object bytes and Admin registration remain owned local fixture boundaries. */
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {eq,sql} from 'drizzle-orm';
import {createApp} from '@/app';
import {createContainerFromDb,withTx,type Container} from '@/lib/di';
import {supplierExtract,supplierFlowingWater,systemAdmin,systemAttachment,systemConfig,systemRole,systemSupplier} from '@/models/schema';
import {AdminSupplierFinanceService} from '@/services/admin/AdminSupplierFinanceService';
import {SupplierExtractApplicationService} from '@/services/supplier/SupplierExtractApplicationService';
import {assertSupplierExtractApplicationMediaReady,SupplierExtractApplicationMediaService} from '@/services/supplier/SupplierExtractApplicationMediaService';
import {supplierExtractApplicationMediaActor as actor,supplierExtractApplicationMediaFixture} from './helpers/supplierExtractApplicationMedia';

const wiring=vi.hoisted(()=>({container:undefined as Container|undefined}));
vi.mock('@/lib/di',async original=>({...await original<typeof import('@/lib/di')>(),createContainer:()=>{
 if(!wiring.container)throw Error('Missing original application media LOGIN');return wiring.container;
}}));
const app=createApp(),path='/supplierapi/finance/supplier_extract/application_operations/';
describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('Supplier original application media actual App and PG16',()=>{
 let f:Awaited<ReturnType<typeof supplierExtractApplicationMediaFixture>>;
 beforeEach(async()=>{
  vi.spyOn(globalThis,'fetch').mockRejectedValue(Error('No original receipt media outbound network'));
  f=await supplierExtractApplicationMediaFixture();
 },30000);
 afterEach(async()=>{try{expect(fetch).not.toHaveBeenCalled();await f?.close();}finally{wiring.container=undefined;vi.restoreAllMocks();}});
 async function request(options:{operationId?:string;requestHash?:string;identity?:'reader'|'viewer'|'denied'|'other'|'anonymous';extra?:string;method?:string}={}){
  const identity=options.identity??'reader',response=await app.request(path+(options.operationId??f.original.operationId)+'/media?request_hash='+(options.requestHash??f.original.requestHash)+(options.extra??''),
   {method:options.method??'GET',headers:identity==='anonymous'?{}:{Authorization:'Bearer '+f.tokens[identity]}},f.env);
  expect(response.headers.get('cache-control')).toContain('private, no-store');expect(response.headers.get('pragma')).toBe('no-cache');
  return response.json<{status:number;data:any}>();
 }
 async function unchanged<T>(work:()=>Promise<T>){
  const before=await f.snapshot(),sequence=await f.sequence(),images=await f.imageSequence(),result=await work();
  expect(await f.snapshot()).toEqual(before);expect(await f.sequence()).toEqual(sequence);expect(await f.imageSequence()).toEqual(images);return result;
 }
 async function media(options:Parameters<typeof request>[0]={}){const response=await request(options);expect(response.status).toBe(200);return response.data;}
 const unavailable=(reference:string)=>({reference,status:'unavailable',src:'',expires_at:null});

 it('delegates only the original QR through seven SELECTs with no financial gallery or business writes',async()=>f.withApplicationMediaReader(async runtime=>{
  await f.db.update(systemRole).set({rules:'supplier.order.view'}).where(eq(systemRole.id,21));
  wiring.container=runtime.container;
  const[rights]=await runtime.db.execute(sql`SELECT
   (SELECT count(*)::int FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relkind IN('r','p') AND has_table_privilege(current_user,c.oid,'SELECT')) AS readable,
   EXISTS(SELECT 1 FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relkind IN('r','p') AND(has_table_privilege(current_user,c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR has_any_column_privilege(current_user,c.oid,'INSERT,UPDATE,REFERENCES'))) AS dml,
   EXISTS(SELECT 1 FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relkind='S' AND has_sequence_privilege(current_user,c.oid,'USAGE,SELECT,UPDATE')) AS sequence`);
  expect(rights).toEqual({readable:7,dml:false,sequence:false});
  await unchanged(async()=>{
   expect((await media()).preview.status).toBe('ready');
   const gallery=await app.request('/supplierapi/file/file',{headers:{Authorization:'Bearer '+f.tokens.reader}},f.env);
   expect((await gallery.json<{status:number}>()).status).toBe(400011);
  });
 }));
 it('returns closed8 and closed4 plus real signed PNG while preserving original operation and both sequences',async()=>f.withApplicationMediaReader(async runtime=>{
  wiring.container=runtime.container;
  await unchanged(async()=>{
   const result=await media();
   expect(Object.keys(result).sort()).toEqual(['version','operation_id','actor_id','supplier_id','request_hash','extract_id','preview','bounded'].sort());
   expect(result).toMatchObject({version:'supplier-extract-application-media-v1',operation_id:f.original.operationId,actor_id:21,supplier_id:7,request_hash:f.original.requestHash,extract_id:205,bounded:true});
   expect(Object.keys(result.preview).sort()).toEqual(['reference','status','src','expires_at'].sort());
   expect(result.preview).toMatchObject({reference:'/api/assets/31',status:'ready'});
   const url=new URL(result.preview.src,'http://owned.invalid');
   expect(url.pathname).toBe('/api/assets/31');expect(url.searchParams.get('signature')).toMatch(/^[A-Za-z0-9_-]{43}$/);
   expect(Number(url.searchParams.get('expires'))).toBe(result.preview.expires_at);
   expect(result.preview.expires_at).toBeGreaterThan(Math.floor(Date.now()/1000));expect(result.preview.expires_at).toBeLessThanOrEqual(Math.floor(Date.now()/1000)+300);
   const image=await app.request(result.preview.src,{},f.env);expect(image.status).toBe(200);expect(new Uint8Array(await image.arrayBuffer())).toEqual(f.png);
  });
 }));
 it('retains original media and receipt after Admin note approval transfer and current finance settings limits balance and capabilities change',async()=>{
  const admin=new AdminSupplierFinanceService(createContainerFromDb(f.db));
  await admin.updateMark(f.original.extractId,101,{mark:'后台合法新说明',expected_supplier_mark:'原申请收款二维码核验'});
  await admin.review(f.original.extractId,101,{type:1});await admin.transfer(f.original.extractId,101,{voucher_title:'本机转账登记',voucher_image:'/api/assets/42'});
  await f.db.update(systemSupplier).set({alipayAccount:'today-other-account',alipayQrcodeUrl:'/api/assets/41',wechatQrcodeUrl:'/api/assets/41'}).where(eq(systemSupplier.id,7));
  await f.db.update(systemConfig).set({value:'invalid-current-limit'}).where(eq(systemConfig.id,2));
  await f.db.update(supplierFlowingWater).set({number:'1001.00'}).where(eq(supplierFlowingWater.id,1));
  await f.db.update(systemRole).set({rules:'supplier.order.view'}).where(eq(systemRole.id,21));
  await f.withLookup(async runtime=>{
   wiring.container=runtime.container;await unchanged(async()=>{
    const receipt=await app.request(path+f.original.operationId,{headers:{Authorization:'Bearer '+f.tokens.reader}},f.env);
    expect(await receipt.json()).toMatchObject({status:200,data:f.original.receipt});
   });
  });
  await f.withApplicationMediaReader(async runtime=>{
   wiring.container=runtime.container;await unchanged(async()=>{
    const result=await media();expect(result.preview.reference).toBe('/api/assets/31');expect(result.preview.status).toBe('ready');
    expect(Object.hasOwn(result,'voucher')).toBe(false);expect(Object.hasOwn(result.preview,'voucher')).toBe(false);
   });
  });
 });
 it('keeps original QR available after a legitimate Admin refusal without re-admitting the released original UUID',async()=>{
  await new AdminSupplierFinanceService(createContainerFromDb(f.db)).review(f.original.extractId,101,{type:0,message:'本机拒绝申请'});
  await f.withApplicationMediaReader(async runtime=>{wiring.container=runtime.container;await unchanged(async()=>expect((await media()).preview.status).toBe('ready'));});
 });
 it('does not sign or expose an original operation to another actor or Supplier even with the correct original hash',async()=>f.withApplicationMediaReader(async runtime=>{
  wiring.container=runtime.container;await unchanged(async()=>{
   for(const identity of['viewer','denied','other']as const){
    const response=await request({identity});expect(response.status).toBe(404);expect(response.data).toBeNull();
    expect((await request({identity,requestHash:'b'.repeat(64)})).status).toBe(404);
   }
  });
 }));
 it('returns the same empty404 for unknown and durable not_applied UUIDs without signing or sealing another operation',async()=>{
  const unknown=randomUUID(),closed=randomUUID();
  await f.withApplicant(async runtime=>{expect((await new SupplierExtractApplicationService(runtime.container,f.env.APP_KEY).resolve(closed,actor)).state).toBe('not_applied');});
  await f.withApplicationMediaReader(async runtime=>{
   wiring.container=runtime.container;await unchanged(async()=>{
    for(const operationId of[unknown,closed]){const response=await request({operationId,requestHash:'a'.repeat(64)});expect(response.status).toBe(404);expect(response.data).toBeNull();}
   });
  });
 });
 it('rejects a mismatched original request hash before signing any QR',async()=>f.withApplicationMediaReader(async runtime=>{
  wiring.container=runtime.container;await unchanged(async()=>expect((await request({requestHash:'b'.repeat(64)})).status).toBe(409));
 }));
 it('rejects duplicate hash and arbitrary attachment reference actor and tenant selectors',async()=>f.withApplicationMediaReader(async runtime=>{
  wiring.container=runtime.container;await unchanged(async()=>{
   for(const extra of['&request_hash='+f.original.requestHash,'&attachment=31','&ref=/api/assets/31','&actor_id=21','&supplier_id=7'])expect((await request({extra})).status).toBe(400);
   for(const requestHash of['','A'.repeat(64),'a'.repeat(63)])expect((await request({requestHash})).status).toBe(400);
  });
 }));
 it('keeps the media admission exact and rejects POST extra path and malformed UUID neighbors',async()=>f.withApplicationMediaReader(async runtime=>{
  wiring.container=runtime.container;await unchanged(async()=>{
   expect((await request({method:'POST'})).status).toBe(400011);
   expect((await request({operationId:'invalid'})).status).toBe(400011);
   const response=await app.request(path+f.original.operationId+'/media/31?request_hash='+f.original.requestHash,{headers:{Authorization:'Bearer '+f.tokens.reader}},f.env);
   expect((await response.json<{status:number}>()).status).toBe(400011);
  });
 }));
 it('does not publish a bank QR and preserves its original empty reference',async()=>{
  const bank=await f.createApplication({extractType:'bank'});
  await f.withApplicationMediaReader(async runtime=>{wiring.container=runtime.container;await unchanged(async()=>expect((await media({operationId:bank.operationId,requestHash:bank.requestHash})).preview).toEqual(unavailable('')));});
 });
 it('renews the stored expired Kefu alias without trusting its ticket or changing the raw original reference',async()=>{
  const reference='/kefuapi/assets/31?expires=1&signature='+'a'.repeat(43),original=await f.createApplication({reference});
  await f.withApplicationMediaReader(async runtime=>{wiring.container=runtime.container;await unchanged(async()=>{
   const result=await media({operationId:original.operationId,requestHash:original.requestHash});expect(result.preview.reference).toBe(reference);
   expect(result.preview.src).toMatch(/^\/api\/assets\/31\?expires=\d+&signature=[A-Za-z0-9_-]{43}$/);expect(result.preview.expires_at).toBeGreaterThan(1);
  });});
 });
 it.each(['/owned-media/original-qr.png?x=1&y=2','javascript:legacy','https://private.invalid/api/assets/31'])('projects only the literal authorized reference from an actual original application %s',async reference=>{
  const original=await f.createApplication({reference});
  await f.withApplicationMediaReader(async runtime=>{wiring.container=runtime.container;await unchanged(async()=>{
   const result=await media({operationId:original.operationId,requestHash:original.requestHash});
   expect(result.preview).toEqual(reference.startsWith('/owned-media/')?{reference,status:'ready',src:reference,expires_at:null}:unavailable(reference));
  });});
 });
 it.each(['type','relationId','moduleType','fileType','imageType','attDir','name','attType'])('does not borrow a private image with changed actual %s scope',async field=>{
  const changes={type:1,relationId:8,moduleType:2,fileType:2,imageType:7,attDir:'/api/assets/32',name:'attachments/admin/1/other.png',attType:'text/html'};
  await f.db.update(systemAttachment).set({[field]:changes[field as keyof typeof changes]}).where(eq(systemAttachment.attId,31));
  await f.withApplicationMediaReader(async runtime=>{wiring.container=runtime.container;await unchanged(async()=>expect((await media()).preview).toEqual(unavailable('/api/assets/31')));});
 });
 it('returns unavailable after the actual referenced attachment is deleted without changing the original result',async()=>{
  await f.db.delete(systemAttachment).where(eq(systemAttachment.attId,31));
  await f.withApplicationMediaReader(async runtime=>{wiring.container=runtime.container;await unchanged(async()=>expect((await media()).preview).toEqual(unavailable('/api/assets/31')));});
 });
 it.each(['qrcodeUrl','alipayAccount','extractPrice','supplierId','status'])('refuses changed actual original application %s evidence instead of projecting an image',async field=>{
  const changes={qrcodeUrl:'/api/assets/32',alipayAccount:'corrupt-account',extractPrice:'26.50',supplierId:8,status:9};
  await f.db.update(supplierExtract).set({[field]:changes[field as keyof typeof changes]}).where(eq(supplierExtract.id,f.original.extractId));
  await f.withApplicationMediaReader(async runtime=>{wiring.container=runtime.container;await unchanged(async()=>expect((await request()).status).toBe(503));});
 });
 it('refuses a corrupted canonical original operation hash before issuing a signature',async()=>{
  await f.exec(`ALTER TABLE public.supplier_extract_application_operation_v1 DISABLE TRIGGER seao_rows; UPDATE public.supplier_extract_application_operation_v1 SET source_hash=repeat('b',64); ALTER TABLE public.supplier_extract_application_operation_v1 ENABLE TRIGGER seao_rows`);
  await f.withApplicationMediaReader(async runtime=>{wiring.container=runtime.container;await unchanged(async()=>expect((await request()).status).toBe(503));});
 });
 it('requires a current live JWT even though current financial capabilities are not required',async()=>f.withApplicationMediaReader(async runtime=>{
  wiring.container=runtime.container;await unchanged(async()=>expect((await request({identity:'anonymous'})).status).toBe(410000));
  const service=new SupplierExtractApplicationMediaService(runtime.container,f.env.APP_KEY);
  await unchanged(async()=>expect(service.read({...actor,expiresAt:1},f.original.operationId,f.original.requestHash)).rejects.toMatchObject({code:410001}));
  await f.db.update(systemAdmin).set({pwd:'changed-original-password'}).where(eq(systemAdmin.id,21));
  await unchanged(async()=>{expect((await request()).status).toBe(410001);await expect(service.read(actor,f.original.operationId,f.original.requestHash)).rejects.toMatchObject({code:410001});});
 }));
 it('does not project an original application for a currently disabled Supplier',async()=>{
  await f.db.update(systemSupplier).set({isShow:0}).where(eq(systemSupplier.id,7));
  await f.withApplicationMediaReader(async runtime=>{wiring.container=runtime.container;await unchanged(async()=>expect((await request()).status).toBe(410002));});
 });
 it.each(['system_attachment','supplier_extract_application_operation_v1'])('preflights missing %s SELECT without aborting the same read-only transaction',async table=>f.withApplicationMediaReader(async runtime=>{
  await f.exec(`REVOKE SELECT ON public.${table} FROM "${runtime.role}"`);
  await withTx(runtime.container,async tx=>{
   await tx.execute(sql`SET TRANSACTION READ ONLY`);await expect(assertSupplierExtractApplicationMediaReady(tx)).rejects.toMatchObject({httpStatus:503});
   expect(await tx.execute(sql`SELECT 1 AS alive`)).toEqual([{alive:1}]);
  });
  wiring.container=runtime.container;await unchanged(async()=>expect((await request()).status).toBe(503));
 }));
 it('does not admit a maintenance owner connection for public media reads',async()=>{
  await unchanged(async()=>expect(new SupplierExtractApplicationMediaService(createContainerFromDb(f.db),f.env.APP_KEY)
   .read(actor,f.original.operationId,f.original.requestHash)).rejects.toMatchObject({httpStatus:503}));
 });
 it('reads the original operation actual row and attachment in one real repeatable-read read-only snapshot',async()=>f.withApplicationMediaReader(async runtime=>{
  let wrote=false;const original=runtime.db.transaction.bind(runtime.db);
  const intercepted=vi.spyOn(runtime.db,'transaction').mockImplementation((work,options)=>original(async tx=>{
   const execute=tx.execute.bind(tx),observer=vi.spyOn(tx,'execute').mockImplementation(statement=>{
    const query=execute(statement),run=query.execute.bind(query);query.execute=async()=>{
     const rows=await run();if(!wrote&&rows[0]?.operation_id===f.original.operationId){
      wrote=true;expect(await tx.execute(sql`SELECT current_setting('transaction_read_only') AS readonly,current_setting('transaction_isolation') AS isolation`)).toEqual([{readonly:'on',isolation:'repeatable read'}]);
      await f.db.update(systemAttachment).set({relationId:8}).where(eq(systemAttachment.attId,31));
     }return rows;
    };return query;
   });try{return await work(tx);}finally{observer.mockRestore();}
  },options));
  try{const result=await new SupplierExtractApplicationMediaService(runtime.container,f.env.APP_KEY).read(actor,f.original.operationId,f.original.requestHash);expect(wrote).toBe(true);expect(result.preview.status).toBe('ready');}
  finally{intercepted.mockRestore();}
  wiring.container=runtime.container;await unchanged(async()=>expect((await media()).preview).toEqual(unavailable('/api/assets/31')));
 }));
});
