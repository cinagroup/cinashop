import type { Context } from 'hono';
import type { AppVariables,Env } from '@/env';
import { jsonOk } from '@/utils/json';
import { ValidateException } from '@/utils/errors';
import { AdminProductLabelService,type AdminProductLabelActor } from '@/services/admin/AdminProductLabelService';
import { labelId } from '@/services/admin/AdminProductLabelInput';
import { readBoundedUtf8Text } from '@/utils/request-body';
type C=Context<{Bindings:Env;Variables:AppVariables}>;
function context(c:C) {
  c.header('Cache-Control','private, no-store'); c.header('Pragma','no-cache');
  const actor:AdminProductLabelActor={id:c.get('adminId')??0,authVersion:c.get('socketAuthVersion')??'',expiresAt:c.get('socketTokenExp')??0};
  return {service:new AdminProductLabelService(c.get('container'),c.env.APP_KEY),actor,query:new URL(c.req.url).searchParams};
}
async function body(c:C) {
  if(new URL(c.req.url).searchParams.size) throw new ValidateException('标签写入不接受查询参数');
  const text=await readBoundedUtf8Text(c.req.raw,16384);
  try{return JSON.parse(text) as unknown;}catch{throw new ValidateException('标签提交JSON格式错误');}
}
function noQuery(c:C){if(new URL(c.req.url).searchParams.size)throw new ValidateException('标签操作不接受查询参数');}
export async function categoryList(c:C){const x=context(c);return jsonOk(c,await x.service.categoryList(x.query,x.actor));}
export async function categoryCreateForm(c:C){const x=context(c);return jsonOk(c,await x.service.categoryForm(0,x.query,x.actor));}
export async function categoryEditForm(c:C){const x=context(c);return jsonOk(c,await x.service.categoryForm(labelId(c.req.param('id')),x.query,x.actor));}
export async function categoryCreate(c:C){const x=context(c);return jsonOk(c,await x.service.saveCategory(0,await body(c),x.actor),'添加标签组成功');}
export async function categoryUpdate(c:C){const x=context(c);return jsonOk(c,await x.service.saveCategory(labelId(c.req.param('id')),await body(c),x.actor),'修改成功');}
export async function categoryDelete(c:C){const x=context(c);noQuery(c);return jsonOk(c,await x.service.deleteCategory(labelId(c.req.param('id')),x.actor),'删除成功');}
export async function list(c:C){const x=context(c);return jsonOk(c,await x.service.list(x.query,x.actor));}
export async function tree(c:C){const x=context(c);return jsonOk(c,await x.service.tree(x.query,x.actor));}
export async function all(c:C){const x=context(c);return jsonOk(c,await x.service.all(x.query,x.actor));}
export async function form(c:C){const x=context(c);return jsonOk(c,await x.service.form(x.query,x.actor));}
export async function save(c:C){
  const x=context(c),id=labelId(c.req.param('id'),true),submitted=await body(c);
  let input=submitted;
  if(submitted&&typeof submitted==='object'&&!Array.isArray(submitted)&&Object.prototype.hasOwnProperty.call(submitted,'id')){
    const {id:bodyId,...fields}=submitted as Record<string,unknown>;
    if(labelId(bodyId,true)!==id)throw new ValidateException('标签正文ID必须与路径一致');
    input=fields;
  }
  return jsonOk(c,await x.service.save(id,input,x.actor),'保存成功');
}
export async function setStatus(c:C){const x=context(c);noQuery(c);return jsonOk(c,await x.service.setFlag(labelId(c.req.param('id')),c.req.param('status'),'status',x.actor),'状态已更新');}
export async function setShow(c:C){const x=context(c);noQuery(c);return jsonOk(c,await x.service.setFlag(labelId(c.req.param('id')),c.req.param('show'),'isShow',x.actor),'展示状态已更新');}
export async function deleteLabel(c:C){const x=context(c);noQuery(c);return jsonOk(c,await x.service.deleteLabel(labelId(c.req.param('id')),x.actor),'删除成功');}
export async function batchDelete(c:C){const x=context(c);return jsonOk(c,await x.service.batchDelete(await body(c),x.actor),'批量删除完成');}
export async function modernList(c:C){const x=context(c);return jsonOk(c,await x.service.modernList(x.query,x.actor));}
export async function modernSave(c:C){const x=context(c);return jsonOk(c,await x.service.modernSave(await body(c),x.actor),'保存成功');}
export const modernDelete=deleteLabel;
