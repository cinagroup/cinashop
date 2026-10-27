import { createUserCenterRequests } from '@/api/userCenter';
import { memberLevelImage } from '@/api/memberLevels';
import { API_BASE, getFormType, RequestError } from '@/utils/request';

export type ProfileFormat = 'text'|'num'|'date'|'radio'|'id'|'mail'|'phone'|'address';
export interface ProfileField { info:string; tip:string; format:ProfileFormat; label:string; param:string; single:string;
  singlearr:string[]; required:0|1; use:0|1; user_show:0|1; sort:number; value:string }
export interface CustomerProfile { actor_uid:number; revision:string; version:string; profile:{uid:number; account:string; nickname:string;
  avatar:string; avatar_preview:string; phone:string; register_extend_info:ProfileField[]; extend_info:unknown[]} }
export interface ProfileDraft { nickname:string; avatar:string; fields:Record<string,string> }
export interface ProfileSave { profile:1; revision:string; version:string; nickname:string; avatar:string; extend_info:Array<{info:string;value:string}> }
const invalid = ():never=>{throw Error('个人资料响应不完整，请重新读取');};
const object=(v:unknown):Record<string,unknown>=>v&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:invalid();
const text=(v:unknown,max=4096):v is string=>typeof v==='string'&&[...v].length<=max&&!/[\u0000-\u001f\u007f]/u.test(v)
  &&![...v].some(c=>{const n=c.codePointAt(0)!;return n>=0xd800&&n<=0xdfff;});
const integer=(v:unknown,min=0,max=2147483647):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=min&&v<=max;
const bit=(v:unknown):v is 0|1=>v===0||v===1;
const hash=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/u.test(v);
export function profileAvatarPreview(reference:string,preview:string,now=Date.now()):string {
  if (!text(reference,256)||!text(preview,8192)||!reference||!preview) return '';
  if (/^\/api\/assets\/[1-9]\d{0,9}$/u.test(reference)) {
    if (!preview.startsWith(reference+'?')||preview.startsWith('//')) return '';
    try {const u=new URL(preview,'https://profile-image.invalid');if(u.origin!=='https://profile-image.invalid'||u.pathname!==reference||u.hash
      ||[...u.searchParams.keys()].length!==2||u.searchParams.getAll('expires').length!==1||u.searchParams.getAll('signature').length!==1
      ||! /^[1-9]\d{0,11}$/u.test(u.searchParams.get('expires')??'')||! /^[A-Za-z0-9_-]{43}$/u.test(u.searchParams.get('signature')??'')
      ||Number(u.searchParams.get('expires'))*1000<=now)return '';}catch{return '';}
  } else if(reference!==preview)return '';
  return memberLevelImage(preview);
}
export function profileAvatarExpiry(reference:string,preview:string):number|null {
  if(!/^\/api\/assets\/[1-9]\d{0,9}$/u.test(reference))return null;
  if(!profileAvatarPreview(reference,preview))return Date.now();
  return Number(new URL(preview,'https://profile-image.invalid').searchParams.get('expires'))*1000;
}
export function decodeCustomerProfile(value:unknown,owner:number):CustomerProfile {
  const v=object(value),p=object(v.profile);
  if(v.actor_uid!==owner||p.uid!==owner||!integer(owner,1)||!hash(v.revision)||!hash(v.version)||!text(p.account,255)
    ||!text(p.nickname,255)||!text(p.avatar,256)||!text(p.avatar_preview,8192)||!text(p.phone,64)
    ||!Array.isArray(p.register_extend_info)||p.register_extend_info.length>64||!Array.isArray(p.extend_info))return invalid();
  const names=new Set<string>(),params=new Set<string>(),formats:ProfileFormat[]=['text','num','date','radio','id','mail','phone','address'];
  const fields=p.register_extend_info.map(value=>{const f=object(value);
    if(!text(f.info,255)||!f.info||names.has(f.info)||!text(f.tip,255)||!text(f.label,255)||!formats.includes(f.format as ProfileFormat)
      ||!text(f.param,32)||!['','real_name','sex','birthday','card_id','address','mark'].includes(f.param)
      ||f.param!==''&&params.has(f.param)||f.single!==''||!bit(f.required)||f.use!==1||f.user_show!==1||!integer(f.sort)
      ||!text(f.value,4096)||!Array.isArray(f.singlearr)||f.singlearr.length>32||f.singlearr.some(v=>!text(v,255)))return invalid();
    const options=f.singlearr as string[];
    if(new Set(options).size!==options.length||(f.format==='radio'?options.length<2:options.length!==0))return invalid();
    names.add(f.info);if(f.param)params.add(f.param);
    return {info:f.info,tip:f.tip,format:f.format as ProfileFormat,label:f.label,param:f.param,single:'',singlearr:options,
      required:f.required,use:1 as const,user_show:1 as const,sort:f.sort,value:f.value};
  });
  return {actor_uid:owner,revision:v.revision,version:v.version,profile:{uid:owner,account:p.account,nickname:p.nickname,
    avatar:p.avatar,avatar_preview:p.avatar_preview,phone:p.phone,register_extend_info:fields,extend_info:p.extend_info}};
}
export function profileDraft(data:CustomerProfile):ProfileDraft {return{nickname:data.profile.nickname,avatar:data.profile.avatar,
  fields:Object.fromEntries(data.profile.register_extend_info.map(f=>[f.info,f.value]))};}
