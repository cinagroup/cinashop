/** Historical owned catalogue inputs and local object binding; no product,
 * payment or provider producer lifecycle is claimed by these read fixtures. */
import {createHash} from 'node:crypto';
import {eq,SQL,sql} from 'drizzle-orm';
import {getTableConfig,PgDialect,type PgTable} from 'drizzle-orm/pg-core';
import {createContainerFromDb} from '@/lib/di';
import {storeProduct,storeProductAttr,storeProductAttrValue,storeProductDescription,systemAttachment} from '@/models/schema';
import {supplierProductReplyFixture,type SupplierProductReplyRuntime} from './supplierProductReply';
export {supplierProductReplyActor as supplierProductDetailActor} from './supplierProductReply';
export async function supplierProductDetailFixture(){
 const f=await supplierProductReplyFixture();
 try{
  const extra=[storeProductAttr,storeProductDescription,systemAttachment]as PgTable[],dialect=new PgDialect();
  for(const table of extra){const definition=getTableConfig(table),columns=definition.columns.map(column=>{
   const initial=column.default,defaultSql=initial===undefined?'':` default ${initial instanceof SQL?dialect.sqlToQuery(initial).sql:dialect.sqlToQuery(sql`${initial}`.inlineParams()).sql}`;
   return `"${column.name}" ${column.getSQLType()}${defaultSql}${column.notNull?' not null':''}${column.primary?' primary key':''}`;
  });await f.exec(`CREATE TABLE "${definition.name}" (${columns.join(',')})`);}
  await f.db.update(storeProduct).set({storeInfo:'商品甲只读简介',unitName:'件',barCode:'000001',sliderImage:'["/api/assets/31","/owned-media/product80.png"]',
   image:'/api/assets/31',otPrice:'29.99',vipPrice:'18.00',sales:5,specType:1,postage:'3.50',isVerify:-1,refusal:'合成审核驳回原因',
   videoLink:'/api/assets/41',cost:'13.37',settlePrice:'12.34',addTime:1791158400}).where(eq(storeProduct.id,80));
  await f.db.update(storeProduct).set({productType:1,storeInfo:'固定内容不得进入只读投影',image:'/owned-media/product81.png',sliderImage:'[]'}).where(eq(storeProduct.id,81));
  await f.db.insert(storeProduct).values({id:92,type:2,relationId:7,storeName:'已回收商品',isDel:1});
  await f.db.update(storeProductAttrValue).set({price:'19.99',otPrice:'29.99',vipPrice:'18.00',stock:9,sales:4,image:'/api/assets/31',barCode:'SKU000180',
   diskInfo:'OWNED_FIXED_DELIVERY_SECRET_180',cost:'11.11',settlePrice:'10.10',brokerage:'1.00',code:'OWNED_CARD_CODE_180'}).where(eq(storeProductAttrValue.id,180));
  await f.db.insert(storeProductAttrValue).values([
   {id:181,productId:80,type:0,unique:'detail81',suk:'红',price:'21.00',stock:3,sales:1,image:'/api/assets/32',diskInfo:'OWNED_FIXED_DELIVERY_SECRET_181'},
   {id:182,productId:80,type:0,unique:'retire82',suk:'退役',price:'99.00',stock:88,isRetired:1,diskInfo:'OWNED_RETIRED_SECRET_182'},
   {id:183,productId:81,type:0,unique:'secret83',suk:'固定内容',price:'25.00',stock:7,diskInfo:'OWNED_FIXED_DELIVERY_SECRET_183',code:'OWNED_SECRET_CODE_183'},
   {id:184,productId:80,type:1,unique:'actsku84',suk:'活动SKU不能借入',stock:99,diskInfo:'OWNED_ACTIVITY_SECRET_184'},
  ]);
  await f.db.insert(storeProductAttr).values([{id:1,productId:80,type:0,attrName:'颜色',attrValues:'蓝,红'},
   {id:2,productId:81,type:0,attrName:'内容',attrValues:'固定内容'},{id:3,productId:80,type:1,attrName:'错误活动维度',attrValues:'不能出现'}]);
  await f.db.insert(storeProductDescription).values([{productId:80,type:0,description:'<p>本机商品甲详情<script>secret-script()</script></p><img src="/kefuapi/assets/31"><img src="/api/assets/32"><iframe src="https://invalid.example"></iframe>'},
   {productId:81,type:0,description:'<p>商品乙公开介绍</p>'},{productId:80,type:1,description:'错误活动详情不能借入'}]);
  const png=new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j8l8AAAAASUVORK5CYII=','base64'));
  const objects=new Map<string,{bytes:Uint8Array;mime:string}>(),objectCalls:{method:string;key:string}[]=[];
  for(const[id,owner,file,mime]of[[31,7,1,'image/png'],[32,8,1,'image/png'],[41,7,2,'video/mp4']]as const){
   const key=`attachments/supplier/${owner}/2026/10/owned-detail-${id}.${file===1?'png':'mp4'}`,bytes=file===1?png:new Uint8Array([0,0,0,24,102,116,121,112,109,112,52,50]);
   await f.db.insert(systemAttachment).values({attId:id,type:4,relationId:owner,fileType:file,moduleType:1,imageType:8,
    name:key,attDir:'/api/assets/'+id,sattDir:'/api/assets/'+id,attType:mime,attSize:String(bytes.byteLength),realName:'owned-detail-'+id});
   objects.set(key,{bytes,mime});
  }
  const bucket={get:async(key:string)=>{objectCalls.push({method:'get',key});const v=objects.get(key);if(!v)return null;
   return{key,size:v.bytes.byteLength,etag:createHash('sha256').update(v.bytes).digest('hex'),httpEtag:'"owned-product-detail"',httpMetadata:{contentType:v.mime},
    body:new ReadableStream<Uint8Array>({start(c){c.enqueue(v.bytes);c.close();}}),writeHttpMetadata:(headers:Headers)=>headers.set('Content-Type',v.mime)};}};
  const readNames=['system_admin','system_supplier','system_role','system_menus','store_product','store_product_attr','store_product_attr_value','store_product_description','system_attachment'];
  const withReader=<T>(work:(runtime:SupplierProductReplyRuntime)=>Promise<T>)=>f.withRuntimeRole!(async peer=>{
   await f.exec(`GRANT SELECT ON ${readNames.map(n=>'public."'+n+'"').join(',')} TO "${peer.role}"`);
   return work({...peer,container:createContainerFromDb(peer.db)});
  });
  const snapshot=async()=>({...await f.snapshot(),...Object.fromEntries(await Promise.all(extra.map(async t=>{const name=getTableConfig(t).name;return[name,await f.exec(`SELECT to_jsonb(t)AS row FROM public."${name}" t ORDER BY to_jsonb(t)::text`)];})))});
  const sequences=async()=>{const rows=await f.exec("SELECT sequencename FROM pg_sequences WHERE schemaname='public' ORDER BY sequencename");
   return Promise.all(rows.map(async row=>{const name=String(row.sequencename);if(!/^[a-z_]+$/.test(name))throw Error('Owned sequence identity');return{name,...(await f.exec(`SELECT last_value,is_called FROM public."${name}"`))[0]};}));};
  const env={...f.env,ASSETS_BUCKET:bucket}as unknown as typeof f.env;
  return{...f,withReader,snapshot,sequences,env,objects,objectCalls,png,readNames,
   ids:{...f.ids,privateImage:31,foreignImage:32,privateVideo:41,cardProduct:81,deletedProduct:92,activeSkus:[180,181],retiredSku:182}};
 }catch(error){await f.close();throw error;}
}
