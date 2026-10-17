/** Owned synthetic withdrawal HISTORY inputs. Native tests prove reads, shared
 * notes and local Admin state transitions; no bank transfer is performed. */
import {randomUUID} from 'node:crypto';
import {PgDialect,getTableConfig,type PgTable} from 'drizzle-orm/pg-core';
import {SQL,sql} from 'drizzle-orm';
import {createContainerFromDb} from '@/lib/di';
import type {Env} from '@/env';
import {supplierExtract,supplierFlowingWater,systemAdmin,systemConfig,systemLog,systemMenus,systemRole,systemSupplier} from '@/models/schema';
import {createToken,md5} from '@/utils/jwt';
import {sequenceRunnerDatabase,type SequenceRunnerPeer} from './kefuSequenceRunnerDatabase';
export const supplierExtractReadAppKey='owned-supplier-extract-read-key';
export const supplierExtractReadPassword='owned-supplier-extract-read-password';
export const supplierExtractTime=(value:string)=>Math.floor(Date.parse(value)/1000);
const readTables=[systemAdmin,systemSupplier,systemRole,systemMenus,supplierExtract,supplierFlowingWater,systemConfig] as PgTable[];
const tables=[...readTables,systemLog];
export async function supplierExtractReadFixture(options:{manyRows?:number}={}) {
 if(!process.env.TEST_FINANCE_POSTGRES_URL)throw Error('Supplier withdrawal history requires owned native PG16');
 const f=await sequenceRunnerDatabase();
 try {
  if(!f.withRuntimeRole||f.format!=='pg16')throw Error('Owned independent PG16 LOGIN unavailable');
  const dialect=new PgDialect();
  for(const table of tables){const definition=getTableConfig(table),columns=definition.columns.map(column=>{
   const initial=column.default,defaultSql=initial===undefined?'':` default ${initial instanceof SQL?dialect.sqlToQuery(initial).sql:dialect.sqlToQuery(sql`${initial}`.inlineParams()).sql}`;
   return `"${column.name}" ${column.getSQLType()}${defaultSql}${column.notNull?' not null':''}${column.primary?' primary key':''}`;
  });await f.exec(`CREATE TABLE "${definition.name}" (${columns.join(',')})`);}
  await f.db.insert(systemSupplier).values([{id:7,adminId:99,supplierName:'本机提现供应商甲',bankCode:'CURRENT-OTHER-ACCOUNT',bankAddress:'当前已改开户行'},
   {id:8,adminId:199,supplierName:'本机提现供应商乙'}]);
  await f.db.insert(systemRole).values([{id:21,type:4,relationId:7,rules:'supplier.finance.view,supplier.finance.manage'},
   {id:22,type:4,relationId:7,rules:'supplier.finance.view'},{id:23,type:4,relationId:7,rules:'supplier.order.view'},
   {id:31,type:4,relationId:8,rules:'supplier.finance.view'}]);
  await f.db.insert(systemAdmin).values([21,22,23,31].map(id=>({id,adminType:4,relationId:id===31?8:7,level:1,roles:String(id),pwd:supplierExtractReadPassword,account:'owned-extract-'+id,status:1,isDel:0})));
  await f.db.insert(systemAdmin).values([{id:101,adminType:1,realName:'本机财务经办人',account:'owned-history-admin-101'},
   {id:102,adminType:1,realName:'历史经办人',account:'owned-history-admin-102',isDel:1}]);
  await f.db.insert(systemConfig).values([{id:1,menuName:'supplier_extract_min_price',value:'"5.50"',sort:10},
   {id:2,menuName:'supplier_extract_max_price',value:'200.00',sort:10},
   {id:3,menuName:'supplier_extract_min_price',value:'1.00',sort:0},
   {id:4,isStore:1,menuName:'supplier_extract_min_price',value:'999.00',sort:100}]);
  await f.db.insert(supplierFlowingWater).values([{id:1,supplierId:7,orderId:'OWNED-SETTLED-INCOME',number:'1000.00',pm:1,status:1,type:1},
   {id:2,supplierId:7,orderId:'OWNED-SETTLED-EXPENSE',number:'100.00',pm:0,status:1,type:2},
   {id:3,supplierId:7,orderId:'OWNED-PENDING-INCOME',number:'50.00',pm:1,status:0,type:1},
   {id:4,supplierId:7,orderId:'OWNED-DELETED-INCOME',number:'999.00',pm:1,status:1,type:1,isDel:1},
   {id:5,supplierId:7,orderId:'OWNED-INVALID-INCOME',number:'999.00',pm:1,status:-1,type:1},
   {id:6,supplierId:8,orderId:'FOREIGN-SETTLED-INCOME',number:'500.00',pm:1,status:1,type:1}]);
  const sep1=supplierExtractTime('2026-09-01T12:00:00+08:00');
  await f.db.insert(supplierExtract).values([
   {id:1,supplierId:7,extractType:'bank',bankCode:'6222000011112222',bankAddress:'本机开户行',extractPrice:'10.00',balance:'890.00',status:0,payStatus:0,supplierMark:'银行申请说明',mark:'内部字段不进入现代响应',addTime:sep1},
   {id:2,supplierId:7,extractType:'alipay',alipayAccount:'owned-alipay',qrcodeUrl:'/owned-media/alipay.png',extractPrice:'20.00',status:1,payStatus:0,adminId:101,supplierMark:'支付宝申请说明',addTime:sep1+3600},
   {id:3,supplierId:7,extractType:'weixin',wechat:'owned-wechat',qrcodeUrl:'/owned-media/wechat.png',extractPrice:'30.00',status:1,payStatus:1,adminId:102,
    voucherTitle:'本机确认登记',voucherImage:'/owned-media/voucher.png',payTime:supplierExtractTime('2026-09-02T11:00:00+08:00'),addTime:supplierExtractTime('2026-09-02T10:00:00+08:00')},
   {id:4,supplierId:7,extractType:'bank',bankCode:'6222000011112222',bankAddress:'本机开户行',extractPrice:'40.00',status:-1,payStatus:0,adminId:101,failMsg:'本机拒绝说明',failTime:supplierExtractTime('2026-09-03T14:00:00+08:00'),addTime:sep1+7200},
   {id:5,supplierId:8,extractType:'bank',extractPrice:'99.00',status:0,payStatus:0,addTime:sep1},
  ]);
  const manyRows=options.manyRows??105;if(!Number.isInteger(manyRows)||manyRows<0||manyRows>11000)throw Error('Owned history count outside fixture bound');
  for(let offset=0;offset<manyRows;offset+=500)await f.db.insert(supplierExtract).values(Array.from({length:Math.min(500,manyRows-offset)},(_,index)=>({
   id:100+offset+index,supplierId:7,extractType:'bank',bankCode:'6222000011112222',bankAddress:'本机开户行',extractPrice:'1.00',status:0,payStatus:0,
   supplierMark:'分页申请-'+(offset+index),addTime:supplierExtractTime('2026-09-04T12:00:00+08:00')})));
  const token=async(id:number)=>(await createToken(id,'supplier',md5(supplierExtractReadPassword),supplierExtractReadAppKey)).token;
  const tokens={reader:await token(21),viewer:await token(22),denied:await token(23),other:await token(31)};
  type Runtime=SequenceRunnerPeer&{role:string;connectionString:string;container:ReturnType<typeof createContainerFromDb>};
  const withReader=<T>(work:(runtime:Runtime)=>Promise<T>)=>f.withRuntimeRole!(async peer=>{
   await f.exec(`GRANT SELECT ON ${readTables.map(table=>'public."'+getTableConfig(table).name+'"').join(',')} TO "${peer.role}"`);
   return work({...peer,container:createContainerFromDb(peer.db)});
  });
  const withWriter=<T>(work:(runtime:Runtime)=>Promise<T>)=>withReader(async runtime=>{
   await f.exec(`GRANT UPDATE(id) ON public.system_admin,public.system_supplier,public.system_role,public.system_menus TO "${runtime.role}"; GRANT UPDATE(supplier_mark) ON public.supplier_extract TO "${runtime.role}"`);
   return work(runtime);
  });
  const snapshot=async()=>Object.fromEntries(await Promise.all(tables.map(async table=>{const name=getTableConfig(table).name;
   return[name,await f.exec(`SELECT to_jsonb(t) AS row FROM public."${name}" t ORDER BY to_jsonb(t)::text`)];})));
  const env={APP_KEY:supplierExtractReadAppKey,UPSTASH_REDIS_URL:'',UPSTASH_REDIS_TOKEN:''} as Env;
  return{...f,withReader,withWriter,tokens,env,snapshot,mainSupplier:7,otherSupplier:8,sep1,manyRows,fixtureId:randomUUID()};
 }catch(error){await f.close();throw error;}
}
