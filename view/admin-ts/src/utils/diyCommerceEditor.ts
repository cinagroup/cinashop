import { DIY_COMMERCE_DEFAULTS } from './diyCommerceDefaults';
import { commerceControlKeys } from './diyCommerceControls';
import { navigationDocument, navigationRecord as record, navRead as read, navSet, navTimestamp, NAVIGATION_BODY_NAMES } from './diyNavigationEditor';
import { editorialImageIdentity, editorialPreviewUrl } from './diyEditorialEditor';
import { listIdentity, type ListSelection, type ListSelectionKind } from './diyListEditor';
export const COMMERCE_NAMES = ['promotionList','seckill','combination','bargain','presale','pointsMall','coupon','liveBroadcast'] as const;
export type CommerceKind=typeof COMMERCE_NAMES[number];
export type CommerceRecord=Record<string,unknown>;
export type CommercePath=Array<string|number>;
export const commerceLabels:Record<CommerceKind,string>={promotionList:'促销商品',seckill:'限时秒杀',combination:'拼团',bargain:'砍价',presale:'预售',pointsMall:'积分商城',coupon:'优惠券',liveBroadcast:'小程序直播'};
export const commerceKind=(value:unknown):CommerceKind|null=>COMMERCE_NAMES.includes(value as CommerceKind)?value as CommerceKind:null;
export const commerceDocument=navigationDocument,commerceRecord=record,commerceRead=read,commerceImageIdentity=editorialImageIdentity,commercePreviewUrl=editorialPreviewUrl;
export function commerceEntries(value:unknown[]){return value.flatMap((raw,index)=>{const kind=commerceKind(record(raw)?.name);return kind?[{index,kind}]:[];}).sort((a,b)=>navTimestamp(value[a.index])-navTimestamp(value[b.index])||a.index-b.index);}
export function newCommerceBlock(kind:CommerceKind,timestamp:number):CommerceRecord{return {...structuredClone(DIY_COMMERCE_DEFAULTS[kind]),timestamp};}
export function addCommerceBlock(value:unknown[],kind:CommerceKind,source?:CommerceRecord){
 if(!commerceKind(kind))throw Error('商城组件类型无效');
 const copy=structuredClone(value),maximum=Math.max(0,...copy.filter(row=>NAVIGATION_BODY_NAMES.includes(record(row)?.name as typeof NAVIGATION_BODY_NAMES[number])).map(navTimestamp)),timestamp=maximum+Math.max(1,Math.abs(maximum)*Number.EPSILON*2);
 if(!Number.isSafeInteger(timestamp)||timestamp<=maximum)throw Error('排序空间不足，请先明确调整排序');
 const footer=copy.findIndex(row=>String(record(row)?.name).toLowerCase()==='pagefoot'),selected=footer<0?copy.length:footer;
 copy.splice(selected,0,source?{...structuredClone(source),timestamp}:newCommerceBlock(kind,timestamp));return{value:copy,selected};
}
export function moveCommerceBlock(value:unknown[],selected:number,direction:-1|1){
 if(!commerceKind(record(value[selected])?.name))throw Error('未选择商城组件');
 const indices=value.map((_,i)=>i).filter(i=>NAVIGATION_BODY_NAMES.includes(record(value[i])?.name as typeof NAVIGATION_BODY_NAMES[number])).sort((a,b)=>navTimestamp(value[a])-navTimestamp(value[b])||a-b),target=indices[indices.indexOf(selected)+direction];
 if(target===undefined||['homeComb','headerSerch','tabNav','pageFoot'].includes(String(record(value[target])?.name)))throw Error('不能越过头部或底部导航');
 const a=navTimestamp(value[selected]),b=navTimestamp(value[target]);if(a===b||[a,b].includes(Number.MAX_SAFE_INTEGER))throw Error('相同或异常排序值需要先明确调整');
 const copy=structuredClone(value);record(copy[selected])!.timestamp=b;record(copy[target])!.timestamp=a;[copy[selected],copy[target]]=[copy[target],copy[selected]];return{value:copy,selected:target};
}
export function commerceMediaPaths(block:CommerceRecord):CommercePath[]{
 if(['seckill','combination','bargain','presale'].includes(String(block.name)))return ['imgBgConfig','imgConfig','imgColorConfig'].map(key=>[key,'url']);
 if(block.name==='pointsMall')return ['imgBgConfig','imgConfig','imgConfig2'].map(key=>[key,'url']);
 const list=read(block,['tabConfig','list']);return block.name==='promotionList'&&Array.isArray(list)?list.flatMap((row,index)=>record(row)?[['tabConfig','list',index,'image'] as CommercePath]:[]):[];
}
export function canonicalCommerceBlock(raw:CommerceRecord,published=false){const block=structuredClone(raw);if(commerceKind(block.name))for(const path of commerceMediaPaths(block)){const value=read(block,path);if(typeof value==='string')navSet(block,path,editorialImageIdentity(value));}if(published&&block.name==='promotionList')for(const key of ['titleShow','opriceShow','priceShow','couponShow']){const owner=record(block[key]);if(owner)delete owner.title;}return block;}
export function canonicalCommerceValue(raw:string){const value:unknown=JSON.parse(raw);if(value===null)throw Error('装修value不能为null');if(Array.isArray(value))for(let i=0;i<value.length;i++){const block=record(value[i]);if(block&&commerceKind(block.name))value[i]=canonicalCommerceBlock(block);}return JSON.stringify(value);}
export interface CommerceField {key:string;label:string;type:'heading'|'enum'|'text'|'number'|'color'|'radius'|'image'|'check'|'tabs';defaultValue:unknown;options:Array<{value:number;label:string}>;minimum:number;maximum:number}
export function commerceFields(block:CommerceRecord):CommerceField[]{
 const kind=commerceKind(block.name);if(!kind)return[];const defaults:CommerceRecord=DIY_COMMERCE_DEFAULTS[kind];
 return commerceControlKeys(block).filter(key=>key!=='setUp').flatMap(key=>{
  const raw=defaults[key],cfg=record(raw);let type:CommerceField['type']|null=null;
  if(typeof raw==='string')type='heading';else if(key==='tabConfig')type='tabs';else if(key==='checkboxInfo')type='check';else if(cfg&&Array.isArray(cfg.color))type='color';else if(cfg&&Object.hasOwn(cfg,'url'))type='image';else if(cfg&&Object.hasOwn(cfg,'valList'))type='radius';else if(cfg&&Object.hasOwn(cfg,'value'))type='text';else if(cfg&&Object.hasOwn(cfg,'val'))type='number';else if(cfg&&Object.hasOwn(cfg,'tabVal'))type='enum';
  if(!type)return[];
  let options=Array.isArray(cfg?.tabList)?cfg.tabList.map((entry,index)=>({value:index,label:String(record(entry)?.name??index)})):[];
  if(key==='styleConfig'&&kind==='coupon')options=Array.from({length:5},(_,i)=>({value:i,label:`样式${i+1}`}));
  if(key==='bntStyleConfig')options=[{value:0,label:'购买文字'},{value:1,label:'加号'},{value:2,label:'购物车'}];
  return[{key,label:String(cfg?.title??cfg?.name??raw??key),type,defaultValue:raw,options,minimum:Number(cfg?.min??0),maximum:type==='text'?Number(cfg?.max??100):100}];
 });
}
function equalPath(a:CommercePath,b:CommercePath){return JSON.stringify(a)===JSON.stringify(b);}
/** Leaf edits are accepted only for a current visible PHP control. navSet refuses malformed ancestors. */
export function commerceFieldPatch(block:CommerceRecord,path:CommercePath,value:unknown){
 if(!commerceKind(block.name)||path.some(key=>['__proto__','constructor','prototype'].includes(String(key))))throw Error('商城字段路径无效');
 const old=read(block,path);if(old===value)return false;
 if(equalPath(path,['isHide'])){if(typeof value!=='boolean')throw Error('显示状态无效');}
 else if(equalPath(path,['setUp','tabVal'])){if(value!==0&&value!==1)throw Error('设置面板无效');}
 else{
  const field=commerceFields(block).find(f=>f.key===path[0]);if(!field)throw Error('该字段当前未启用');
  const second=path[1];let valid=false;
  if(field.type==='enum'&&path.length===2&&second==='tabVal')valid=field.options.some(option=>option.value===value);
  if(field.type==='text'&&path.length===2&&second==='value')valid=typeof value==='string'&&!/[\u0000-\u001f\u007f]/u.test(value)&&[...value].length<=Math.max(field.maximum,typeof old==='string'?[...old].length:0);
  if(field.type==='number'&&path.length===2&&second==='val')valid=typeof value==='number'&&Number.isFinite(value)&&value>=field.minimum&&value<=field.maximum&&(field.key!=='numberConfig'||Number.isInteger(value));
  if(field.type==='radius')valid=path.length===2&&second==='type'&&(value===0||value===1)||((path.length===2&&second==='val')||(path.length===4&&second==='valList'&&typeof path[2]==='number'&&path[2]>=0&&path[2]<4&&path[3]==='val'))&&typeof value==='number'&&Number.isFinite(value)&&value>=0&&value<=100;
  if(field.type==='color'&&path.length===4&&second==='color'&&typeof path[2]==='number'&&Array.isArray(record(field.defaultValue)?.color)&&path[2]>=0&&path[2]<(record(field.defaultValue)!.color as unknown[]).length&&path[3]==='item')valid=typeof value==='string'&&(/^(?:#[0-9a-f]{3,8}|(?:rgb|hsl)a?\([0-9.,%\s+-]+\)|transparent|black|white)$/iu.test(value));
  if(field.type==='check'&&path.length===2&&second==='type'){const options=record(field.defaultValue)?.list;valid=Array.isArray(value)&&Array.isArray(options)&&value.every(id=>options.some(option=>record(option)?.id===id));}
  if(!valid)throw Error('商城字段值无效');
 }
 navSet(block,path,value);return true;
}
export function commerceTabs(block:CommerceRecord):unknown[]{const list=read(block,['tabConfig','list']);if(block.name!=='promotionList')throw Error('未选择促销组件');if(list!==undefined&&!Array.isArray(list))throw Error('已存促销页签结构异常，请在JSON中明确修复');return Array.isArray(list)?list:[];}
function tabAt(block:CommerceRecord,index:number){const list=commerceTabs(block);if(!Number.isSafeInteger(index)||index<0||!record(list[index]))throw Error('促销页签索引或结构无效');return record(list[index])!;}
export function commerceTabListEdit(block:CommerceRecord,action:'add'|'remove'|'move',index=-1,direction:-1|1=1){
 const list=structuredClone(commerceTabs(block));
 if(action==='add')list.push(structuredClone(DIY_COMMERCE_DEFAULTS.promotionList.tabConfig.list[0]));
 else{if(!Number.isSafeInteger(index)||index<0||index>=list.length)throw Error('促销页签索引无效');if(action==='remove')list.splice(index,1);else{const to=index+direction;if(to<0||to>=list.length)throw Error('促销页签已位于边界');[list[index],list[to]]=[list[to],list[index]];}}
 navSet(block,['tabConfig','list'],list);
}
export function commerceTabPatch(block:CommerceRecord,index:number,path:CommercePath,value:unknown){
 const tab=tabAt(block,index),old=read(tab,path);if(old===value)return false;let valid=false;
 if(path.length===3&&path[0]==='chiild'&&(path[1]===0||path[1]===1)&&path[2]==='val')valid=typeof value==='string'&&!/[\u0000-\u001f\u007f]/u.test(value)&&[...value].length<=Math.max(4,typeof old==='string'?[...old].length:0);
 if(equalPath(path,['tabVal']))valid=[1,2,3,4].includes(Number(value))&&typeof value==='number';
 if(equalPath(path,['goodsSort']))valid=[0,1,2].includes(Number(value))&&typeof value==='number';
 if(equalPath(path,['numConfig','val']))valid=typeof value==='number'&&Number.isInteger(value)&&value>=0&&value<=100;
 if(!valid)throw Error('促销页签字段无效');navSet(tab,path,value);return true;
}
export type CommerceSelectionKind=Exclude<ListSelectionKind,'article_category'>;
export const commerceTabScope=(tab:unknown):CommerceSelectionKind=>({1:'product',2:'brand',3:'category',4:'label'} as Record<number,CommerceSelectionKind>)[Number(record(tab)?.tabVal)]??'category';
const selectionPath=(kind:CommerceSelectionKind):CommercePath=>({product:['goodsList','ids'],brand:['brandConfig','brandVal'],category:['selectConfig','activeValue'],label:['goodsLabel','activeValue']})[kind];
export function commerceTabSelections(tab:unknown,kind=commerceTabScope(tab)):unknown[]{const raw=read(tab,selectionPath(kind));if(raw===undefined&&kind==='product'){const rows=read(tab,['goodsList','list']);if(rows===undefined)return[];if(!Array.isArray(rows))throw Error('已存商品资料结构异常');return rows.map(row=>record(row)?.id??record(row)?.value??row);}if(raw!==undefined&&!Array.isArray(raw))throw Error('已存范围结构异常，请明确清空或在JSON中修复');return Array.isArray(raw)?raw:[];}
export function chooseCommerceSelection(block:CommerceRecord,index:number,choice:ListSelection){
 const tab=tabAt(block,index),kind=commerceTabScope(tab);if(choice.kind!==kind||listIdentity(choice.id)===null||typeof choice.name!=='string'||!choice.name||choice.name.length>512||/[\u0000-\u001f\u007f]/u.test(choice.name))throw Error('目录身份与当前页签范围不匹配');
 const ids=structuredClone(commerceTabSelections(tab,kind));if(ids.some(id=>listIdentity(record(id)?.id??record(id)?.value??id)===null))throw Error('已存范围含无效编号，请先明确移除');
 if(ids.some(id=>Number(record(id)?.id??record(id)?.value??id)===choice.id))return false;
 if(ids.length>=(kind==='product'?20:100))throw Error(kind==='product'?'普通新增最多选择20个商品；导入项完整保留':'普通新增最多选择100项；导入项完整保留');
 ids.push(choice.id);navSet(tab,selectionPath(kind),ids);
 if(kind==='product'||kind==='label'){const path=kind==='product'?['goodsList','list']:['goodsLabel','list'],raw=read(tab,path);if(raw!==undefined&&!Array.isArray(raw))throw Error('已存目录资料结构异常');const rows=structuredClone(Array.isArray(raw)?raw:[]);if(!rows.some(row=>Number(record(row)?.id)===choice.id))rows.push({id:choice.id,[kind==='product'?'store_name':'label_name']:choice.name});navSet(tab,path,rows);}
 return true;
}
export function changeCommerceSelection(block:CommerceRecord,index:number,action:'clear'|'remove'|'move',at=-1,direction:-1|1=1){
 const tab=tabAt(block,index),kind=commerceTabScope(tab);if(action==='clear'){navSet(tab,selectionPath(kind),[]);return;}
 const ids=structuredClone(commerceTabSelections(tab,kind));if(!Number.isSafeInteger(at)||at<0||at>=ids.length)throw Error('范围项索引无效');
 if(action==='remove')ids.splice(at,1);else{const to=at+direction;if(to<0||to>=ids.length)throw Error('范围项已位于边界');[ids[at],ids[to]]=[ids[to],ids[at]];}
 navSet(tab,selectionPath(kind),ids);
}
