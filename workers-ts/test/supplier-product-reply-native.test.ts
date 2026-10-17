/** Public App/JWT, actual PG16 and independent reader/narrow writer LOGINs. */
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {eq,sql} from 'drizzle-orm';
import {createApp} from '@/app';
import {withTx,type Container,type DbClient} from '@/lib/di';
import {storeProductReply,storeProductReplyComment,systemAdmin,systemMenus,systemRole,systemSupplier} from '@/models/schema';
import {lockProductWrite} from '@/services/product/ProductAssociationService';
import {assertSupplierProductReplyReadReady,SupplierProductReplyService} from '@/services/supplier/SupplierProductReplyService';
import {supplierProductReplyActor as actor,supplierProductReplyFixture} from './helpers/supplierProductReply';
const wiring=vi.hoisted(()=>({container:undefined as Container|undefined}));
vi.mock('@/lib/di',async original=>({...await original<typeof import('@/lib/di')>(),createContainer:()=>{
 if(!wiring.container)throw Error('Missing owned review LOGIN');return wiring.container;
}}));
const app=createApp(),path='/supplierapi/product/reply';
describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('Supplier product review drill-through actual App and PG16',()=>{
 let f:Awaited<ReturnType<typeof supplierProductReplyFixture>>;
 beforeEach(async()=>{vi.spyOn(globalThis,'fetch').mockRejectedValue(Error('No review provider I/O'));f=await supplierProductReplyFixture();},30000);
 afterEach(async()=>{try{expect(fetch).not.toHaveBeenCalled();}finally{try{await f?.close();}finally{wiring.container=undefined;vi.restoreAllMocks();}}});
 async function request(query='',body?:unknown,id=601,identity:'reader'|'viewer'|'denied'|'other'|'anonymous'='reader'){
  const response=await app.request(path+(body===undefined?'':'/set_reply/'+id)+query,{method:body===undefined?'GET':'PUT',
   headers:{...(identity==='anonymous'?{}:{Authorization:'Bearer '+f.tokens[identity]}),...(body===undefined?{}:{'Content-Type':'application/json'})},
   ...(body===undefined?{}:{body:JSON.stringify(body)})},f.env);
  expect(response.headers.get('cache-control')).toContain('no-store');return response.json<{status:number;data:any}>();
 }
 async function unchanged<T>(work:()=>Promise<T>){const before=await f.snapshot(),sequence=await f.sequence(),result=await work();expect(await f.snapshot()).toEqual(before);expect(await f.sequence()).toEqual(sequence);return result;}
 async function list(query='?product_id=80',identity:'reader'|'viewer'|'denied'|'other'='reader'){
  const result=await request(query,undefined,601,identity);expect(result.status).toBe(200);return result.data;
 }
 async function waitBlocked(tx:Pick<DbClient,'execute'>,pid:number){
  let blocked=false;for(let i=0;i<100&&!blocked;i++){const[row]=await tx.execute(sql`SELECT cardinality(pg_blocking_pids(${pid}))>0 AS blocked`);blocked=row.blocked===true;if(!blocked)await new Promise(done=>setTimeout(done,10));}expect(blocked).toBe(true);
 }
 it('binds exact product80 and81 with total rows pagination and only this Supplier official replies',async()=>f.withReader(async runtime=>{
  wiring.container=runtime.container;await unchanged(async()=>{
   const first=await list('?product_id=80&page=1&limit=1');expect(first).toMatchObject({count:2,page:1,limit:1});expect(first.list.map((x:any)=>x.id)).toEqual([601]);expect(first.list[0]).toMatchObject({product_id:80,store_name:'本机商品甲',nickname:'本机客户甲',comment:'商品甲原始评价',score:4,replyComment:null});
   expect((await list('?product_id=80&page=2&limit=1')).list.map((x:any)=>x.id)).toEqual([603]);
   const second=await list('?product_id=81');expect(second.count).toBe(1);expect(second.list[0]).toMatchObject({id:602,product_id:81,replyComment:{id:702,content:'本店原有官方回复'}});
   expect((await list('')).count).toBe(3);
  });
 }));
 it('keeps PHP reply status product and customer filters within the selected product',async()=>f.withReader(async runtime=>{
  wiring.container=runtime.container;await unchanged(async()=>{
   expect((await list('?product_id=80&is_reply=0&account=客户甲')).list.map((x:any)=>x.id)).toEqual([601]);
   expect((await list('?product_id=80&is_reply=1')).count).toBe(0);
   expect((await list('?product_id=81&store_name=甲')).count).toBe(0);
   expect((await list('?product_id=80&store_name=甲特定词')).count).toBe(2);
   expect((await list('?product_id=90')).count).toBe(0);
  });
 }));
 it('hides wrong review product type tenant soft-deletion and cross-owner joins without mutating source data',async()=>f.withReader(async runtime=>{
  wiring.container=runtime.container;await unchanged(async()=>{
   const all=await list('');expect(all.list.map((x:any)=>x.id)).toEqual([601,602,603]);
   expect((await list('?product_id=80','other')).count).toBe(0);expect((await list('?product_id=90','other')).list.map((x:any)=>x.id)).toEqual([604]);
   expect((await list('?product_id=91')).count).toBe(0);
  });
 }));
 it('uses a seven-SELECT pure reader with no public business DML or sequence privileges',async()=>f.withReader(async runtime=>{
  const[rights]=await runtime.db.execute(sql`SELECT
   (SELECT count(*)::int FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relkind IN('r','p')AND has_table_privilege(current_user,c.oid,'SELECT'))AS readable,
   EXISTS(SELECT 1 FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relkind IN('r','p')AND(has_table_privilege(current_user,c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')OR has_any_column_privilege(current_user,c.oid,'INSERT,UPDATE,REFERENCES')))AS dml,
   EXISTS(SELECT 1 FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relkind='S'AND has_sequence_privilege(current_user,c.oid,'USAGE,SELECT,UPDATE'))AS sequence`);
  expect(rights).toEqual({readable:7,dml:false,sequence:false});wiring.container=runtime.container;await unchanged(()=>list('?product_id=80','viewer'));
 }));
 it('creates and updates only one own official reply with unchanged original review rating SKU and financial tables',async()=>f.withWriter(async runtime=>{
  wiring.container=runtime.container;const before=await f.snapshot(),created=await request('',{content:'  本店首次公开回复  ',expected_product_id:80});
  expect(created).toMatchObject({status:200,data:{id:601,comment_id:1000,is_reply:1}});expect(await f.sequence()).toEqual([{last_value:'1000',is_called:true}]);
  const after=await f.snapshot(),added=after.store_product_reply_comment.find((x:any)=>x.row.id===1000)!;
  expect(added.row).toMatchObject({reply_id:601,type:2,relation_id:7,uid:0,pid:0,content:'本店首次公开回复',is_del:0});
  const normalized={...after,store_product_reply:after.store_product_reply.map((x:any)=>x.row.id===601?{row:{...x.row,is_reply:0}}:x),
   store_product_reply_comment:after.store_product_reply_comment.filter((x:any)=>x.row.id!==1000)};expect(normalized).toEqual(before);
  expect((await request('',{content:'本店修改公开回复',expected_product_id:80})).data).toEqual(created.data);
  const updated=await f.snapshot(),changed=updated.store_product_reply_comment.find((x:any)=>x.row.id===1000)!;
  expect(changed.row.content).toBe('本店修改公开回复');expect({...changed.row,content:added.row.content,update_time:added.row.update_time}).toEqual(added.row);
  expect({...updated,store_product_reply_comment:updated.store_product_reply_comment.map((x:any)=>x.row.id===1000?added:x)}).toEqual(after);
  expect(await f.sequence()).toEqual([{last_value:'1000',is_called:true}]);
  await unchanged(async()=>{const row=(await list()).list.find((x:any)=>x.id===601);expect(row.is_reply).toBe(1);expect(row.replyComment).toMatchObject({id:1000,content:'本店修改公开回复'});});
 }));
 it('keeps the old content-only PUT and updates the existing Supplier reply rather than a platform or user comment',async()=>f.withWriter(async runtime=>{
  wiring.container=runtime.container;const before=await f.snapshot();expect((await request('',{content:'兼容旧回复'},602)).data).toMatchObject({id:602,comment_id:702,is_reply:1});
  const after=await f.snapshot(),previous=before.store_product_reply_comment.find((x:any)=>x.row.id===702)!;
  expect({...after,store_product_reply_comment:after.store_product_reply_comment.map((x:any)=>x.row.id===702?previous:x)}).toEqual(before);
  expect(await f.sequence()).toEqual([{last_value:'1000',is_called:false}]);
 }));
 it('requires current manage authority for writes while view-only reads remain available',async()=>f.withWriter(async runtime=>{
  wiring.container=runtime.container;await unchanged(async()=>{
   expect((await list('?product_id=80','viewer')).count).toBe(2);
   expect((await request('',{content:'不能写',expected_product_id:80},601,'viewer')).status).toBe(400011);
   expect((await request('?product_id=80',undefined,601,'denied')).status).toBe(400011);
   expect((await request('',undefined,601,'anonymous')).status).toBe(410000);
  });
 }));
 it.each([604,605,606,607,608,609])('rejects actual cross-owner or inactive review %i before a comment or state change',async id=>f.withWriter(async runtime=>{
  wiring.container=runtime.container;await unchanged(async()=>expect((await request('',{content:'不得跨归属'},id)).status).toBe(404));
 }));
 it('rejects a product mismatch forged body query selectors and duplicate product filters before writes',async()=>f.withWriter(async runtime=>{
  wiring.container=runtime.container;await unchanged(async()=>{
   expect((await request('',{content:'错商品',expected_product_id:81})).status).toBe(409);
   for(const body of[{content:'越权',supplier_id:8},{content:'错类型',expected_product_id:'80'},{content:'原状态',is_reply:1},{expected_product_id:80}])expect((await request('',body)).status).toBe(400);
   expect((await request('?product_id=80',{content:'错入口',expected_product_id:80})).status).toBe(400);
   expect((await request('?product_id=80&product_id=81')).status).toBe(400);
   expect((await request('?product_id=-1')).status).toBe(400);
  });
 }));
 it('checks expected product against the actual final locked review after waiting on the old product mutex',async()=>f.withWriter(async runtime=>{
  const service=new SupplierProductReplyService(runtime.container),before=await f.snapshot();let pending:Promise<{value?:unknown;error?:unknown}>|undefined;
  await f.db.transaction(async owner=>{
   await lockProductWrite(owner as unknown as DbClient,80);pending=service.setReply(7,601,'不能回复已迁移商品',actor,80).then(value=>({value}),error=>({error}));
   await waitBlocked(owner,runtime.pid);await owner.update(storeProductReply).set({productId:81}).where(eq(storeProductReply.id,601));
  });
  expect((await pending!)?.error).toMatchObject({httpStatus:409});const after=await f.snapshot();
  expect({...after,store_product_reply:after.store_product_reply.map((x:any)=>x.row.id===601?{row:{...x.row,product_id:80}}:x)}).toEqual(before);
  expect(await f.sequence()).toEqual([{last_value:'1000',is_called:false}]);
 }));
 it.each(['role','password','supplier','menu'])('fails NOWAIT while a real uncommitted %s authority writer owns the row and succeeds after rollback',async change=>f.withWriter(async runtime=>{
  if(change==='menu')await f.db.update(systemRole).set({rules:'401,402'}).where(eq(systemRole.id,21));
  const before=await f.snapshot(),service=new SupplierProductReplyService(runtime.container),rollback=new Error('Owned authority rollback');
  await expect(f.db.transaction(async owner=>{
   if(change==='role')await owner.update(systemRole).set({rules:'supplier.product.view'}).where(eq(systemRole.id,21));
   if(change==='password')await owner.update(systemAdmin).set({pwd:'uncommitted-password'}).where(eq(systemAdmin.id,21));
   if(change==='supplier')await owner.update(systemSupplier).set({isShow:0}).where(eq(systemSupplier.id,7));
   if(change==='menu')await owner.update(systemMenus).set({access:0}).where(eq(systemMenus.id,402));
   await expect(service.setReply(7,601,'不能提交',actor,80)).rejects.toMatchObject({httpStatus:409});throw rollback;
  })).rejects.toBe(rollback);
  expect(await f.snapshot()).toEqual(before);expect((await service.setReply(7,601,'回滚后允许',actor,80)).comment_id).toBe(1000);
 }));
 it('rejects an expired JWT after the shared product lock wait without inserting or consuming the comment sequence',async()=>f.withWriter(async runtime=>{
  const service=new SupplierProductReplyService(runtime.container),expiresAt=Math.floor(Date.now()/1000)+2,before=await f.snapshot();let pending:Promise<{value?:unknown;error?:unknown}>|undefined;
  await f.db.transaction(async owner=>{
   await lockProductWrite(owner as unknown as DbClient,80);pending=service.setReply(7,601,'过期后不能发布',{...actor,expiresAt},80).then(value=>({value}),error=>({error}));await waitBlocked(owner,runtime.pid);
   for(let tries=0;tries<100;tries++){const[row]=await owner.execute(sql`SELECT floor(extract(epoch FROM clock_timestamp()))::integer AS now`);if(Number(row.now)>=expiresAt)break;await new Promise(done=>setTimeout(done,25));}
  });expect((await pending!)?.error).toMatchObject({code:410001});expect(await f.snapshot()).toEqual(before);expect(await f.sequence()).toEqual([{last_value:'1000',is_called:false}]);
 }));
 it('rejects committed role and password changes through actual App/JWT',async()=>f.withWriter(async runtime=>{
  wiring.container=runtime.container;await f.db.update(systemRole).set({rules:'supplier.product.view'}).where(eq(systemRole.id,21));await unchanged(async()=>expect((await request('',{content:'已撤权',expected_product_id:80})).status).toBe(400011));
  await f.db.update(systemAdmin).set({pwd:'changed-current-password'}).where(eq(systemAdmin.id,21));await unchanged(async()=>expect((await request('?product_id=80')).status).toBe(410001));
 }));
 it('proves the independent writer only has comment content/time and is_reply business updates plus id lock qualification',async()=>f.withWriter(async runtime=>{
  for(const table of['system_admin','system_supplier','system_role','system_menus','store_product','store_product_reply','store_product_reply_comment']){
   const rows=await runtime.db.execute(sql`SELECT a.attname AS name,has_column_privilege(current_user,c.oid,a.attnum,'UPDATE')AS allowed FROM pg_class c JOIN pg_attribute a ON a.attrelid=c.oid WHERE c.relnamespace='public'::regnamespace AND c.relname=${table} AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attname`);
   const allowed=rows.filter(x=>x.allowed===true).map(x=>x.name);expect(allowed).toEqual(table==='store_product_reply'?['is_reply']:table==='store_product_reply_comment'?['content','update_time']:['id']);
  }
  const[extra]=await runtime.db.execute(sql`SELECT EXISTS(SELECT 1 FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relkind IN('r','p') AND has_table_privilege(current_user,c.oid,'DELETE,TRUNCATE,REFERENCES,TRIGGER'))AS destructive,
   EXISTS(SELECT 1 FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relkind='S'AND c.relname<>'store_product_reply_comment_id_seq'AND has_sequence_privilege(current_user,c.oid,'USAGE,SELECT,UPDATE'))AS other_sequence`);expect(extra).toEqual({destructive:false,other_sequence:false});
 }));
 it('preflights missing comment SELECT without aborting the same read-only transaction',async()=>f.withReader(async runtime=>{
  await f.exec(`REVOKE SELECT ON public.store_product_reply_comment FROM "${runtime.role}"`);
  await withTx(runtime.container,async tx=>{await tx.execute(sql`SET TRANSACTION READ ONLY`);await expect(assertSupplierProductReplyReadReady(tx)).rejects.toMatchObject({httpStatus:503});expect(await tx.execute(sql`SELECT 1 AS alive`)).toEqual([{alive:1}]);});
  wiring.container=runtime.container;await unchanged(async()=>expect((await request('?product_id=80')).status).toBe(503));
 }));
 it('reads rows count and official replies in one actual RR readonly snapshot despite an independent committed change',async()=>f.withReader(async runtime=>{
  let changed=false;const original=runtime.db.transaction.bind(runtime.db);
  const intercepted=vi.spyOn(runtime.db,'transaction').mockImplementation((work,options)=>original(async tx=>{
   const execute=tx.execute.bind(tx),observer=vi.spyOn(tx,'execute').mockImplementation(statement=>{
    const query=execute(statement),run=query.execute.bind(query);query.execute=async()=>{const rows=await run();if(!changed&&rows[0]?.ready===true){changed=true;
     expect(await tx.execute(sql`SELECT current_setting('transaction_read_only')AS readonly,current_setting('transaction_isolation')AS isolation`)).toEqual([{readonly:'on',isolation:'repeatable read'}]);
     await f.db.transaction(async owner=>{await owner.update(storeProductReply).set({isDel:1}).where(eq(storeProductReply.id,603));await owner.update(storeProductReplyComment).set({content:'独立已提交的新回复'}).where(eq(storeProductReplyComment.id,702));});
    }return rows;};return query;
   });try{return await work(tx);}finally{observer.mockRestore();}
  },options));
  try{const result=await new SupplierProductReplyService(runtime.container).list(7,{},actor);expect(changed).toBe(true);expect(result.count).toBe(3);expect(result.list.find(row=>row.id===602)?.replyComment?.content).toBe('本店原有官方回复');}finally{intercepted.mockRestore();}
  wiring.container=runtime.container;await unchanged(async()=>{const next=await list('');expect(next.count).toBe(2);expect(next.list.find((row:any)=>row.id===602).replyComment.content).toBe('独立已提交的新回复');});
 }));
});
