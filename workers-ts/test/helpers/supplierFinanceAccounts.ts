/** Real owned PG16/App identities. Object bytes and queue are an explicit local
 * test boundary, not live R2 or proof of real bank/QR identity. */
import {createHash} from 'node:crypto';
import {eq,SQL,sql} from 'drizzle-orm';
import {getTableConfig,PgDialect} from 'drizzle-orm/pg-core';
import {createContainerFromDb,type Container} from '@/lib/di';
import {systemAttachment,systemAttachmentCategory,systemAdmin,systemRole} from '@/models/schema';
import {createToken,md5} from '@/utils/jwt';
import {supplierExtractApplicationFixture} from './supplierExtractApplication';
import {supplierExtractReadPassword} from './supplierExtractRead';
import type {SequenceRunnerPeer} from './kefuSequenceRunnerDatabase';
export type SupplierFinanceAccountsRuntime=SequenceRunnerPeer&{role:string;connectionString:string;container:Container};
const accountColumns='bank_code,bank_address,alipay_account,alipay_qrcode_url,wechat,wechat_qrcode_url';
export async function supplierFinanceAccountsFixture(){
 const f=await supplierExtractApplicationFixture();
 try{
  if(!f.withRuntimeRole)throw Error('Owned independent PG16 LOGIN required');
  const dialect=new PgDialect();
  for(const table of[systemAttachment,systemAttachmentCategory]){
   const definition=getTableConfig(table),columns=definition.columns.map(column=>{
    const initial=column.default,defaultSql=initial===undefined?'':` default ${initial instanceof SQL?dialect.sqlToQuery(initial).sql:dialect.sqlToQuery(sql`${initial}`.inlineParams()).sql}`;
    return `"${column.name}" ${column.getSQLType()}${defaultSql}${column.notNull?' not null':''}${column.primary?' primary key':''}`;
   });await f.exec(`CREATE TABLE "${definition.name}" (${columns.join(',')})`);
  }
  await f.db.update(systemRole).set({rules:'supplier.finance.view,supplier.finance.manage,supplier.attachment.view,supplier.attachment.manage'}).where(eq(systemRole.id,21));
  await f.db.insert(systemRole).values({id:24,type:4,relationId:7,rules:'supplier.finance.view,supplier.finance.manage,supplier.attachment.view'});
  await f.db.insert(systemAdmin).values({id:24,adminType:4,relationId:7,level:1,roles:'24',pwd:supplierExtractReadPassword,account:'owned-finance-accounts24',status:1,isDel:0});
  const png=new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j8l8AAAAASUVORK5CYII=','base64'));
  type Stored={bytes:Uint8Array;httpMetadata?:{contentType?:string};customMetadata?:Record<string,string>};
  const objects=new Map<string,Stored>(),objectCalls:{method:string;key:string}[]=[];
  const bucket={
   put:async(key:string,body:ReadableStream<Uint8Array>,options?:Omit<Stored,'bytes'>)=>{const bytes=new Uint8Array(await new Response(body).arrayBuffer());objects.set(key,{bytes,...options});objectCalls.push({method:'put',key});return{key,size:bytes.byteLength};},
   get:async(key:string)=>{objectCalls.push({method:'get',key});const value=objects.get(key);if(!value)return null;return{key,size:value.bytes.byteLength,etag:createHash('sha256').update(value.bytes).digest('hex'),httpEtag:'"owned-image"',httpMetadata:value.httpMetadata,body:new ReadableStream<Uint8Array>({start(controller){controller.enqueue(value.bytes);controller.close();}}),writeHttpMetadata:(headers:Headers)=>{if(value.httpMetadata?.contentType)headers.set('Content-Type',value.httpMetadata.contentType);}};},
   head:async(key:string)=>{const value=objects.get(key);return value?{key,size:value.bytes.byteLength}:null;},
   delete:async(keys:string|string[])=>{for(const key of typeof keys==='string'?[keys]:keys){objects.delete(key);objectCalls.push({method:'delete',key});}},
   list:async()=>({objects:[...objects].map(([key,v])=>({key,size:v.bytes.byteLength})),truncated:false}),
  };
  for(const[id,type,owner,fileType,moduleType]of[[31,4,7,1,1],[32,4,7,1,1],[41,4,8,1,1],[42,1,0,1,1],[43,4,7,1,2],[44,4,7,2,1]]){
   const key=`attachments/${type===4?'supplier':'admin'}/${owner||1}/2026/10/00000000-0000-4000-8000-${String(id).padStart(12,'0')}.png`;
   await f.db.insert(systemAttachment).values({attId:id,type,relationId:owner,fileType,moduleType,imageType:8,name:key,attDir:'/api/assets/'+id,sattDir:'/api/assets/'+id,attType:'image/png',attSize:String(png.byteLength),realName:'owned-qr-'+id+'.png'});objects.set(key,{bytes:png,httpMetadata:{contentType:'image/png'}});
  }
  await f.db.insert(systemAttachmentCategory).values([{id:1,type:4,relationId:7,fileType:1,name:'本店收款图片'},{id:2,type:4,relationId:8,fileType:1,name:'别店图片'}]);
  await f.exec("SELECT setval(pg_get_serial_sequence('public.system_attachment','att_id'),45,false)");
  const withReader=<T>(work:(runtime:SupplierFinanceAccountsRuntime)=>Promise<T>)=>f.withRuntimeRole!(async peer=>{
   await f.exec(`GRANT SELECT ON public.system_admin,public.system_supplier,public.system_role,public.system_menus,public.system_attachment TO "${peer.role}"`);
   return work({...peer,container:createContainerFromDb(peer.db)});
  });
  const withWriter=<T>(work:(runtime:SupplierFinanceAccountsRuntime)=>Promise<T>)=>withReader(async runtime=>{
   await f.exec(`GRANT UPDATE(${accountColumns}) ON public.system_supplier TO "${runtime.role}"; GRANT UPDATE(id) ON public.system_admin,public.system_role,public.system_menus TO "${runtime.role}"; GRANT UPDATE(att_id) ON public.system_attachment TO "${runtime.role}"`);return work(runtime);
  });
  const withMaterialWriter=<T>(work:(runtime:SupplierFinanceAccountsRuntime)=>Promise<T>)=>withWriter(async runtime=>{
   await f.exec(`GRANT SELECT ON public.system_attachment_category TO "${runtime.role}"; GRANT INSERT ON public.system_attachment TO "${runtime.role}"; GRANT UPDATE(att_dir,satt_dir) ON public.system_attachment TO "${runtime.role}"; GRANT UPDATE(id) ON public.system_attachment_category TO "${runtime.role}"; GRANT USAGE ON SEQUENCE public.system_attachment_att_id_seq TO "${runtime.role}"`);return work(runtime);
  });
  const snapshot=async()=>({...await f.snapshot(),system_attachment:await f.exec('SELECT to_jsonb(t) AS row FROM public.system_attachment t ORDER BY att_id'),system_attachment_category:await f.exec('SELECT to_jsonb(t) AS row FROM public.system_attachment_category t ORDER BY id')});
  const imageSequence=()=>f.exec('SELECT last_value,is_called FROM public.system_attachment_att_id_seq');
  const env={...f.env,ASSETS_BUCKET:bucket,ORDER_QUEUE:{send:async()=>{}}} as unknown as typeof f.env;
  const tokens={...f.tokens,materialViewer:(await createToken(24,'supplier',md5(supplierExtractReadPassword),env.APP_KEY)).token};
  return{...f,withReader,withWriter,withMaterialWriter,withApplicant:f.withApplicant,env,tokens,snapshot,imageSequence,objects,objectCalls,png,
   ids:{alipay:31,weixin:32,foreign:41,admin:42,wrongModule:43,video:44},accountColumns:accountColumns.split(',')};
 }catch(error){await f.close();throw error;}
}
