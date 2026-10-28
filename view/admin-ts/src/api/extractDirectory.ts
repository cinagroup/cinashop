import { AdminResponseError } from '@/utils/request';
import { clearAuth, getToken } from '@/utils/auth';

export interface ExtractDirectoryReadOwner {
  id: number; token: string; current(): boolean;
}


export interface ExtractDirectoryQuery {
  page: number; limit: 20; status: null | -1 | 0 | 1;
  extract_type: '' | 'bank' | 'balance' | 'alipay' | 'weixin';
  keyword: string; start: number; stop: number;
}
export interface ExtractDirectoryPeriod {
  start: number; stop: number; effective_stop: number;
  rule: 'none' | 'closed' | 'equal-plus-day' | 'midnight-plus-day';
}
export interface ExtractDirectoryRow {
  id: number; uid: number; nickname: string; account: string;
  extract_type: string; real_name: string; bank_name: string; bank_code: string;
  bank_address: string; alipay_code: string; wechat: string; extract_number: string;
  gross_amount: string; net_amount: string; fee_amount: string; balance_before: string;
  status: number; fail_msg: string; fail_time: number; mark: string;
  add_time: number; time: string; media_available: boolean; revision: string;
}
export interface ExtractDirectoryReport {
  version: 1; actor_id: number; query: ExtractDirectoryQuery; period: ExtractDirectoryPeriod;
  count: number; statistics: { price: string; priced: string; brokerage_count: string; brokerage_not: string };
  list: ExtractDirectoryRow[];
}
const queryKeys = ['page','limit','status','extract_type','keyword','start','stop'];
const rowKeys = ['id','uid','nickname','account','extract_type','real_name','bank_name','bank_code','bank_address','alipay_code','wechat','extract_number','gross_amount','net_amount','fee_amount','balance_before','status','fail_msg','fail_time','mark','add_time','time','media_available','revision'];
function invalid(): never { throw new Error('提现查询响应格式无效，请重新查询'); }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}
function exact(value: unknown, names: readonly string[]): Record<string, unknown> {
  const row = object(value), actual = Object.keys(row).sort(), expected = [...names].sort();
  if (actual.length !== expected.length || actual.some((key, i) => key !== expected[i])) invalid();
  return row;
}
function integer(value: unknown, low = -2147483648, high = 2147483647): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || Object.is(value, -0) || value < low || value > high) invalid();
  return value;
}
function scalar(value: unknown, maximum = 4096): string {
  if (typeof value !== 'string' || [...value].length > maximum || [...value].some(char => { const n=char.codePointAt(0)!; return n>=0xd800&&n<=0xdfff; })) invalid();
  return value;
}
function amount(value: unknown): string {
  const text = scalar(value, 68);
  if (!/^-?(?:0|[1-9]\d{0,63})\.\d{2}$/.test(text) || text === '-0.00') invalid();
  return text;
}
function cents(value: string): bigint {
  const negative=value.startsWith('-'), [whole, fraction]=(negative?value.slice(1):value).split('.');
  const result=BigInt(whole!)*100n+BigInt(fraction!); return negative?-result:result;
}
function money(value: bigint): string { const v=value<0n?-value:value; return (value<0n?'-':'')+v/100n+'.'+String(v%100n).padStart(2,'0'); }
export function extractDirectoryDefaults(): ExtractDirectoryQuery {
  return {page:1,limit:20,status:null,extract_type:'',keyword:'',start:0,stop:0};
}
export function extractDirectoryPeriod(start: number, stop: number): ExtractDirectoryPeriod {
  integer(start,0); integer(stop,0);
  if (start===0&&stop===0) return {start,stop,effective_stop:0,rule:'none'};
  if (!start||!stop||start>stop||start%60!==0||stop%60!==0) invalid();
  const rule=start===stop?'equal-plus-day':shanghaiParts(stop).slice(3).every(part=>part===0)?'midnight-plus-day':'closed';
  return {start,stop,effective_stop:Number(BigInt(stop)+(rule==='closed'?0n:86400n)),rule};
}
export function normalizeExtractDirectoryQuery(value: unknown): ExtractDirectoryQuery {
  const q=exact(value,queryKeys), page=integer(q.page,1,1000), start=integer(q.start,0), stop=integer(q.stop,0);
  if (q.status!==null) integer(q.status,-1,1);
  if (q.limit!==20 || ![null,-1,0,1].includes(q.status as null|number) || !['','bank','balance','alipay','weixin'].includes(q.extract_type as string)) invalid();
  const keyword=scalar(q.keyword,64); if (/[\u0000-\u001f\u007f]/u.test(keyword)) invalid();
  extractDirectoryPeriod(start,stop);
  return {page,limit:20,status:q.status as ExtractDirectoryQuery['status'],extract_type:q.extract_type as ExtractDirectoryQuery['extract_type'],keyword,start,stop};
}
const shanghaiCalendar = new Intl.DateTimeFormat('en-GB', {timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});
function shanghaiParts(seconds: number): number[] {
  const parts=shanghaiCalendar.formatToParts(new Date(seconds*1000));
  return ['year','month','day','hour','minute','second'].map(type=>Number(parts.find(part=>part.type===type)!.value));
}
function wallText(parts: number[]): string {
  return String(parts[0]).padStart(4,'0')+'/'+String(parts[1]).padStart(2,'0')+'/'+String(parts[2]).padStart(2,'0')+' '+String(parts[3]).padStart(2,'0')+':'+String(parts[4]).padStart(2,'0');
}
export function extractDirectoryShanghaiTime(seconds: number): string {
  integer(seconds,-2147483648,2147570047); return seconds===0?'':wallText(shanghaiParts(seconds));
}
/** IANA Shanghai history includes summer time. Ambiguous or missing wall
 * minutes must be selected again instead of silently changing query scope. */
