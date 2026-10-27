import {createUserCenterRequests} from '@/api/userCenter';
export type LevelFieldFormat='text'|'num'|'mail'|'date'|'id'|'phone'|'radio'|'address';
export interface LevelActivationField{info:string;param:string;format:LevelFieldFormat;tip:string;required:0|1;singlearr:string[];value:string}
export interface LevelActivationState{owner_uid:number;member_enabled:boolean;activation_required:boolean;level_status:number;activated:boolean;revision:string;fields:LevelActivationField[]}
export interface LevelActivationOwnedCoupon{id:number;issue_id:number;status:number;start_time:string|null;end_time:string|null;is_fail:number;type:1|2;coupon_title:string;coupon_price:string;use_min_price:string}
export interface LevelActivationRewards{level_integral_status:0|1;level_give_integral:number;level_money_status:0|1;level_give_money:number;level_coupon_status:0|1;level_give_coupon:Array<{id:number;title:string;coupon_title:string;coupon_price:string;use_min_price:string}>}
export interface LevelActivationReceipt{owner_uid:number;activated:true;level_status:1;rewards:LevelActivationRewards;integral_bill_id:number|null;money_bill_id:number|null;owned_coupons:LevelActivationOwnedCoupon[]}
export interface LevelActivationCity{v:number;n:string;parent_id:number;children:LevelActivationCity[]}
const invalid=():never=>{throw Error('会员激活信息不完整，请重新读取');};
const object=(v:unknown):Record<string,unknown>=>v&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:invalid();
function exact(v:Record<string,unknown>,keys:string[]){if(Object.keys(v).sort().join(',')!==[...keys].sort().join(','))invalid();}
function text(v:unknown,max:number):string{if(typeof v!=='string'||[...v].length>max||/[\u0000-\u001f\u007f]/u.test(v)||[...v].some(c=>{const n=c.codePointAt(0)!;return n>=0xd800&&n<=0xdfff;}))return invalid();return v;}
const integer=(v:unknown,min=0,max=2147483647):number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=min&&v<=max?v:invalid();
const flag=(v:unknown):boolean=>typeof v==='boolean'?v:invalid();
const bit=(v:unknown):0|1=>v===0||v===1?v:invalid();
const money=(v:unknown):string=>typeof v==='string'&&/^(?:0|[1-9]\d{0,9})\.\d{2}$/u.test(v)?v:invalid();
const date=(v:unknown):string|null=>v===null?null:typeof v==='string'&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString()===v?v:invalid();
export function decodeLevelActivationState(raw:unknown,owner:number):LevelActivationState{
 const v=object(raw);exact(v,['owner_uid','member_enabled','activation_required','level_status','activated','revision','fields']);if(v.owner_uid!==integer(owner,1)||!Array.isArray(v.fields)||v.fields.length>64||typeof v.revision!=='string'||!/^[a-f0-9]{64}$/u.test(v.revision))return invalid();
 const level_status=integer(v.level_status,-32768,32767),activated=flag(v.activated);if(activated!==(level_status===1))return invalid();
 const mappings:Record<string,LevelFieldFormat>={real_name:'text',sex:'radio',birthday:'date',card_id:'id',address:'address',mark:'text'};
 const fields=v.fields.map(value=>{const f=object(value);exact(f,['info','param','format','tip','required','singlearr','value']);const info=text(f.info,80),param=text(f.param,32),format=text(f.format,16) as LevelFieldFormat;if(!info.trim()||!['text','num','mail','date','id','phone','radio','address'].includes(format)||param&&mappings[param]!==format||!Array.isArray(f.singlearr)||f.singlearr.length>32)return invalid();const singlearr=f.singlearr.map(x=>text(x,80));if(singlearr.some(x=>!x.trim())||new Set(singlearr).size!==singlearr.length||format==='radio'&&singlearr.length<2||format!=='radio'&&singlearr.length||param==='sex'&&JSON.stringify(singlearr)!==JSON.stringify(['男','女','保密'])||f.value!==(format==='radio'?'0':''))return invalid();return{info,param,format,tip:text(f.tip,160),required:bit(f.required),singlearr,value:f.value as string};});
 if(new Set(fields.map(f=>f.info)).size!==fields.length||new Set(fields.filter(f=>f.param).map(f=>f.param)).size!==fields.filter(f=>f.param).length)return invalid();
 return{owner_uid:owner,member_enabled:flag(v.member_enabled),activation_required:flag(v.activation_required),level_status,activated,revision:v.revision,fields};
}
export function decodeLevelActivationReceipt(raw:unknown,owner:number):LevelActivationReceipt{
 const v=object(raw);exact(v,['owner_uid','activated','level_status','rewards','integral_bill_id','money_bill_id','owned_coupons']);if(v.owner_uid!==integer(owner,1)||v.activated!==true||v.level_status!==1||!Array.isArray(v.owned_coupons)||v.owned_coupons.length>1000)return invalid();
 const r=object(v.rewards);exact(r,['level_integral_status','level_give_integral','level_money_status','level_give_money','level_coupon_status','level_give_coupon']);if(!Array.isArray(r.level_give_coupon)||r.level_give_coupon.length>1000)return invalid();
 const rewards:LevelActivationRewards={level_integral_status:bit(r.level_integral_status),level_give_integral:integer(r.level_give_integral,0,Number.MAX_SAFE_INTEGER),level_money_status:bit(r.level_money_status),level_give_money:integer(r.level_give_money,0,Number.MAX_SAFE_INTEGER),level_coupon_status:bit(r.level_coupon_status),level_give_coupon:r.level_give_coupon.map(value=>{const c=object(value);exact(c,['id','title','coupon_title','coupon_price','use_min_price']);return{id:integer(c.id,1),title:text(c.title,255),coupon_title:text(c.coupon_title,255),coupon_price:money(c.coupon_price),use_min_price:money(c.use_min_price)};})};
 const owned_coupons:LevelActivationOwnedCoupon[]=v.owned_coupons.map(value=>{const c=object(value);exact(c,['id','issue_id','status','start_time','end_time','is_fail','type','coupon_title','coupon_price','use_min_price']);if(c.type!==1&&c.type!==2)return invalid();const price=money(c.coupon_price),start=date(c.start_time),end=date(c.end_time);if(c.type===2&&(Number(price)<=0||Number(price)>100)||start&&end&&Date.parse(end)<Date.parse(start))return invalid();return{id:integer(c.id,1),issue_id:integer(c.issue_id,1),status:integer(c.status,0,2),start_time:start,end_time:end,is_fail:bit(c.is_fail),type:c.type,coupon_title:text(c.coupon_title,255),coupon_price:price,use_min_price:money(c.use_min_price)};});
 const integral_bill_id=v.integral_bill_id===null?null:integer(v.integral_bill_id,1),money_bill_id=v.money_bill_id===null?null:integer(v.money_bill_id,1);
 if((rewards.level_give_integral>0)!==(integral_bill_id!==null)||(rewards.level_give_money>0)!==(money_bill_id!==null)||!rewards.level_integral_status&&rewards.level_give_integral||!rewards.level_money_status&&rewards.level_give_money||!rewards.level_coupon_status&&owned_coupons.length||new Set(owned_coupons.map(c=>c.id)).size!==owned_coupons.length||new Set(owned_coupons.map(c=>c.issue_id)).size!==owned_coupons.length||owned_coupons.length!==rewards.level_give_coupon.length||owned_coupons.some((c,i)=>{const old=rewards.level_give_coupon[i];return !old||c.issue_id!==old.id||c.coupon_price!==old.coupon_price||c.use_min_price!==old.use_min_price||c.status!==0||c.is_fail!==0;}))return invalid();
 return{owner_uid:owner,activated:true,level_status:1,rewards,integral_bill_id,money_bill_id,owned_coupons};
}
export function decodeLevelActivationCities(raw:unknown):LevelActivationCity[]{
 let count=0;const seen=new Set<number>();function walk(value:unknown,parent:number,depth:number):LevelActivationCity[]{if(!Array.isArray(value)||depth>8)return invalid();return value.map(entry=>{if(++count>10000)return invalid();const c=object(entry);exact(c,['v','n','parent_id','children']);const v=integer(c.v,1),n=text(c.n,100);if(!n.trim()||c.parent_id!==parent||seen.has(v))return invalid();seen.add(v);return{v,n,parent_id:parent,children:walk(c.children,v,depth+1)};});}return walk(raw,0,0);
}
export function createLevelActivationRequests(current:()=>boolean){const scope=createUserCenterRequests(current);return{...scope,
 state:async()=>decodeLevelActivationState(await scope.request('user/level/activate_info','GET',{view:1},true),scope.owner.uid),
 activate:async(revision:string,fields:Array<{info:string;value:string}>)=>{const body={revision,fields};if(new TextEncoder().encode(JSON.stringify(body)).byteLength>16*1024)throw Error('激活资料超过16KiB，请缩短填写内容');return decodeLevelActivationReceipt(await scope.request('user/level/activate?view=1','POST',body,true),scope.owner.uid);},
 cities:async()=>decodeLevelActivationCities(await scope.request('city_list','GET',{},false)),
};}
export type LevelActivationRequests=ReturnType<typeof createLevelActivationRequests>;
export function levelActivationCouponBenefit(c:LevelActivationOwnedCoupon):string{return c.type===2?String(Number(c.coupon_price)/10)+'折':c.coupon_price+'元';}