export function encodeProfileSave(data:CustomerProfile,draft:ProfileDraft):ProfileSave {
  const unchangedNickname=draft.nickname===data.profile.nickname,nickname=unchangedNickname?draft.nickname:draft.nickname.trim();if(!text(nickname,unchangedNickname?255:16)||!nickname.trim())throw Error('请填写最多16字的昵称');
  if(!text(draft.avatar,256)||!draft.avatar&&draft.avatar!==data.profile.avatar)throw Error('请选择有效头像');
  const names=data.profile.register_extend_info.map(f=>f.info);
  if(Object.keys(draft.fields).length!==names.length||Object.keys(draft.fields).some(key=>!names.includes(key)))throw Error('资料模板已变化，请重新读取');
  const extend_info=data.profile.register_extend_info.map(f=>{
    const value=draft.fields[f.info];if(!text(value,value===f.value?4096:1024))throw Error(`${f.info}格式无效或超过1024字`);
    if(f.required&&!value.trim())throw Error(f.tip||`请填写${f.info}`);
    if(value!==f.value&&value!==''&&f.format==='num'&&(!/^\d+(?:\.\d+)?$/u.test(value)||!Number.isFinite(Number(value))||Number(value)<=0))throw Error(`${f.info}须为正数`);
    if(value!==f.value&&value!==''&&f.format==='radio'&&(!/^(?:0|[1-9]\d*)$/u.test(value)||Number(value)>=f.singlearr.length))throw Error(`请选择${f.info}`);
    if(value!==f.value&&value!==''&&f.format==='date'){const m=/^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);if(!m)throw Error(`请选择有效的${f.info}`);const d=new Date(value+'T00:00:00Z');if(!Number.isFinite(d.getTime())||d.toISOString().slice(0,10)!==value)throw Error(`请选择有效的${f.info}`);}
    return{info:f.info,value};
  });
  return{profile:1,revision:data.revision,version:data.version,nickname,avatar:draft.avatar,extend_info};
}
export function createCustomerProfileRequests(current:()=>boolean) {
  const scope=createUserCenterRequests(current),uploads=new Set<()=>void>();
  function abort(){scope.abort();for(const cancel of [...uploads])cancel();uploads.clear();}
  function upload(path:string):Promise<{url:string;src:string}> {
    if(!scope.active()||!scope.owner.uid||!scope.owner.token)return Promise.reject(new RequestError('请先登录'));
    return new Promise((resolve,reject)=>{
      let done=false,task:UniApp.UploadTask|undefined,timer:ReturnType<typeof setTimeout>|undefined;
      const finish=(value?:{url:string;src:string},error?:Error)=>{if(done)return;done=true;clearTimeout(timer);uploads.delete(cancel);if(error)reject(error);else resolve(value!);};
      const cancel=()=>{finish(undefined,new RequestError('页面或登录状态已变化'));task?.abort();};uploads.add(cancel);
      timer=setTimeout(()=>{finish(undefined,new RequestError('头像上传超时，结果未确认'));task?.abort();},60_000);
      task=uni.uploadFile({url:`${API_BASE}/api/upload/image`,filePath:path,name:'file',formData:{pid:'0'},timeout:60_000,
        header:{'Authori-zation':`Bearer ${scope.owner.token}`,'Form-type':getFormType()},
        success:res=>{if(done)return;if(!scope.active()){cancel();return;}try{
          if(typeof res.data!=='string'||res.data.length>16384)throw new RequestError('头像上传回执无效');const body=JSON.parse(res.data),v=body?.data;
          if(res.statusCode<200||res.statusCode>=300||body?.status!==200)throw new RequestError(typeof body?.msg==='string'?body.msg:'头像上传失败',typeof body?.status==='number'?body.status:undefined);
          if(!v||typeof v.url!=='string'||!/^\/api\/assets\/[1-9]\d{0,9}$/u.test(v.url)||Number(v.url.split('/').at(-1))>2147483647
            ||typeof v.src!=='string'||!profileAvatarPreview(v.url,v.src))throw new RequestError('头像上传回执无效');finish({url:v.url,src:v.src});
        }catch(error){finish(undefined,error instanceof Error?error:new RequestError('头像上传回执无效'));}},
        fail:res=>{if(done)return;if(!scope.active()){cancel();return;}finish(undefined,new RequestError(res.errMsg||'头像上传未确认'));},
      });
    });
  }
  return {...scope,abort,upload,info:async()=>decodeCustomerProfile(await scope.request('user/info','GET',{profile:1},true),scope.owner.uid),
    save:async(input:ProfileSave)=>{const value=await scope.request('user/edit','POST',input as unknown as Record<string,unknown>,true);if(value!==null)throw new RequestError('资料保存回执无效');}};
}
export type CustomerProfileRequests=ReturnType<typeof createCustomerProfileRequests>;