export function extractDirectoryDateInput(value: string): number {
  const match=/^(\d{4})[/-](\d{2})[/-](\d{2})[ T](\d{2}):(\d{2})$/.exec(value);
  if (!match) throw new Error('请选择完整的日期和时间');
  const wanted=match.slice(1).map(Number), [year,month,day,hour,minute]=wanted;
  const guess=Date.UTC(year!,month!-1,day!,hour!,minute!)/1000,d=new Date(guess*1000);
  if(d.getUTCFullYear()!==year||d.getUTCMonth()+1!==month||d.getUTCDate()!==day||d.getUTCHours()!==hour||d.getUTCMinutes()!==minute) throw new Error('日期或时间无效');
  const offsets=new Set<number>();
  for(const delta of [-86400,0,86400]) {
    const sample=guess+delta,[y,m,dd,h,mm,ss]=shanghaiParts(sample);
    offsets.add(Date.UTC(y!,m!-1,dd!,h!,mm!,ss!)/1000-sample);
  }
  const matches=[...offsets].map(offset=>guess-offset).filter(seconds=>Number.isSafeInteger(seconds)&&seconds>0&&seconds<=2147483647&&seconds%60===0&&shanghaiParts(seconds).slice(0,5).every((part,index)=>part===wanted[index]));
  if(matches.length>1) throw new Error('此时间处于夏令时回拨的重复时段，请选择其他分钟');
  if(matches.length!==1) throw new Error('此时间不存在或超出可查询范围，请重新选择');
  return matches[0]!;
}
export function decodeExtractDirectory(value: unknown, owner: number, expectedQuery: ExtractDirectoryQuery): ExtractDirectoryReport {
  const report=exact(value,['version','actor_id','query','period','count','statistics','list']);
  if (report.version!==1||integer(report.actor_id,1)!==integer(owner,1)) invalid();
  const query=normalizeExtractDirectoryQuery(report.query), expected=normalizeExtractDirectoryQuery(expectedQuery);
  for (const key of queryKeys as (keyof ExtractDirectoryQuery)[]) if (query[key]!==expected[key]) invalid();
  const rawPeriod=exact(report.period,['start','stop','effective_stop','rule']),period=extractDirectoryPeriod(query.start,query.stop);
  for(const key of ['start','stop','effective_stop','rule'] as const) if(rawPeriod[key]!==period[key]) invalid();
  const count=integer(report.count,0,Number.MAX_SAFE_INTEGER), statistics=exact(report.statistics,['price','priced','brokerage_count','brokerage_not']);
  const stats={price:amount(statistics.price),priced:amount(statistics.priced),brokerage_count:amount(statistics.brokerage_count),brokerage_not:amount(statistics.brokerage_not)};
  const available=cents(stats.brokerage_count)-cents(stats.priced); if (stats.brokerage_not!==money(available>0n?available:0n)) invalid();
  if(!Array.isArray(report.list)||report.list.length!==Math.min(20,Math.max(0,count-(query.page-1)*20))) invalid();
  const list=report.list.map(raw=>{
    const r=exact(raw,rowKeys),id=integer(r.id),uid=integer(r.uid),status=integer(r.status),add_time=integer(r.add_time),fail_time=integer(r.fail_time);
    const net_amount=amount(r.net_amount),fee_amount=amount(r.fee_amount),gross_amount=amount(r.gross_amount),balance_before=amount(r.balance_before);
    if(cents(net_amount)+cents(fee_amount)!==cents(gross_amount)||r.time!==extractDirectoryShanghaiTime(add_time)||typeof r.media_available!=='boolean'||typeof r.revision!=='string'||!/^[a-f0-9]{64}$/.test(r.revision)) invalid();
    if(r.media_available&&(id<=0||uid<=0||!['weixin','alipay'].includes(r.extract_type as string))) invalid();
    return {id,uid,nickname:scalar(r.nickname),account:scalar(r.account),extract_type:scalar(r.extract_type,32),real_name:scalar(r.real_name),bank_name:scalar(r.bank_name),bank_code:scalar(r.bank_code),bank_address:scalar(r.bank_address),alipay_code:scalar(r.alipay_code),wechat:scalar(r.wechat),extract_number:scalar(r.extract_number),gross_amount,net_amount,fee_amount,balance_before,status,fail_msg:scalar(r.fail_msg),fail_time,mark:scalar(r.mark),add_time,time:scalar(r.time),media_available:r.media_available,revision:r.revision};
  });
  if(list.some((row,index)=>index>0&&list[index-1]!.id<=row.id)) invalid();
  return {version:1,actor_id:owner,query,period,count,statistics:stats,list};
}
export type ExtractDirectoryMedia = {version:1;actor_id:number;id:number;revision:string} &
  ({available:false;reference:null;preview:null;expires:null} |
   {available:true;reference:string;preview:string;expires:number});
