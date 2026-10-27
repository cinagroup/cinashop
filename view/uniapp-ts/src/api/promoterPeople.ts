import {createUserCenterRequests} from '@/api/userCenter';
import {memberLevelImage} from '@/api/memberLevels';
import {memberRightImage,memberRightMediaDeadline} from '../../../common/memberRightMedia';
import {shanghaiDay} from '@/utils/distributionReportFilters';
export const PEOPLE_PAGE_SIZE=20,MAX_PEOPLE_PAGE=500;
export interface PromoterPeopleQuery {page:number;limit:20;grade:0|1;start:number;stop:number;keyword:string}
export interface PromoterPerson {uid:number;nickname:string;avatar_source:string;avatar:string;add_time:number;joined_at:number;time:string;child_count:number;order_count:number;number_count:string}
export interface PromoterPeoplePage {owner_uid:number;query:PromoterPeopleQuery;total:number;total_level:number;filtered_count:number;page_count:number;brokerage_level:number;division_mode:boolean;commission:string;list:PromoterPerson[]}
const invalid=():never=>{throw Error('推广人数据不完整，请刷新后重试');};
const object=(v:unknown):Record<string,unknown>=>v&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:invalid();
const integer=(v:unknown,min=0):number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=min&&v<=2147483647?v:invalid();
const text=(v:unknown,max=255):string=>typeof v==='string'&&[...v].length<=max?v:invalid();
function keys(v:Record<string,unknown>,expected:string){if(Object.keys(v).sort().join(',')!==expected)invalid();}
const money=(v:unknown):string=>typeof v==='string'&&/^-?(?:0|[1-9]\d{0,30})\.\d{2}$/.test(v)?v:invalid();
export function personBefore(a:PromoterPerson,b:PromoterPerson):boolean{return a.add_time>b.add_time||a.add_time===b.add_time&&a.uid>b.uid;}
export function personAvatar(row:PromoterPerson,now=Date.now()):string{return memberLevelImage(memberRightImage(row.avatar_source,row.avatar,now));}
export function peopleMediaDeadline(rows:PromoterPerson[]):number|null{return memberRightMediaDeadline(rows.map(row=>row.avatar),[]);}
export function decodePromoterPeople(value:unknown,owner:number,query:PromoterPeopleQuery):PromoterPeoplePage {
 const v=object(value);keys(v,'brokerage_level,commission,division_mode,filtered_count,list,owner_uid,page_count,query,total,total_level');const q=object(v.query);keys(q,'grade,keyword,limit,page,start,stop');
 if(v.owner_uid!==owner||Object.keys(query).some(key=>q[key]!==query[key as keyof PromoterPeopleQuery])||!Array.isArray(v.list)||typeof v.division_mode!=='boolean')return invalid();
 const total=integer(v.total),total_level=integer(v.total_level),filtered_count=integer(v.filtered_count),page_count=integer(v.page_count),brokerage_level=integer(v.brokerage_level,-2147483648),commission=money(v.commission);
 if(filtered_count>(query.grade===0?total:total_level)||page_count!==v.list.length||page_count!==Math.min(20,Math.max(0,filtered_count-(query.page-1)*20))||page_count===0&&commission!=='0.00')return invalid();
 const list=v.list.map(value=>{const r=object(value);keys(r,'add_time,avatar,avatar_source,child_count,joined_at,nickname,number_count,order_count,time,uid');
  const uid=integer(r.uid,1),add_time=integer(r.add_time),joined_at=integer(r.joined_at),time=text(r.time,10),expected=joined_at?shanghaiDay(joined_at*1000):shanghaiDay(add_time*1000).replaceAll('-','/');if(time!==expected)return invalid();
  const source=text(r.avatar_source,4096),preview=text(r.avatar,8192),safe=memberRightImage(source,preview)&&memberLevelImage(preview);
  return{uid,add_time,joined_at,time,nickname:text(r.nickname),child_count:integer(r.child_count),order_count:integer(r.order_count),number_count:money(r.number_count),avatar_source:safe?source:'',avatar:safe?preview:''};
 });
 if(new Set(list.map(row=>row.uid)).size!==list.length||list.some((row,index)=>index>0&&!personBefore(list[index-1]!,row)))return invalid();
 return{owner_uid:owner,query:{...query},total,total_level,filtered_count,page_count,brokerage_level,division_mode:v.division_mode,commission,list};
}
export function createPromoterPeopleRequests(current:()=>boolean,query:PromoterPeopleQuery){const scope=createUserCenterRequests(current);return{...scope,page:async()=>decodePromoterPeople(await scope.request('spread/people?view=promoter_people','POST',{...query},true),scope.owner.uid,query)};}
export type PromoterPeopleRequests=ReturnType<typeof createPromoterPeopleRequests>;
