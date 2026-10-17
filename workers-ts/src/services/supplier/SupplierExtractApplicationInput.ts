/** Versioned withdrawal admission. A replay hashes the stored canonical intent,
 * never revalidates an old MAC against today's account, balance or key. */
import {createHash,createHmac,timingSafeEqual} from 'node:crypto';
import {HttpApiException,ServiceUnavailableException,ValidateException} from '@/utils/errors';
import type {SupplierVideoActor} from './SupplierVideoAuthority';
export type ExtractChannel='bank'|'alipay'|'weixin';
export interface ExtractAccounts {bank:{bank_code:string;bank_address:string;ready:boolean};alipay:{account:string;qrcode_url:string;ready:boolean};weixin:{account:string;qrcode_url:string;ready:boolean}}
export interface ExtractSource {version:'supplier-extract-application-source-v1';supplier_id:number;available:string;min_price:string;max_price:string;accounts:ExtractAccounts}
export interface ExtractIntent {version:'supplier-extract-application-intent-v1';operation_id:string;actor_id:number;supplier_id:number;revision:string;extract_type:ExtractChannel;money:string;mark:string}
export interface ExtractApplicationResult {id:number;extract_type:ExtractChannel;extract_price:string;balance:string;bank_code:string;bank_address:string;alipay_account:string;wechat:string;qrcode_url:string;supplier_mark:string;status:0;pay_status:0;add_time:number}
export const extractConflict=(message='原提现请求或申请依据已变化，请核对原结果')=>new HttpApiException(message,409,409);
export const extractBroken=()=>new ServiceUnavailableException('提现原操作、实际申请或运行权限无法完整核对');
export function extractFact(value:unknown):asserts value {if(!value)throw extractBroken();}
export function extractId(value:unknown):number {if(typeof value!=='number'||!Number.isSafeInteger(value)||value<=0||value>2147483647)throw new ValidateException('提现身份无效');return value;}
export function extractUuid(value:unknown):string {if(typeof value!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value))throw new ValidateException('提现原操作ID无效');return value;}
export function extractRecord(value:unknown,keys:readonly string[]):Record<string,unknown> {
 if(!value||typeof value!=='object'||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))throw new ValidateException('提现正文须为闭合JSON对象');
 const row=value as Record<string,unknown>;
 if(Reflect.ownKeys(row).length!==keys.length||Reflect.ownKeys(row).some(key=>typeof key!=='string'||!keys.includes(key)||!Object.hasOwn(Object.getOwnPropertyDescriptor(row,key)!,'value')))throw new ValidateException('提现字段不完整；公共申请必须携带原操作ID与版本');return row;
}
export function extractJson(value:unknown):string {
 const sort=(x:unknown):unknown=>Array.isArray(x)?x.map(sort):x&&typeof x==='object'?Object.fromEntries(Object.keys(x).sort().map(key=>[key,sort((x as Record<string,unknown>)[key])])):x;
 return JSON.stringify(sort(value));
}
export const extractHash=(value:unknown)=>createHash('sha256').update(extractJson(value)).digest('hex');
export function extractMoney(value:unknown,maximumDigits=18):string {if(typeof value!=='string'||!new RegExp('^(0|[1-9][0-9]{0,'+(maximumDigits-1)+'})[.][0-9]{2}$').test(value))throw new ValidateException('提现金额须为规范两位小数文本');return value;}
export const extractCents=(value:string)=>BigInt(extractMoney(value).replace('.',''));
export const extractDecimal=(value:bigint)=>`${value/100n}.${String(value%100n).padStart(2,'0')}`;
export function extractText(value:unknown,limit:number):string {if(typeof value!=='string'||[...value].length>limit||/[\u0000-\u0009\u000b-\u001f\u007f]/u.test(value)||[...value].some(char=>char.length===1&&char.charCodeAt(0)>=0xd800&&char.charCodeAt(0)<=0xdfff))throw new ValidateException('提现文字长度、控制字符或Unicode无效');return value;}
/** Account snapshots are scalar fields; only the separate note permits LF. */
export function extractAccountText(value:unknown,limit:number):string {const text=extractText(value,limit);if(/[\u0000-\u001f\u007f]/u.test(text))throw new ValidateException('提现收款资料控制字符无效');return text;}
export function extractIntent(body:unknown,actor:Pick<SupplierVideoActor,'id'|'supplierId'>):ExtractIntent {
 const row=extractRecord(body,['operation_id','revision','extract_type','money','mark']),operation_id=extractUuid(row.operation_id);
 if(typeof row.revision!=='string'||!/^[a-f0-9]{64}$/.test(row.revision))throw new ValidateException('提现版本无效');
 if(typeof row.extract_type!=='string'||!['bank','alipay','weixin'].includes(row.extract_type))throw new ValidateException('转账方式不存在');
 const money=extractMoney(row.money,10);if(extractCents(money)<=0n)throw new ValidateException('提现金额必须为正额');
 if(typeof row.mark!=='string'||/[\u0000-\u0009\u000b-\u001f\u007f]/u.test(row.mark))throw new ValidateException('提现备注控制字符无效');
 const mark=extractText(row.mark.trim(),255);
 return{version:'supplier-extract-application-intent-v1',operation_id,actor_id:extractId(actor.id),supplier_id:extractId(actor.supplierId),revision:row.revision,extract_type:row.extract_type as ExtractChannel,money,mark};
}
export function validateExtractSource(value:unknown):ExtractSource {
 const row=extractRecord(value,['version','supplier_id','available','min_price','max_price','accounts']);extractFact(row.version==='supplier-extract-application-source-v1');extractId(row.supplier_id);
 for(const key of ['available','min_price','max_price'])extractMoney(row[key]);
 const accounts=extractRecord(row.accounts,['bank','alipay','weixin']);
 const bank=extractRecord(accounts.bank,['bank_code','bank_address','ready']);extractAccountText(bank.bank_code,32);extractAccountText(bank.bank_address,256);
 extractFact(bank.ready===(!!String(bank.bank_code).trim()&&bank.bank_code!=='0'&&!!String(bank.bank_address).trim()));
 for(const channel of ['alipay','weixin']){const item=extractRecord(accounts[channel],['account','qrcode_url','ready']);extractAccountText(item.account,channel==='alipay'?64:15);extractAccountText(item.qrcode_url,255);extractFact(item.ready===(!!String(item.account).trim()&&!!String(item.qrcode_url).trim()));}
 extractFact(Buffer.byteLength(extractJson(value),'utf8')<=65536);return JSON.parse(extractJson(value)) as ExtractSource;
}
export function extractRevision(key:string,source:ExtractSource,actor:SupplierVideoActor):string {
 if(!key)throw new ServiceUnavailableException('提现版本签名尚未就绪');
 return createHmac('sha256',key).update('cinashop.supplier-extract-application.revision.v1\0').update(extractJson({source,actor_id:actor.id,supplier_id:actor.supplierId,auth_version:actor.authVersion})).digest('hex');
}
export function assertExtractRevision(actual:string,expected:string) {if(!/^[a-f0-9]{64}$/.test(actual)||!timingSafeEqual(Buffer.from(actual),Buffer.from(expected)))throw extractConflict('收款资料、余额或提现配置已变化，请重新读取');}