type MediaSource=Pick<ExtractDirectoryRow,'id'|'uid'|'revision'|'extract_type'|'media_available'>;
export function decodeExtractDirectoryMedia(value: unknown, owner: number, source: MediaSource,
  now=Math.floor(Date.now()/1000)): ExtractDirectoryMedia {
  const r=exact(value,['version','actor_id','id','revision','available','reference','preview','expires']);
  integer(owner,1);integer(source.id,1);integer(now,0,Number.MAX_SAFE_INTEGER);
  if(r.version!==1||r.actor_id!==owner||r.id!==source.id||r.revision!==source.revision||!/^[a-f0-9]{64}$/.test(source.revision)) invalid();
  if(r.available===false) {
    if(r.reference!==null||r.preview!==null||r.expires!==null) invalid();
    return {version:1,actor_id:owner,id:source.id,revision:source.revision,available:false,reference:null,preview:null,expires:null};
  }
  if(r.available!==true||!source.media_available||integer(source.uid,1)<=0||!['weixin','alipay'].includes(source.extract_type)) invalid();
  const reference=scalar(r.reference,64), match=/^\/api\/assets\/([1-9]\d{0,9})$/.exec(reference);
  if(!match||Number(match[1])>2147483647) invalid();
  const preview=scalar(r.preview,256),expires=integer(r.expires,1,Number.MAX_SAFE_INTEGER);
  const signed=new RegExp('^/api/assets/'+match[1]+'\\?expires=([1-9]\\d*)&signature=([A-Za-z0-9_-]{43})$').exec(preview);
  if(!signed||String(expires)!==signed[1]||expires<=now||expires>now+900) invalid();
  return {version:1,actor_id:owner,id:source.id,revision:source.revision,available:true,reference,preview,expires};
}
/** Captured credentials never change to a replacement account in a shared interceptor. */
async function readOwnedExtractJson(path: string, owner: ExtractDirectoryReadOwner, signal: AbortSignal): Promise<unknown> {
  integer(owner.id,1);
  const controller=new AbortController();let timedOut=false;
  const abort=()=>controller.abort(),cancelled=()=>new DOMException('查询已取消','AbortError');
  const live=()=>!signal.aborted&&owner.current()&&getToken()===owner.token;
  if(!live()||!owner.token) throw cancelled();
  signal.addEventListener('abort',abort,{once:true});
  const timer=setTimeout(()=>{timedOut=true;controller.abort();},30000);
  const expire=()=>{
    if(!live()) return;
    clearAuth();window.dispatchEvent(new Event('admin-auth-expired'));
    if(window.location.pathname!=='/login') window.location.href='/login';
  };
  try {
    if(!live()) throw cancelled();
    const response=await fetch(path,{method:'GET',headers:{'Authori-zation':'Bearer '+owner.token,'Accept':'application/json'},cache:'no-store',credentials:'same-origin',signal:controller.signal});
    if(!live()) throw cancelled();
    if(response.status===401){expire();throw new AdminResponseError('登录已失效，请重新登录',401);}
    if(response.status===403) throw new AdminResponseError('没有查看提现申请的权限',403);
    const text=await response.text();if(!live()) throw cancelled();if(text.length>1048576) invalid();
    let parsed:unknown;try{parsed=JSON.parse(text);}catch{invalid();}
    const envelope=exact(parsed,['status','msg','data']),code=integer(envelope.status,0),message=scalar(envelope.msg);
    if(response.status!==200||code!==200){
      if([410000,410001,410002].includes(code)) expire();
      throw new AdminResponseError(message||'读取提现申请失败',code);
    }
    if(!live()) throw cancelled();return envelope.data;
  }catch(error){
    if(!live()) throw cancelled();
    if(timedOut) throw new Error('查询超时，请重试');
    throw error;
  }finally{clearTimeout(timer);signal.removeEventListener('abort',abort);}
}
export async function apiAdminExtractDirectory(query: ExtractDirectoryQuery, owner: ExtractDirectoryReadOwner, signal: AbortSignal): Promise<ExtractDirectoryReport> {
  const q=normalizeExtractDirectoryQuery(query),params=new URLSearchParams();
  for(const key of queryKeys as (keyof ExtractDirectoryQuery)[]) params.set(key,q[key]===null?'all':String(q[key]));
  const result=await readOwnedExtractJson('/adminapi/extract/directory?'+params.toString(),owner,signal);
  if(signal.aborted||!owner.current()||getToken()!==owner.token) throw new DOMException('查询已取消','AbortError');
  return decodeExtractDirectory(result,owner.id,q);
}
export async function apiAdminExtractDirectoryMedia(source: MediaSource, owner: ExtractDirectoryReadOwner, signal: AbortSignal): Promise<ExtractDirectoryMedia> {
  integer(source.id,1);if(!/^[a-f0-9]{64}$/.test(source.revision)) invalid();
  const result=await readOwnedExtractJson('/adminapi/extract/directory/'+source.id+'/media?revision='+source.revision,owner,signal);
  if(signal.aborted||!owner.current()||getToken()!==owner.token) throw new DOMException('查询已取消','AbortError');
  return decodeExtractDirectoryMedia(result,owner.id,source);
}
