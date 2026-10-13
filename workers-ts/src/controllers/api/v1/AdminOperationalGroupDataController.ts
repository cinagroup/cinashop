import type {Context} from 'hono';
import type {AppVariables,Env} from '@/env';
import {jsonOk} from '@/utils/json';
import {ValidateException} from '@/utils/errors';
import {readBoundedUtf8Text} from '@/utils/request-body';
import {AdminOperationalGroupDataService} from '@/services/admin/AdminOperationalGroupDataService';
import {operationalInteger,operationalJson,operationalObject,type OperationalActor,type OperationalOperation} from '@/services/admin/AdminOperationalGroupDataInput';
type C=Context<{Bindings:Env;Variables:AppVariables}>;
function context(c:C){c.header('Cache-Control','private, no-store');c.header('Pragma','no-cache');return {service:new AdminOperationalGroupDataService(c.get('container'),c.env.APP_KEY),actor:{id:c.get('adminId')??0,authVersion:c.get('socketAuthVersion')??'',expiresAt:c.get('socketTokenExp')??0} satisfies OperationalActor,query:new URL(c.req.url).searchParams};}
async function body(c:C){if(new URL(c.req.url).searchParams.size)throw new ValidateException('运营图片写入不接受查询参数');if(!c.req.raw.body)return {};return operationalJson(await readBoundedUtf8Text(c.req.raw,256*1024));}
export async function options(c:C){const x=context(c);if(x.query.size)throw new ValidateException('运营图片组选项不接受查询参数');return jsonOk(c,await x.service.options(x.actor));}
export async function header(c:C){const x=context(c);return jsonOk(c,await x.service.header(x.query,x.actor));}
export async function list(c:C){const x=context(c);return jsonOk(c,await x.service.list(x.query,x.actor));}
export async function createForm(c:C){const x=context(c);return jsonOk(c,await x.service.form(0,x.query,x.actor));}
export async function editForm(c:C){const x=context(c);return jsonOk(c,await x.service.form(operationalInteger(c.req.param('id')),x.query,x.actor));}
export async function detail(c:C){const x=context(c);return jsonOk(c,await x.service.detail(operationalInteger(c.req.param('id')),x.query,x.actor));}
export async function receipt(c:C){const x=context(c);if(x.query.size)throw new ValidateException('回执读取不接受查询参数');return jsonOk(c,await x.service.receipt(c.req.param('configName'),c.req.param('requestId'),x.actor));}
async function write(c:C,operation:OperationalOperation){const x=context(c),input=operationalObject(await body(c));if(operation==='status'){if(input.status!==undefined&&operationalInteger(input.status,0,1)!==operationalInteger(c.req.param('status'),0,1))throw new ValidateException('正文显示状态与路径不一致');input.status=operationalInteger(c.req.param('status'),0,1);}const result=await x.service.mutate(operation,c.req.param('id'),input,x.actor);return jsonOk(c,result,operation==='delete'?'删除成功!':operation==='update'?'修改成功!':operation==='status'?(input.status===0?'隐藏成功':'显示成功'):'添加数据成功!');}
export const create=(c:C)=>write(c,'create');
export const update=(c:C)=>write(c,'update');
export const remove=(c:C)=>write(c,'delete');
export const setStatus=(c:C)=>write(c,'status');
export const saveAll=(c:C)=>write(c,'replace');
