import { asc, desc, inArray, sql, getTableColumns } from 'drizzle-orm';
import type { Env } from '@/env';
import { withTx, type Container, type DbClient } from '@/lib/di';
import { systemDise, systemGroup, systemGroupData } from '@/models/schema';
import { decodeProductDetailDesign } from './ProductDetailDesignReadService';
import { DISE_TEMPLATE_TRIM_CHARACTERS, themeDeadlines, themeHash } from './ThemeReadService';
import { fabImage, fabLink } from '@/services/admin/AdminFabSettingsInput';
import { publicProductPictures, renderProductPictures } from '@/services/activity/ProductAssetPolicy';
import { cloneUserCenterDesign, isUserCenterDesignValue, type UserCenterDesignSnapshot, type UserCenterPosterItem, type UserCenterMenuItem } from '../../../../view/common/userCenterDesign';

export const USER_CENTER_TEMPLATE_NAME='member', USER_CENTER_GROUP_NAMES=['routine_my_banner','routine_my_menus'] as const;
export const USER_CENTER_MAX_BYTES=1_048_576, USER_CENTER_MAX_ROWS=100;
export type UserCenterListModule='poster'|'menu'|'merMenu';
export interface UserCenterSource { module:UserCenterListModule; original:Record<string,unknown>; groupRow?:typeof systemGroupData.$inferSelect; groupOriginal?:Record<string,unknown> }
const object=(value:unknown):Record<string,unknown>|null=>value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:null;
export function decodeUserCenterObject(value:string|null){return decodeProductDetailDesign(value);}
export function flattenUserCenterGroup(source:Record<string,unknown>){return Object.fromEntries(Object.entries(source).map(([key,item])=>[key,object(item)&&Object.hasOwn(item as object,'value')?(item as Record<string,unknown>).value:item]));}
const historicalMerchantTargets=new Set(['/kefu/mobile_list','/pages/store_spread/index','/pages/admin/order_cancellation/index','/pages/admin/order/index','/pages/admin/work/index','/pages/admin/distribution/index']);
export async function userCenterDesignCatalog(tx:DbClient){
  const member=await tx.select({id:systemDise.id,templateName:systemDise.templateName,type:systemDise.type,isDel:systemDise.isDel,status:systemDise.status,isShow:systemDise.isShow,version:systemDise.version,updateTime:systemDise.updateTime,xmin:sql<string>`xmin::text`,
    value:sql<string|null>`CASE WHEN octet_length(${systemDise.value})<=${USER_CENTER_MAX_BYTES} THEN ${systemDise.value} ELSE NULL END`,valueBytes:sql<number|null>`octet_length(${systemDise.value})`})
    .from(systemDise).where(sql`lower(btrim(${systemDise.templateName},${DISE_TEMPLATE_TRIM_CHARACTERS}))=${USER_CENTER_TEMPLATE_NAME}`).orderBy(asc(systemDise.id)).limit(3);
  const groups=await tx.select({...getTableColumns(systemGroup),xmin:sql<string>`xmin::text`,fields:sql<string|null>`CASE WHEN octet_length(${systemGroup.fields})<=262144 THEN ${systemGroup.fields} ELSE NULL END`})
    .from(systemGroup).where(sql`lower(btrim(${systemGroup.configName},${DISE_TEMPLATE_TRIM_CHARACTERS})) IN (${sql.join(USER_CENTER_GROUP_NAMES.map(name=>sql`${name}`),sql`,`)})`).orderBy(asc(systemGroup.id)).limit(7);
  const data=groups.length?await tx.select({...getTableColumns(systemGroupData),xmin:sql<string>`xmin::text`,value:sql<string|null>`CASE WHEN octet_length(${systemGroupData.value})<=${USER_CENTER_MAX_BYTES} THEN ${systemGroupData.value} ELSE NULL END`,valueBytes:sql<number|null>`octet_length(${systemGroupData.value})`})
    .from(systemGroupData).where(inArray(systemGroupData.gid,groups.map(row=>row.id))).orderBy(desc(systemGroupData.sort),asc(systemGroupData.id)).limit(USER_CENTER_MAX_ROWS*3+1):[];
  return{member,groups,data,revision:await themeHash({template:'member',type:3,member,groups,data})};
}
export async function projectUserCenterDesign(tx:DbClient,catalog:Awaited<ReturnType<typeof userCenterDesignCatalog>>){
  const issues:string[]=[],sources=new Map<string,UserCenterSource>(),boundGroupRows=new Set<number>();
  const snapshot:UserCenterDesignSnapshot={revision:catalog.revision,value:null,configured:catalog.member.length>0,editable:false,issues,imagePreviews:{poster:[],menu:[],merMenu:[]}};
  const reject=(issue:string)=>{issues.push(issue);return{snapshot,source:null,sources};};
  if(catalog.member.length>1)return reject('user_center_member_duplicate');
  const row=catalog.member[0];
  if(row&&(row.id<=0||row.templateName!=='member'||row.type!==3||row.isDel!==0))return reject('user_center_member_identity_invalid');
  const source=row?decodeUserCenterObject(row.value):null;
  if(row&&!source)return reject('user_center_member_value_invalid');
  if(catalog.data.length>USER_CENTER_MAX_ROWS*3)return reject('user_center_group_rows_overflow');
  const groupLists=new Map<string,Array<{original:Record<string,unknown>;flat:Record<string,unknown>;row:typeof systemGroupData.$inferSelect}>>();
  for(const name of USER_CENTER_GROUP_NAMES){
    const candidates=catalog.groups.filter(group=>group.configName.trim().toLowerCase()===name);
    if(candidates.length>1)return reject(`user_center_${name}_duplicate`);
    if(candidates[0]&&(candidates[0].id<=0||candidates[0].configName!==name))return reject(`user_center_${name}_identity_invalid`);
    if(!candidates.length){issues.push(`user_center_${name}_missing`);groupLists.set(name,[]);continue;}
    const data=catalog.data.filter(item=>item.gid===candidates[0].id),items=[];
    if(data.length>USER_CENTER_MAX_ROWS)return reject(`user_center_${name}_overflow`);
    for(const item of data){const original=decodeUserCenterObject(item.value);if(!original||![0,1].includes(item.status))return reject(`user_center_${name}_value_invalid`);if(item.status===1)items.push({original,flat:flattenUserCenterGroup(original),row:item});}
    if(name==='routine_my_menus')for(const item of items){const type=item.flat.type;if(type!==undefined&&![1,2,'1','2'].includes(type as number|string))return reject('user_center_menu_type_invalid');if(typeof type==='string')issues.push('user_center_menu_type_normalized');}
    groupLists.set(name,items);
  }
  const value=cloneUserCenterDesign();
  for(const key of ['member','order','orderStatic','poster','menu','merMenu'] as const){
    const saved=source?.[key];
    if(saved!==undefined&&!object(saved))return reject(`user_center_${key}_invalid`);
    if(saved)Object.assign(value[key],saved);
    else if(row)issues.push(`user_center_${key}_defaulted`);
  }
  if(source&&object(source.member)&&!Object.hasOwn(source.member as object,'per_show_type'))issues.push('user_center_per_show_type_defaulted');
  // List source IDs bind a single incoming item to the whole three-authority revision.
  // A missing legacy list can use its real group rows, with an explicit diagnostic.
  for(const module of ['poster','menu','merMenu'] as const){
    const savedBlock=object(source?.[module]),groupName=module==='poster'?'routine_my_banner':'routine_my_menus';
    const groupRows=groupLists.get(groupName)!.filter(item=>{if(module==='poster')return true;const type=item.flat.type===undefined?historicalMerchantTargets.has(String(item.flat.url))?2:1:Number(item.flat.type);if(item.flat.type===undefined)issues.push('user_center_menu_type_defaulted');return type===(module==='menu'?1:2);});
    const backfill=!savedBlock||!Object.hasOwn(savedBlock,'list');
    const rawList=backfill?groupRows.map(item=>item.flat):savedBlock.list;
    if(backfill&&groupRows.length)issues.push(`user_center_${module}_group_backfill`);
    if(!Array.isArray(rawList)||rawList.length>USER_CENTER_MAX_ROWS)return reject(`user_center_${module}_list_invalid`);
    const list=[];
    for(let index=0;index<rawList.length;index++){
      const original=object(rawList[index]);if(!original)return reject(`user_center_${module}_item_invalid`);
      if(module!=='poster'&&original.type!==undefined&&original.type!==(module==='menu'?1:2))issues.push(`user_center_${module}_type_normalized`);
      let pic=original.pic;if(Array.isArray(pic)&&pic.length===1&&typeof pic[0]==='string'){pic=pic[0];issues.push(`user_center_${module}_legacy_picture_array`);}
      const sourceId=await themeHash({revision:catalog.revision,module,index});
      const item={sourceId,name:original.name??original.title??'',pic:pic??'',url:original.url??'',...(module==='poster'?{}:{type:module==='menu'?1:2})};
      const matching=groupRows.filter(group=>String(group.flat.url??'')===String(item.url)&&String(group.flat.pic??'')===String(item.pic)&&String(group.flat.name??group.flat.title??'')===String(item.name));
      if(matching.length>1)return reject(`user_center_${module}_group_item_ambiguous`);
      const group=backfill?groupRows[index]:matching[0];
      if(group&&boundGroupRows.has(group.row.id))return reject(`user_center_${module}_group_item_ambiguous`);if(group)boundGroupRows.add(group.row.id);
      sources.set(sourceId,{module,original,...(group?{groupRow:group.row,groupOriginal:group.original}:{})});
      try{if(item.pic!=='')fabImage(item.pic);if(item.url!=='')fabLink(item.url);}catch{issues.push(`user_center_${module}_historical_target_partial`);}
      list.push(item);
    }
    value[module].list=list as UserCenterPosterItem[]&UserCenterMenuItem[];
    if(!backfill&&(groupRows.length!==list.length||list.some((item,index)=>{const group=groupRows[index]?.flat;return!group||String(group.name??group.title??'')!==item.name||String(group.pic??'')!==item.pic||String(group.url??'')!==item.url;})))issues.push(`user_center_${module}_group_disagreement`);
  }
  // Public/editable DTOs are always narrow; no avatar_url or opaque extensions escape.
  let projected;try{projected=cloneUserCenterDesign(value);}catch{return reject('user_center_known_fields_invalid');}
  if(!isUserCenterDesignValue(projected))return reject('user_center_known_fields_invalid');
  const pictures=[...projected.poster.list,...projected.menu.list,...projected.merMenu.list].map(item=>item.pic);
  const safe=await publicProductPictures(tx,pictures.map(image=>({image,type:0,relationId:0})));
  if(pictures.some((image,index)=>image!==''&&safe[index]===''))issues.push('user_center_picture_unavailable');
  const p=projected.poster.list.length,m=projected.menu.list.length;
  snapshot.value=projected;snapshot.editable=true;snapshot.imagePreviews={poster:safe.slice(0,p),menu:safe.slice(p,p+m),merMenu:safe.slice(p+m)};
  if(!row)issues.push('user_center_member_missing');
  return{snapshot,source,sources};
}
export async function readUserCenterDesignSnapshot(tx:DbClient){return projectUserCenterDesign(tx,await userCenterDesignCatalog(tx));}
export async function renderUserCenterDesignSnapshot(env:Pick<Env,'APP_KEY'>,snapshot:UserCenterDesignSnapshot){
  const images=snapshot.imagePreviews,p=images.poster.length,m=images.menu.length;
  const signed=await renderProductPictures(env.APP_KEY,[...images.poster,...images.menu,...images.merMenu]);
  return{...snapshot,imagePreviews:{poster:signed.slice(0,p),menu:signed.slice(p,p+m),merMenu:signed.slice(p+m)}};
}
export class UserCenterDesignReadService{constructor(private readonly container:Container,private readonly env:Pick<Env,'APP_KEY'>){}
  async read(){const result=await withTx(this.container,async tx=>{await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);await themeDeadlines(tx);return(await readUserCenterDesignSnapshot(tx)).snapshot;});return renderUserCenterDesignSnapshot(this.env,result);}
}
