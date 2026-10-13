import type { Context } from 'hono';
import type { Env, AppVariables } from '@/env';
import { jsonOk } from '@/utils/json';
import { ValidateException } from '@/utils/errors';
import { readBoundedUtf8Text } from '@/utils/request-body';
import { CustomerCashierFormImages } from '@/services/customer-work/CustomerCashierFormImages';
import { customerWorkActor } from './CustomerWorkController';
type C = Context<{Bindings:Env;Variables:AppVariables}>;
function input(c:C) {
  c.header('Cache-Control','private, no-store');c.header('Pragma','no-cache');
  if(new URL(c.req.url).search)throw new ValidateException('收银图片不接受查询身份或参数');
  return {actor:customerWorkActor(c),service:new CustomerCashierFormImages(c.get('container'),c.env)};
}
async function json(c:C):Promise<unknown> {
  if(!/^application\/json(?:\s*;\s*charset\s*=\s*utf-8)?$/i.test(c.req.header('Content-Type')??'')
    ||!['','identity'].includes((c.req.header('Content-Encoding')??'').toLowerCase()))throw new ValidateException('收银图片仅接受 UTF-8 JSON');
  try{return JSON.parse(await readBoundedUtf8Text(c.req.raw,262144));}catch(error){if(error instanceof ValidateException)throw error;throw new ValidateException('收银图片 JSON 无效');}
}
async function multipart(c:C):Promise<{file:File;metadata:unknown}> {
  const type=c.req.header('Content-Type')??'',max=10485760+262144,declared=c.req.header('Content-Length');
  if(!/^multipart\/form-data\s*;/i.test(type)||!['','identity'].includes((c.req.header('Content-Encoding')??'').toLowerCase()))throw new ValidateException('收银图片必须使用原 multipart 文件');
  if(declared!==undefined&&(!/^[1-9]\d*$/.test(declared)||Number(declared)>max))throw new ValidateException('收银图片请求超过容量');
  if(!c.req.raw.body)throw new ValidateException('图片文件缺失');const reader=c.req.raw.body.getReader(),chunks:Uint8Array[]=[];let total=0;
  while(true){const {done,value}=await reader.read();if(done)break;total+=value.byteLength;if(total>max){await reader.cancel();throw new ValidateException('收银图片请求超过容量');}chunks.push(value);}
  const bytes=new Uint8Array(total);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
  let form:FormData;try{form=await new Response(bytes,{headers:{'Content-Type':type}}).formData();}catch{throw new ValidateException('图片 multipart 无效');}
  if([...form.keys()].sort().join('|')!=='file|metadata'||form.getAll('file').length!==1||form.getAll('metadata').length!==1)throw new ValidateException('图片仅接受一个 file 和一个 metadata');
  const file=form.get('file'),metadata=form.get('metadata');if(!(file instanceof File)||file.size<=0||file.size>10485760||typeof metadata!=='string'||new TextEncoder().encode(metadata).byteLength>65536)throw new ValidateException('图片文件或 metadata 无效');
  try{return {file,metadata:JSON.parse(metadata)};}catch{throw new ValidateException('图片 metadata JSON 无效');}
}
export async function formSessionCreate(c:C){const s=input(c);return jsonOk(c,await s.service.createSession(s.actor,c.req.header('Idempotency-Key')??'',await json(c)));}
export async function formSessionRead(c:C){const s=input(c);return jsonOk(c,await s.service.getSession(s.actor,c.req.param('key')));}
export async function formSessionCancel(c:C){const s=input(c);return jsonOk(c,await s.service.cancel(s.actor,c.req.param('key'),c.req.header('Idempotency-Key')??'',await json(c)));}
export async function formImageUpload(c:C){const s=input(c);await s.service.authorizeUpload(s.actor,c.req.param('key'));const body=await multipart(c);
  return jsonOk(c,await s.service.upload(s.actor,c.req.param('key'),c.req.header('Idempotency-Key')??'',body.metadata,body.file));}
export async function formImageRead(c:C){const s=input(c);return jsonOk(c,await s.service.getImage(s.actor,c.req.param('key')));}
export async function formSessionPreviews(c:C){const s=input(c);if(c.req.header('Idempotency-Key')!==undefined)throw new ValidateException('图片预览不接受操作 UUID');
  return jsonOk(c,await s.service.previews(s.actor,c.req.param('key'),await json(c)));}
