import { getToken, clearAuth } from '@/utils/auth';
import request, { AdminResponseError, getData } from '@/utils/request';
export type ProfileKind='name'|'avatar'|'password'|'phone';
export interface ProfileInfo {id:number;account:string;real_name:string;head_pic:string;phone:string;revision:string;avatar_id:string|null}
export interface ProfileReceipt {operation_id:string;actor_id:number;operation:ProfileKind;state:'committed'|'not_applied'|'unknown'}
function record(value:unknown):Record<string,unknown>{if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('资料响应无效');return value as Record<string,unknown>;}
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(v);
function profileInfo(value:unknown):ProfileInfo {
 const r=record(value),string=(v:unknown,max:number)=>typeof v==='string'&&[...v].length<=max;
 if(!Number.isSafeInteger(r.id)||Number(r.id)<1||!string(r.account,32)||!string(r.real_name,16)||!string(r.head_pic,255)||!string(r.phone,32)||typeof r.revision!=='string'||!/^[a-f0-9]{64}$/.test(r.revision)
   ||r.avatar_id!==null&&(!uuid(r.avatar_id)||r.head_pic!==`/admin-profile-avatar/${r.avatar_id}`))throw new Error('资料响应无效');
 return {id:r.id as number,account:r.account as string,real_name:r.real_name as string,head_pic:r.head_pic as string,phone:r.phone as string,revision:r.revision,avatar_id:r.avatar_id as string|null};
}
function receipt(value:unknown):ProfileReceipt {
 const r=record(value);
 if(!uuid(r.operation_id)||!Number.isSafeInteger(r.actor_id)||Number(r.actor_id)<1||!['name','avatar','password','phone'].includes(String(r.operation))||!['committed','not_applied','unknown'].includes(String(r.state)))throw new Error('资料回执无效');
 return {operation_id:r.operation_id,actor_id:r.actor_id as number,operation:r.operation as ProfileKind,state:r.state as ProfileReceipt['state']};
}
export const apiProfileInfo=async(signal?:AbortSignal)=>profileInfo(await getData<unknown>(request.get('/setting/info',{signal})));
export const apiProfileCommit=async(data:{operation_id:string;operation:ProfileKind;revision:string;payload:Record<string,string>},signal?:AbortSignal)=>receipt(await getData<unknown>(request.post('/system/profile/commit',data,{signal})));
export const apiProfileReceipt=async(id:string,operation:ProfileKind,signal?:AbortSignal)=>receipt(await getData<unknown>(request.get(`/system/profile/receipt/${encodeURIComponent(id)}`,{params:{operation},signal})));
export const apiProfileResolve=async(operation_id:string,operation:ProfileKind,signal?:AbortSignal)=>receipt(await getData<unknown>(request.post('/system/profile/resolve',{operation_id,operation},{signal})));
export const apiProfileUpload=(id:string,file:File,signal?:AbortSignal)=>getData<{avatar_id:string;head_pic:string}>(request.put(`/system/profile/avatar/${encodeURIComponent(id)}`,file,{headers:{'Content-Type':file.type},signal}));
export async function apiProfileAvatar(id:string,signal?:AbortSignal):Promise<Blob> {
  const token=getToken();
  const response=await fetch(`/adminapi/system/profile/avatar/${encodeURIComponent(id)}`,{headers:{'Authori-zation':`Bearer ${token??''}`},signal,cache:'no-store'});
  if(!response.ok || response.headers.get('Content-Type')?.includes('application/json')) {
    const body=await response.json().catch(()=>({msg:'头像读取失败',status:response.status}));
    if(signal?.aborted)throw new DOMException('请求已取消','AbortError');
    if([410000,410001,410002].includes(body.status) && getToken()===token) {clearAuth();window.dispatchEvent(new Event('admin-auth-expired'));}
    throw new AdminResponseError(body.msg??'头像读取失败',body.status);
  }
  const blob=await response.blob();
  if(signal?.aborted)throw new DOMException('请求已取消','AbortError');
  if(!['image/jpeg','image/png','image/webp','image/gif'].includes(blob.type)||blob.size>2097152)throw new Error('头像内容无效');
  return blob;
}
export const apiProfileChallenge=(phone:string,signal?:AbortSignal)=>getData<{key:string;expire_time:number;site_key:string;action:string}>(request.post('/system/profile/challenge',{phone},{signal}));
export const apiProfileChallengeStatus=(key:string,signal?:AbortSignal)=>getData<{verified:boolean;expires_in:number}>(request.get('/system/profile/challenge/status',{params:{key},signal}));
export const apiProfileSend=(phone:string,key:string,signal?:AbortSignal)=>getData<{queued:true;expires_in:number}>(request.post('/system/profile/sms',{phone,key},{signal}));
