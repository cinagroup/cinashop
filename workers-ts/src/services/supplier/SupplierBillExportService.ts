/** Complete Supplier period exports: one HTTP response and one read snapshot.
 * Capacity/deadline failures never publish a partial manifest. */
import {sql,type SQL} from 'drizzle-orm';
import type {Container} from '@/lib/di';
import {ValidateException} from '@/utils/errors';
import {parseSupplierBillDetailQuery,type SupplierBillParameters} from './SupplierBillReadService';
import {supplierReadIdentity,supplierReadSnapshot} from './SupplierReadSupport';

export const SUPPLIER_BILL_EXPORT_BYTES=16*1024*1024;
export const SUPPLIER_BILL_EXPORT_MILLISECONDS=15_000;
const CHUNK=1000,MAX_INT=2_147_483_647;
const encoder=new TextEncoder();
export const supplierBillExportHeader=['交易单号','关联订单','交易时间','交易金额','支出收入','交易人','交易类型','支付方式'];
export const supplierBillExportFilekey=['order_id','link_id','trade_time','number','pm','user_nickname','type_name','pay_type_name'];
type Period='day'|'week'|'month';
type Status=''|'-1'|'0'|'1';
export type SupplierBillExportRow={
 id:number;order_id:string;link_id:string;trade_time:string;number:string;pm:'收入'|'支出';
 user_nickname:string;type_name:string;pay_type_name:string;
};
export interface SupplierBillExportManifest {
 version:'supplier-bill-export-v1';selection:'period';supplier_id:number;timeType:Period;status:Status;data:string;period:string;
 header:string[];filekey:string[];export:SupplierBillExportRow[];filename:string;count:number;
 income_num:string;exp_num:string;entry_num:string;complete:true;bounded:true;
}
const fail=(message:string):never=>{throw new ValidateException(message);};
export function parseSupplierBillExportQuery(parameters:SupplierBillParameters) {
 const keys=['selection','timeType','status','data','period'];
 for(const [key,value] of Object.entries(parameters))if(!keys.includes(key)||typeof value!=='string')fail('完整账期导出参数未知');
 if(parameters.selection!=='period')fail('完整账期导出必须明确selection=period');
 return parseSupplierBillDetailQuery(parameters);
}
/** Text stays text when the complete manifest is eventually written as CSV. */
export function supplierBillExportText(value:string,maximum=2048) {
 if(typeof value!=='string'||value.length>maximum||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value))fail('账单导出文字字段无效或过长');
 return /^[\s\u0000-\u001f\u007f-\u009f]*[=+\-@]/u.test(value)?"'"+value:value;
}
export function supplierBillExportAmount(value:unknown):string {
 if(typeof value!=='string'||! /^-?(?:0|[1-9]\d{0,17})\.\d{2}$/.test(value)||value==='-0.00')return fail('账单导出金额无法完整核对或超出范围');
 return value;
}
function cents(value:string) {return BigInt(value.replace('.',''));}
function integer(value:unknown,minimum=0) {
 const result=typeof value==='string'&&/^\d+$/.test(value)?Number(value):value;
 if(typeof result!=='number'||!Number.isSafeInteger(result)||result<minimum||result>MAX_INT)return fail('账单导出数量或身份超出范围');
 return result;
}
export function supplierBillExportBudget(bytes:number,started:number,now=Date.now()) {
 if(!Number.isSafeInteger(bytes)||bytes<0||bytes>SUPPLIER_BILL_EXPORT_BYTES)return fail('完整账期导出超过16MiB容量，未生成部分文件');
 if(!Number.isFinite(started)||!Number.isFinite(now)||now<started||now-started>SUPPLIER_BILL_EXPORT_MILLISECONDS)return fail('完整账期导出超过事务时间预算，未生成部分文件');
}
function periodSql(timeType:Period,status:Status):SQL {
 const clock=status==='1'?sql`flow.finish_time`:sql`flow.add_time`;
 const day=sql`(to_timestamp(${clock}) AT TIME ZONE 'Asia/Shanghai')::date`;
 if(timeType==='day')return sql`to_char(${day},'YYYY-MM-DD')`;
 if(timeType==='month')return sql`to_char(${day},'YYYY-MM')`;
 const week=sql`CASE WHEN EXTRACT(ISOYEAR FROM ${day})<EXTRACT(YEAR FROM ${day}) THEN 0
  WHEN EXTRACT(ISOYEAR FROM ${day})>EXTRACT(YEAR FROM ${day}) THEN 53 ELSE EXTRACT(WEEK FROM ${day}) END`;
 return sql`to_char(${day},'YYYY')||'-'||lpad((${week})::int::text,2,'0')`;
}
type RawRow={id:number;order_id:string;link_id:string;trade_time:number;add_time:number;number:string;pm:number;
 nickname:string|null;type:number;pay_type:string};
