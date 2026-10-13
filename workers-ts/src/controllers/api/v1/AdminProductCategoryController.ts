import type {Context} from 'hono';
import type {AppVariables,Env} from '@/env';
import {jsonOk} from '@/utils/json';
import {ValidateException} from '@/utils/errors';
import {readBoundedUtf8Text} from '@/utils/request-body';
import {AdminProductCategoryService,type AdminProductCategoryActor} from '@/services/admin/AdminProductCategoryService';
import {categoryId,categoryObject} from '@/services/admin/AdminProductCategoryInput';
type C=Context<{Bindings:Env;Variables:AppVariables}>;
function context(c:C){
  c.header('Cache-Control','private, no-store');c.header('Pragma','no-cache');
  const actor:AdminProductCategoryActor={id:c.get('adminId')??0,authVersion:c.get('socketAuthVersion')??'',expiresAt:c.get('socketTokenExp')??0};
  return {service:new AdminProductCategoryService(c.get('container'),c.env.APP_KEY),actor,query:new URL(c.req.url).searchParams};
}
function noQuery(c:C){if(new URL(c.req.url).searchParams.size)throw new ValidateException('分类写入不接受查询参数');}
async function body(c:C){noQuery(c);const raw=await readBoundedUtf8Text(c.req.raw,16384);try{return JSON.parse(raw) as unknown;}catch{throw new ValidateException('分类提交JSON格式错误');}}
function legacyInput(value:unknown,id:number){const row=categoryObject(value,['id','pid','cate_name','pic','big_pic','sort','is_show','expected_revision']);if(Object.prototype.hasOwnProperty.call(row,'id')&&categoryId(row.id,true)!==id)throw new ValidateException('分类正文ID必须与路径一致');const {id:_id,...input}=row;return input;}
async function expectedRevision(c:C){noQuery(c);if(!c.req.raw.body)return undefined;const row=categoryObject(await body(c),['expected_revision']);if(row.expected_revision===undefined)return undefined;if(typeof row.expected_revision!=='string'||!/^[a-f0-9]{64}$/.test(row.expected_revision))throw new ValidateException('分类确认版本错误');return row.expected_revision;}
export async function list(c:C){const x=context(c);return jsonOk(c,await x.service.list(x.query,x.actor));}
export async function tree(c:C){const x=context(c);return jsonOk(c,await x.service.tree(c.req.param('type'),x.query,x.actor));}
export async function cascader(c:C){const x=context(c);return jsonOk(c,await x.service.cascader(c.req.param('type'),x.query,x.actor));}
export async function createForm(c:C){const x=context(c);return jsonOk(c,await x.service.form(0,x.query,x.actor));}
export async function editForm(c:C){const x=context(c);return jsonOk(c,await x.service.form(categoryId(c.req.param('id')),x.query,x.actor));}
export async function create(c:C){const x=context(c);return jsonOk(c,await x.service.save(0,legacyInput(await body(c),0),x.actor),'添加分类成功');}
export async function update(c:C){const x=context(c),id=categoryId(c.req.param('id'));return jsonOk(c,await x.service.save(id,legacyInput(await body(c),id),x.actor),'修改成功');}
export async function setShow(c:C){const x=context(c);return jsonOk(c,await x.service.setShow(categoryId(c.req.param('id')),c.req.param('is_show'),x.actor,await expectedRevision(c)),'分类状态已更新');}
export async function remove(c:C){const x=context(c);return jsonOk(c,await x.service.remove(categoryId(c.req.param('id')),x.actor,await expectedRevision(c)),'删除成功');}
export async function modernList(c:C){const x=context(c);return jsonOk(c,await x.service.modernList(x.query,x.actor));}
export async function modernSave(c:C){const x=context(c);return jsonOk(c,await x.service.modernSave(await body(c),x.actor),'保存成功');}
export const modernDelete=remove;
