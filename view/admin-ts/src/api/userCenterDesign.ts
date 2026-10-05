import request, { getData } from '@/utils/request';
import { normalizeUserCenterDesignWrite, parseUserCenterDesignReceipt, parseUserCenterDesignSnapshot, type UserCenterDesignWrite } from '../../../common/userCenterDesignController';
import { normalizeFabLinkQuery, parseFabLinkCategories, parseFabLinkTargets, type FabLinkQuery } from './fabSettings';
import { isUserCenterPublicImage } from '../../../common/userCenterDesign';
const base='/config/user-center-design';
export async function apiUserCenterDesign(signal?:AbortSignal){return parseUserCenterDesignSnapshot(await getData(request.get(base,{signal})));}
export async function apiSaveUserCenterDesign(value:UserCenterDesignWrite,signal?:AbortSignal){const input=normalizeUserCenterDesignWrite(value);return parseUserCenterDesignReceipt(await getData(request.post(`${base}/save`,input,{signal})),input.operationId);}
export async function apiUserCenterDesignReceipt(operationId:string,signal?:AbortSignal){if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(operationId))throw Error('个人中心请求标识无效');return parseUserCenterDesignReceipt(await getData(request.get(`${base}/receipt/${operationId}`,{signal})),operationId);}
export async function apiUserCenterLinkCategories(signal?:AbortSignal){return parseFabLinkCategories(await getData(request.get(`${base}/link-categories`,{signal})));}
export async function apiUserCenterLinkTargets(query:FabLinkQuery,signal?:AbortSignal){const normalized=normalizeFabLinkQuery(query);return parseFabLinkTargets(await getData(request.get(`${base}/link-targets`,{params:normalized,signal})),normalized);}
export interface UserCenterAsset {id:number;name:string;canonical_url:string;preview_url:string}
export interface UserCenterAssets {list:UserCenterAsset[];count:number;page:number;limit:number}
const integer=(value:unknown,min=0,max=2147483647):value is number=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=min&&value<=max;
const image=isUserCenterPublicImage;
export function parseUserCenterAssets(value:unknown,page:number,limit:number):UserCenterAssets{
  if(!value||typeof value!=='object'||Array.isArray(value))throw Error('素材目录响应无效');const row=value as UserCenterAssets;
  if(!integer(row.count)||row.page!==page||row.limit!==limit||!Array.isArray(row.list)||row.list.length>limit||row.list.length>row.count||new Set(row.list.map(item=>item.id)).size!==row.list.length||row.list.some(item=>!item||!integer(item.id,1)||typeof item.name!=='string'||!item.name||item.name.length>255||/[\u0000-\u001f\u007f]/u.test(item.name)||!image(item.canonical_url)||!image(item.preview_url)))throw Error('素材分页、身份或预览地址无效');return row;
}
export async function apiUserCenterAssets(query:{page:number;limit:number;search?:string},signal?:AbortSignal){if(!integer(query.page,1,10000)||!integer(query.limit,1,100)||query.search!==undefined&&(typeof query.search!=='string'||[...query.search].length>100||/[\u0000-\u001f\u007f]/u.test(query.search)))throw Error('素材查询无效');return parseUserCenterAssets(await getData(request.get(`${base}/assets`,{params:query,signal})),query.page,query.limit);}
