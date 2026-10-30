import type { Context } from 'hono';
import type { AppVariables, Env } from '@/env';
import type { AdminAuthorityActor } from '@/services/admin/AdminAuthorityWriteService';
import { AdminProfileService } from '@/services/admin/AdminProfileService';
import { AdminProfileSmsService } from '@/services/admin/AdminProfileSmsService';
import { ValidateException } from '@/utils/errors';
import { jsonOk } from '@/utils/json';
import { readBoundedJsonObject } from '@/utils/request-body';
type C=Context<{Bindings:Env;Variables:AppVariables}>;
function actor(c:C):AdminAuthorityActor {
  c.header('Cache-Control','private, no-store');c.header('Pragma','no-cache');
  return {id:c.get('adminId')??0,authVersion:c.get('socketAuthVersion')??'',expiresAt:c.get('socketTokenExp')??0};
}
function noQuery(c:C) {if(new URL(c.req.url).searchParams.size) throw new ValidateException('资料操作不接受查询参数');}
function fields(body:Record<string,unknown>,allowed:string[]) {if(Object.keys(body).some(k=>!allowed.includes(k))) throw new ValidateException('请求包含未知字段');}
const service=(c:C)=>new AdminProfileService(c.get('container'),c.env);
const sms=(c:C)=>new AdminProfileSmsService(c.get('container'),c.env);
const ip=(c:C)=>c.req.header('CF-Connecting-IP')??'';
export async function adminProfileInfo(c:C) {const a=actor(c);noQuery(c);return jsonOk(c,await service(c).info(a));}
export async function adminProfileCommit(c:C) {const a=actor(c);noQuery(c);return jsonOk(c,await service(c).commit(await readBoundedJsonObject(c.req.raw,4096),a));}
export async function adminProfileLegacy(c:C) {const a=actor(c);noQuery(c);return jsonOk(c,await service(c).legacy(await readBoundedJsonObject(c.req.raw,4096),a,c.req.header('X-Profile-Operation')??crypto.randomUUID()));}
export async function adminProfileReceipt(c:C) {
  const a=actor(c),q=new URL(c.req.url).searchParams;
  if(q.size!==1 || q.getAll('operation').length!==1) throw new ValidateException('回执须包含唯一操作类型');
  return jsonOk(c,await service(c).receipt(c.req.param('operationId'),q.get('operation'),a));
}
export async function adminProfileResolve(c:C) {
  const a=actor(c);noQuery(c);const body=await readBoundedJsonObject(c.req.raw,1024);fields(body,['operation_id','operation']);
  return jsonOk(c,await service(c).receipt(body.operation_id,body.operation,a,true));
}
export async function adminProfileUpload(c:C) {
  const a=actor(c);noQuery(c);const max=2097152,length=c.req.header('Content-Length');
  if(length!==undefined && (!/^\d+$/.test(length) || Number(length)>max)) throw new ValidateException('头像不能超过2 MiB');
  const reader=c.req.raw.body?.getReader();if(!reader) throw new ValidateException('请选择头像');
  const chunks:Uint8Array[]=[];let total=0;
  while(true) {const {done,value}=await reader.read();if(done)break;total+=value.byteLength;if(total>max){await reader.cancel();throw new ValidateException('头像不能超过2 MiB');}chunks.push(value);}
  const bytes=new Uint8Array(total);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
  return jsonOk(c,await service(c).upload(a,c.req.param('avatarId'),bytes,c.req.header('Content-Type')??''));
}
export async function adminProfileAvatar(c:C) {const a=actor(c);noQuery(c);return service(c).avatar(a,c.req.param('avatarId'));}
export async function adminProfileChallenge(c:C) {
  const a=actor(c);noQuery(c);const body=await readBoundedJsonObject(c.req.raw,1024);fields(body,['phone']);
  return jsonOk(c,await sms(c).createChallenge(a,body.phone,ip(c)));
}
export async function adminProfileChallengeStatus(c:C) {
  const a=actor(c),q=new URL(c.req.url).searchParams;
  if(q.size!==1 || q.getAll('key').length!==1)throw new ValidateException('挑战须包含唯一标识');
  return jsonOk(c,await sms(c).challengeStatus(a,q.get('key'),ip(c)));
}
export async function adminProfileSend(c:C) {
  const a=actor(c);noQuery(c);const body=await readBoundedJsonObject(c.req.raw,1024);fields(body,['phone','key']);
  return jsonOk(c,await sms(c).requestCode(a,body.phone,body.key,ip(c)),'验证码任务已提交，请等待短信');
}
export async function adminProfileChallengeComplete(c:C) {
  c.header('Cache-Control','no-store');noQuery(c);const body=await readBoundedJsonObject(c.req.raw,4096);fields(body,['key','token']);
  return jsonOk(c,await sms(c).completeChallenge(body.key,body.token,ip(c)));
}
export async function adminProfileChallengeHost(c:C) {
  const q=new URL(c.req.url).searchParams;if(q.size!==1 || q.getAll('key').length!==1)throw new ValidateException('挑战标识无效');
  const {key,siteKey,action}=await sms(c).challengePage(q.get('key')),nonce=crypto.randomUUID().replaceAll('-','');
  const literal=(v:string)=>JSON.stringify(v).replaceAll('<','\\u003c');
  const html=`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>手机人机验证</title><body><div id="widget"></div><p id="status" role="status">正在加载验证…</p><script nonce="${nonce}">window.ready=()=>{turnstile.render('#widget',{sitekey:${literal(siteKey)},action:${literal(action)},cData:${literal(key)},callback:async token=>{let status=document.getElementById('status');try{let r=await fetch('/api/admin-profile/challenge/complete',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({key:${literal(key)},token})});let b=await r.json();if(!r.ok||b.status!==200)throw Error();status.textContent='验证完成，请返回填写验证码';parent.postMessage({type:'cinashop:admin-profile-challenge',key:${literal(key)}},location.origin);}catch{status.textContent='验证失败，请关闭后重试';turnstile.reset();}}});};</script><script nonce="${nonce}" src="https://challenges.cloudflare.com/turnstile/v0/api.js?onload=ready&amp;render=explicit" defer></script></body></html>`;
  return new Response(html,{headers:{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','Referrer-Policy':'no-referrer',
    'X-Content-Type-Options':'nosniff','Content-Security-Policy':`default-src 'none'; script-src 'nonce-${nonce}' https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com; connect-src 'self' https://challenges.cloudflare.com; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'`}});
}
