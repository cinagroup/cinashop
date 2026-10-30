import type {Context} from 'hono';
import type {AppVariables,Env} from '@/env';
import {jsonOk} from '@/utils/json';
import {readBoundedJsonObject} from '@/utils/request-body';
import {AdminPlatformMenuService,PlatformMenuNotApplied} from '@/services/admin/AdminPlatformMenuService';
import {menuQuery,type PlatformMenuOperation} from '@/services/admin/AdminPlatformMenuInput';
type C=Context<{Bindings:Env;Variables:AppVariables}>;
function context(c:C){c.header('Cache-Control','private, no-store');c.header('Pragma','no-cache');return {s:new AdminPlatformMenuService(c.get('container')),a:{id:c.get('adminId')??0,authVersion:c.get('socketAuthVersion')??'',expiresAt:c.get('socketTokenExp')??0},q:new URL(c.req.url).searchParams};}
export const catalog=(c:C)=>{const x=context(c);return x.s.catalog(x.q,x.a).then(r=>jsonOk(c,r));};
export const list=(c:C)=>{const x=context(c);return x.s.list(x.q,x.a).then(r=>jsonOk(c,r));};
export const detail=(c:C)=>{const x=context(c);return x.s.detail(c.req.param('id'),x.q,x.a).then(r=>jsonOk(c,r));};
export const createForm=(c:C)=>{const x=context(c);return x.s.form(0,x.q,x.a).then(r=>jsonOk(c,r));};
export const editForm=(c:C)=>{const x=context(c);return x.s.form(c.req.param('id'),x.q,x.a).then(r=>jsonOk(c,r));};
export const ruleList=(c:C)=>{const x=context(c);return x.s.catalog(x.q,x.a).then(r=>jsonOk(c,r.apis));};
export const receipt=(c:C)=>{const x=context(c);return x.s.receipt(c.req.param('requestId'),x.q,x.a).then(r=>jsonOk(c,r));};
async function write(c:C,op:PlatformMenuOperation){const x=context(c);menuQuery(x.q,[]);try{const input=await readBoundedJsonObject(c.req.raw,16384),modern=Object.hasOwn(input,'request_id'),id=op==='create'?0:c.req.param('id');const result=modern?await x.s.mutate(op,id,input,x.a):await x.s.legacy(op,id,input,x.a);return jsonOk(c,modern?result:op==='create'||op==='update'?{id:result.id}:null,'权限规则操作成功');}catch(e){if(e instanceof PlatformMenuNotApplied)return c.json({status:e.httpStatus,msg:e.message,data:e.proof},e.httpStatus);throw e;}}
export const create=(c:C)=>write(c,'create');
export const update=(c:C)=>write(c,'update');
export const show=(c:C)=>write(c,'show');
export const remove=(c:C)=>write(c,'delete');
