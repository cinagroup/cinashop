import {createUserCenterRequests} from '@/api/userCenter';
export type DistributionLedgerMode='commission'|'withdrawal';
export interface DistributionLedgerQuery {page:number;limit:20;start:number;stop:number;keyword:string}
export interface DistributionLedgerRow {id:number;title:string;type:string;pm:0|1;number:string;add_time:number;time:string;withdrawal_status:-1|0|1|null;withdrawal_message:string}
export interface DistributionLedgerPage {owner_uid:number;mode:DistributionLedgerMode;query:DistributionLedgerQuery;count:number;income:string|null;expend:string|null;list:DistributionLedgerRow[]}
export const MAX_LEDGER_PAGE=500;
const invalid=():never=>{throw Error('记录数据不完整，请刷新后重试');};
const object=(v:unknown):Record<string,unknown>=>v&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:invalid();
const integer=(v:unknown,min=0):number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=min&&v<=2147483647?v:invalid();
const text=(v:unknown,max:number):string=>typeof v==='string'&&[...v].length<=max?v:invalid();
const money=(v:unknown):string=>typeof v==='string'&&/^-?(?:0|[1-9]\d{0,30})\.\d{2}$/.test(v)?v:invalid();
function keys(v:Record<string,unknown>,expected:string){if(Object.keys(v).sort().join(',')!==expected)invalid();}
export function distributionLedgerTime(value:number):string{return value===0?'':new Date((value+28800)*1000).toISOString().slice(0,16).replace('T',' ').replaceAll('-','/');}
/** Apply the PHP income/expenditure direction without converting money to Number. */
export function ledgerAmount(row:Pick<DistributionLedgerRow,'pm'|'number'>):string {const negative=row.number.startsWith('-'),absolute=negative?row.number.slice(1):row.number;return(row.pm===1?negative?'-':'+':negative?'+':'-')+absolute;}
export function ledgerReview(row:DistributionLedgerRow):string{return row.withdrawal_status===-1?'审核未通过':row.withdrawal_status===0?'待审核':row.withdrawal_status===1?'审核通过':'';}
export function decodeDistributionLedger(value:unknown,owner:number,mode:DistributionLedgerMode,query:DistributionLedgerQuery):DistributionLedgerPage {
 const v=object(value);keys(v,'count,expend,income,list,mode,owner_uid,query');const q=object(v.query);keys(q,'keyword,limit,page,start,stop');
 if(v.owner_uid!==owner||v.mode!==mode||Object.keys(query).some(key=>q[key]!==query[key as keyof DistributionLedgerQuery])||!Array.isArray(v.list))return invalid();
 const count=integer(v.count),income=mode==='commission'?money(v.income):v.income===null?null:invalid(),expend=mode==='commission'?money(v.expend):v.expend===null?null:invalid();
 if(v.list.length!==Math.min(20,Math.max(0,count-(query.page-1)*20)))return invalid();
 if(mode==='withdrawal'&&query.keyword!==''||count===0&&mode==='commission'&&(income!=='0.00'||expend!=='0.00'))return invalid();
 const list=v.list.map(value=>{const row=object(value);keys(row,'add_time,id,number,pm,time,title,type,withdrawal_message,withdrawal_status');const id=integer(row.id,1),add_time=integer(row.add_time,-2147483648),time=text(row.time,16),type=text(row.type,64),message=text(row.withdrawal_message,255),status=row.withdrawal_status;
  if(time!==distributionLedgerTime(add_time)||![0,1].includes(row.pm as number)||status!==null&&![-1,0,1].includes(status as number)||typeof status!=='number'&&status!==null)return invalid();
  const withdrawal=['extract','extract_fail','extract_money'].includes(type);if(!withdrawal&&(status!==null||message!=='')||status!==-1&&message!==''||type==='extract_money'&&(status!==1||message!=='' )||mode==='withdrawal'&&!withdrawal)return invalid();
  return{id,title:text(row.title,64),type,pm:row.pm as 0|1,number:money(row.number),add_time,time,withdrawal_status:status as -1|0|1|null,withdrawal_message:message};
 });
 if(list.some((row,i)=>i>0&&row.id>=list[i-1]!.id))return invalid();
 return{owner_uid:owner,mode,query:{...query},count,income,expend,list};
}
export function createDistributionLedgerRequests(current:()=>boolean,mode:DistributionLedgerMode,query:DistributionLedgerQuery){const scope=createUserCenterRequests(current);return{...scope,page:async()=>decodeDistributionLedger(await scope.request('v2/user/money_list/'+(mode==='commission'?3:4)+'?view=distribution_ledger','POST',{...query},true),scope.owner.uid,mode,query)};}
export type DistributionLedgerRequests=ReturnType<typeof createDistributionLedgerRequests>;
