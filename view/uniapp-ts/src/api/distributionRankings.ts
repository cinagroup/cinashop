import {createUserCenterRequests} from '@/api/userCenter';
import {memberLevelImage} from '@/api/memberLevels';
import {memberRightImage,memberRightMediaDeadline} from '../../../common/memberRightMedia';
export type RankingKind='promoter'|'commission';
export type RankingPeriod='week'|'month';
export interface RankingRow {uid:number;position:number;nickname:string;avatar_source:string;avatar:string;value:string}
export interface RankingPage {owner_uid:number;kind:RankingKind;type:RankingPeriod;page:number;limit:20;list:RankingRow[];self:RankingRow}
export const RANKING_PAGE_SIZE=20,MAX_RANKING_PAGE=500;
const invalid=():never=>{throw Error('排行数据不完整，请刷新后重试');};
const object=(v:unknown):Record<string,unknown>=>v&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:invalid();
const integer=(v:unknown,min=1):number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=min&&v<=2147483647?v:invalid();
const text=(v:unknown,max:number):string=>typeof v==='string'&&[...v].length<=max?v:invalid();
function keys(v:Record<string,unknown>,expected:string){if(Object.keys(v).sort().join(',')!==expected)invalid();}
export function rankingAvatar(row:RankingRow,now=Date.now()):string{return memberLevelImage(memberRightImage(row.avatar_source,row.avatar,now));}
export function rankingMediaDeadline(rows:RankingRow[]):number|null{return memberRightMediaDeadline(rows.map(row=>row.avatar),[]);}
export function sameRankingRow(a:RankingRow,b:RankingRow):boolean{return a.uid===b.uid&&a.position===b.position&&a.value===b.value&&a.nickname===b.nickname&&a.avatar_source===b.avatar_source;}
export function rankingBefore(a:RankingRow,b:RankingRow):boolean {const av=BigInt(a.value.replace('.','')),bv=BigInt(b.value.replace('.',''));return av>bv||av===bv&&a.uid>b.uid;}
export function decodeRankingPage(value:unknown,owner:number,kind:RankingKind,type:RankingPeriod,page:number):RankingPage {
 const v=object(value);keys(v,'kind,limit,list,owner_uid,page,self,type');
 if(v.owner_uid!==owner||v.kind!==kind||v.type!==type||v.page!==page||v.limit!==20||!Array.isArray(v.list)||v.list.length>20)return invalid();
 function row(value:unknown,self=false):RankingRow{const v=object(value);keys(v,'avatar,avatar_source,nickname,position,uid,value');
  const uid=integer(v.uid),position=integer(v.position,self?0:1),amount=text(v.value,40),nickname=text(v.nickname,255),source=text(v.avatar_source,4096),preview=text(v.avatar,8192);
  if(!(kind==='promoter'?/^(?:0|[1-9]\d{0,30})$/:/^(?:0|[1-9]\d{0,30})\.\d{2}$/).test(amount)||self&&uid!==owner||position===0&&BigInt(amount.replace('.',''))!==0n||position>0&&BigInt(amount.replace('.',''))===0n)return invalid();
  const safe=memberRightImage(source,preview)&&memberLevelImage(preview);
  return{uid,position,nickname,avatar_source:safe?source:'',avatar:safe?preview:'',value:amount};
 }
 const list=v.list.map(value=>row(value)),self=row(v.self,true);
 if(new Set(list.map(row=>row.uid)).size!==list.length||list.some((row,index)=>row.position!==(page-1)*20+index+1||index>0&&!rankingBefore(list[index-1]!,row)))return invalid();
 const mine=list.find(row=>row.uid===owner);if(mine&&!sameRankingRow(mine,self))return invalid();
 return{owner_uid:owner,kind,type,page,limit:20,list,self};
}
export function createRankingRequests(current:()=>boolean,kind:RankingKind,type:RankingPeriod){
 const scope=createUserCenterRequests(current);
 return{...scope,page:async(page:number)=>decodeRankingPage(await scope.request(kind==='promoter'?'rank':'brokerage_rank','GET',{view:'leaderboard',type,page,limit:20},true),scope.owner.uid,kind,type,page)};
}
export type RankingRequests=ReturnType<typeof createRankingRequests>;
