import type {Context} from 'hono';
import type {AppVariables,Env} from '@/env';
import {jsonOk} from '@/utils/json';
import {ValidateException} from '@/utils/errors';
import {readBoundedUtf8Text} from '@/utils/request-body';
import {AdminProductBrandService,type AdminProductBrandActor} from '@/services/admin/AdminProductBrandService';
import {brandId,brandObject} from '@/services/admin/AdminProductBrandInput';
type C=Context<{Bindings:Env;Variables:AppVariables}>;
function context(c:C){
  c.header('Cache-Control','private, no-store');c.header('Pragma','no-cache');
  const actor:AdminProductBrandActor={id:c.get('adminId')??0,authVersion:c.get('socketAuthVersion')??'',expiresAt:c.get('socketTokenExp')??0};
  return {service:new AdminProductBrandService(c.get('container')),actor,query:new URL(c.req.url).searchParams};
}
function noQuery(c:C){if(new URL(c.req.url).searchParams.size)throw new ValidateException('品牌写入不接受查询参数');}
async function body(c:C){noQuery(c);const raw=await readBoundedUtf8Text(c.req.raw,16384);try{return JSON.parse(raw) as unknown;}catch{throw new ValidateException('品牌提交JSON格式错误');}}
function legacyInput(value:unknown,id:number){
  // PHP menusFrom submits the displayed row on edit. These fields are DTO
  // metadata, not writable ownership or derived topology.
  const row=brandObject(value,['fid','brand_name','sort','is_show','id','pid','store_id','add_time','is_del','brand_num','type','fid_son','children','loading','_loading']);
  if(Object.prototype.hasOwnProperty.call(row,'id')&&brandId(row.id,true)!==id)throw new ValidateException('品牌正文ID必须与路径一致');
  if(row.store_id!==undefined&&brandId(row.store_id,true)!==0)throw new ValidateException('品牌不属于平台');
  return {fid:row.fid,brand_name:row.brand_name,sort:row.sort,is_show:row.is_show};
}
export async function list(c:C){const x=context(c);return jsonOk(c,await x.service.list(x.query,x.actor));}
export async function cascader(c:C){const x=context(c);return jsonOk(c,await x.service.cascader(c.req.param('type'),x.query,x.actor));}
export async function create(c:C){const x=context(c);return jsonOk(c,await x.service.save(0,legacyInput(await body(c),0),x.actor),'添加品牌成功');}
export async function update(c:C){const x=context(c),id=brandId(c.req.param('id'));return jsonOk(c,await x.service.save(id,legacyInput(await body(c),id),x.actor),'修改成功');}
export async function setShow(c:C){const x=context(c);noQuery(c);return jsonOk(c,await x.service.setShow(brandId(c.req.param('id')),c.req.param('is_show'),x.actor),'品牌显示状态已更新');}
export async function remove(c:C){const x=context(c);noQuery(c);return jsonOk(c,await x.service.remove(brandId(c.req.param('id')),x.actor),'删除成功');}
export async function modernList(c:C){const x=context(c);return jsonOk(c,await x.service.modernList(x.query,x.actor));}
export async function modernSave(c:C){const x=context(c);return jsonOk(c,await x.service.modernSave(await body(c),x.actor),'保存成功');}
export const modernDelete=remove;