const payTypes:Record<string,string>={weixin:'微信支付',yue:'余额支付',offline:'线下支付',alipay:'支付宝支付',cash:'现金支付',automatic:'自动转账',store:'微信支付'};
function row(value:RawRow):SupplierBillExportRow {
 const id=integer(value.id,1);if(value.pm!==0&&value.pm!==1)fail('账单导出收支方向无效');
 const epoch=integer(value.trade_time||value.add_time),trade=epoch?new Date((epoch+28800)*1000).toISOString().slice(0,19).replace('T',' '):'';
 integer(value.type);
 return {id,order_id:supplierBillExportText(value.order_id),link_id:supplierBillExportText(value.link_id),trade_time:trade,
  number:supplierBillExportAmount(value.number),pm:value.pm===1?'收入':'支出',user_nickname:supplierBillExportText(value.nickname||'游客',500),
  type_name:value.type===1?'支付订单':value.type===2?'退款订单':'其他类型',
  pay_type_name:Object.hasOwn(payTypes,value.pay_type)?payTypes[value.pay_type]!:'其他方式'};
}
export class SupplierBillExportService {
 constructor(private readonly container:Container){}
 async period(supplierId:number,parameters:SupplierBillParameters):Promise<SupplierBillExportManifest> {
  supplierReadIdentity(supplierId);const query=parseSupplierBillExportQuery(parameters),started=Date.now();
  const conditions=[sql`flow.supplier_id=${supplierId}`,sql`flow.is_del=0`,sql`${periodSql(query.timeType,query.status)}=${query.period}`];
  if(query.status!=='')conditions.push(sql`flow.status=${Number(query.status)}`);
  if(query.start!==null)conditions.push(sql`flow.add_time>=${query.start}`);
  if(query.end!==null)conditions.push(sql`flow.add_time<=${query.end}`);
  const where=sql.join(conditions,sql` AND `);
  return supplierReadSnapshot(this.container,async tx=>{
   supplierBillExportBudget(0,started);
   const [totals]=await tx.execute<{count:string;income_num:string;exp_num:string;entry_num:string}>(sql`SELECT count(*)::text AS count,
    coalesce(sum(CASE WHEN flow.pm=1 THEN flow.number ELSE 0.00 END),0.00)::text AS income_num,
    coalesce(sum(CASE WHEN flow.pm=0 THEN flow.number ELSE 0.00 END),0.00)::text AS exp_num,
    (coalesce(sum(CASE WHEN flow.pm=1 THEN flow.number ELSE 0.00 END),0.00)-coalesce(sum(CASE WHEN flow.pm=0 THEN flow.number ELSE 0.00 END),0.00))::text AS entry_num
    FROM public.supplier_flowing_water flow WHERE ${where}`);
   if(!totals)fail('完整账期导出汇总缺失');
   const manifest:SupplierBillExportManifest={version:'supplier-bill-export-v1',selection:'period',supplier_id:supplierId,timeType:query.timeType,
    status:query.status,data:query.data,period:query.period,header:[...supplierBillExportHeader],filekey:[...supplierBillExportFilekey],export:[],
    filename:`账单导出_${query.timeType}_${query.period}_${query.status||'all'}`,count:integer(totals.count),
    income_num:supplierBillExportAmount(totals.income_num),exp_num:supplierBillExportAmount(totals.exp_num),entry_num:supplierBillExportAmount(totals.entry_num),complete:true,bounded:true};
   let bytes=encoder.encode(JSON.stringify(manifest)).byteLength,income=0n,expense=0n,previous=MAX_INT+1;
   supplierBillExportBudget(bytes,started);
   while(manifest.export.length<manifest.count) {
    // Do not bind the JavaScript sentinel MAX_INT+1 to an int4 comparison.
    // The first chunk has no cursor; later chunks use an actual int4 row ID.
    const continuation=manifest.export.length?sql`AND flow.id<${previous}`:sql``;
    const chunk=await tx.execute<RawRow>(sql`SELECT flow.id,flow.order_id,flow.link_id,flow.trade_time,flow.add_time,flow.number,flow.pm,
     buyer.nickname,flow.type,flow.pay_type FROM public.supplier_flowing_water flow
     LEFT JOIN public."user" buyer ON buyer.uid=flow.uid AND buyer.delete_time IS NULL
     WHERE ${where} ${continuation} ORDER BY flow.id DESC LIMIT ${CHUNK}`);
    supplierBillExportBudget(bytes,started);
    if(!chunk.length||chunk.length>CHUNK)fail('完整账期导出明细无法连续读取');
    for(const raw of chunk) {
     const value=row(raw);if(value.id>=previous||manifest.export.length>=manifest.count)fail('完整账期导出明细数量或顺序不一致');
     previous=value.id;bytes+=encoder.encode(JSON.stringify(value)).byteLength+(manifest.export.length?1:0);
     supplierBillExportBudget(bytes,started);manifest.export.push(value);
     if(value.pm==='收入')income+=cents(value.number);else expense+=cents(value.number);
    }
   }
   if(manifest.export.length!==manifest.count||income!==cents(manifest.income_num)||expense!==cents(manifest.exp_num)||income-expense!==cents(manifest.entry_num))fail('完整账期导出行数或全额无法核对，未生成部分文件');
   // Per-row UTF8 accounting includes commas and the one metadata shell. Only
   // this final check ever serializes/encodes the complete bounded manifest.
   const exactBytes=encoder.encode(JSON.stringify(manifest)).byteLength;
   if(exactBytes!==bytes)fail('完整账期导出容量核对失败');supplierBillExportBudget(exactBytes,started);
   return manifest;
  });
 }
}
