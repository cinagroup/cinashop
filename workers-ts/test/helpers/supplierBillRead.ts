/** Synthetic ledger READ inputs only. No paid/refund state or provider result is
 * manufactured: this fixture proves the read contract, not payment execution. */
import {randomUUID} from 'node:crypto';
import {PgDialect,getTableConfig,type PgTable} from 'drizzle-orm/pg-core';
import {SQL,sql} from 'drizzle-orm';
import {createContainerFromDb} from '@/lib/di';
import {systemAdmin,systemRole,systemMenus,systemSupplier,user,supplierFlowingWater} from '@/models/schema';
import {createToken,md5} from '@/utils/jwt';
import type {Env} from '@/env';
import {sequenceRunnerDatabase,type SequenceRunnerPeer} from './kefuSequenceRunnerDatabase';
export const supplierBillReadAppKey='owned-supplier-bill-read-key';
export const supplierBillReadPassword='owned-supplier-bill-read-password';
export const supplierBillTime=(value:string)=>Math.floor(Date.parse(value)/1000);
const tables=[systemAdmin,systemRole,systemMenus,systemSupplier,user,supplierFlowingWater] as PgTable[];
export async function supplierBillReadFixture(options:{manyRows?:number}={}) {
 if(!process.env.TEST_FINANCE_POSTGRES_URL)throw Error('Supplier bill independent LOGIN fixture requires owned PG16');
 const f=await sequenceRunnerDatabase();
 try {
  if(!f.withRuntimeRole||f.format!=='pg16')throw Error('Actual independent PG16 LOGIN unavailable');
  const dialect=new PgDialect();
  for(const table of tables){const definition=getTableConfig(table);const columns=definition.columns.map(column=>{
   const initial=column.default,defaultSql=initial===undefined?'':` default ${initial instanceof SQL?dialect.sqlToQuery(initial).sql:dialect.sqlToQuery(sql`${initial}`.inlineParams()).sql}`;
   return `"${column.name}" ${column.getSQLType()}${defaultSql}${column.notNull?' not null':''}${column.primary?' primary key':''}`;
  });await f.exec(`CREATE TABLE "${definition.name}" (${columns.join(',')})`);}
  await f.db.insert(systemSupplier).values([{id:7,adminId:99,supplierName:'本机账单供应商甲'},{id:8,adminId:199,supplierName:'本机账单供应商乙'}]);
  await f.db.insert(systemRole).values([{id:21,type:4,relationId:7,rules:'supplier.finance.view'},
   {id:22,type:4,relationId:7,rules:'supplier.order.view'},{id:31,type:4,relationId:8,rules:'supplier.finance.view'}]);
  await f.db.insert(systemAdmin).values([21,22,31].map(id=>({id,adminType:4,relationId:id===31?8:7,level:1,roles:String(id),pwd:supplierBillReadPassword,account:'owned-bill-'+id,status:1,isDel:0})));
  await f.db.insert(user).values([{uid:11,nickname:'Alice Buyer'},{uid:12,nickname:'Deleted Buyer',deleteTime:new Date('2026-01-01T00:00:00Z')}]);
  const sep1=supplierBillTime('2026-09-01T12:00:00+08:00');
  await f.db.insert(supplierFlowingWater).values([
   {id:1,supplierId:7,uid:11,orderId:'BILL-INCOME',linkId:'OWNED-A',number:'10.00',pm:1,status:0,type:1,payType:'offline',addTime:sep1,tradeTime:sep1},
   {id:2,supplierId:7,uid:11,orderId:'BILL-REFUND',linkId:'OWNED-A',number:'3.00',pm:0,status:1,type:2,payType:'yue',addTime:sep1+3600,finishTime:supplierBillTime('2026-09-02T10:00:00+08:00')},
   {id:3,supplierId:8,orderId:'FOREIGN-BILL',number:'99.00',pm:1,status:1,addTime:sep1,finishTime:sep1},
   {id:4,supplierId:7,orderId:'INVALID-BILL',number:'2.00',pm:0,status:-1,addTime:sep1+7200},
   {id:5,supplierId:7,orderId:'DELETED-BILL',number:'100.00',pm:1,isDel:1,addTime:sep1},
   {id:6,supplierId:7,uid:12,orderId:'ANONYMOUS-BILL',number:'1.00',pm:1,status:0,addTime:sep1+14400},
   {id:7,supplierId:7,orderId:'YEAR-2020',number:'2.00',pm:1,addTime:supplierBillTime('2020-12-31T12:00:00+08:00')},
   {id:8,supplierId:7,orderId:'YEAR-2021',number:'5.00',pm:1,addTime:supplierBillTime('2021-01-01T12:00:00+08:00')},
   {id:9,supplierId:7,orderId:'A%_LITERAL',number:'4.00',pm:1,addTime:supplierBillTime('2026-09-03T12:00:00+08:00')},
  ]);
  const manyRows=options.manyRows??105;if(!Number.isInteger(manyRows)||manyRows<0||manyRows>11000)throw Error('Owned bill input count outside fixture bound');
  for(let offset=0;offset<manyRows;offset+=500)await f.db.insert(supplierFlowingWater).values(Array.from({length:Math.min(500,manyRows-offset)},(_,index)=>({
   id:100+offset+index,supplierId:7,orderId:'MANY-'+(offset+index),number:'1.00',pm:1,status:0,addTime:supplierBillTime('2026-09-04T12:00:00+08:00')})));
  const tokens={reader:(await createToken(21,'supplier',md5(supplierBillReadPassword),supplierBillReadAppKey)).token,
   denied:(await createToken(22,'supplier',md5(supplierBillReadPassword),supplierBillReadAppKey)).token,
   other:(await createToken(31,'supplier',md5(supplierBillReadPassword),supplierBillReadAppKey)).token};
  type Runtime=SequenceRunnerPeer&{role:string;connectionString:string;container:ReturnType<typeof createContainerFromDb>};
  const withReader=<T>(work:(runtime:Runtime)=>Promise<T>)=>f.withRuntimeRole!(async peer=>{
   await f.exec(`GRANT SELECT ON ${tables.map(table=>'public."'+getTableConfig(table).name+'"').join(',')} TO "${peer.role}"`);
   return work({...peer,container:createContainerFromDb(peer.db)});
  });
  const snapshot=async()=>Object.fromEntries(await Promise.all(tables.map(async table=>{const name=getTableConfig(table).name;
   return [name,await f.exec(`SELECT to_jsonb(t) AS row FROM public."${name}" t ORDER BY to_jsonb(t)::text`)];})));
  const env={APP_KEY:supplierBillReadAppKey,UPSTASH_REDIS_URL:'',UPSTASH_REDIS_TOKEN:''} as Env;
  return {...f,withReader,tokens,env,snapshot,mainSupplier:7,otherSupplier:8,sep1,fixtureId:randomUUID(),manyRows};
 }catch(error){await f.close();throw error;}
}
