import { and, eq } from 'drizzle-orm';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import bcrypt from 'bcryptjs';
import type { Env } from '@/env';
import { withTx, type Container, type DbClient } from '@/lib/di';
import { systemAdmin } from '@/models/schema';
import { adminProfileAvatar, adminProfileOperation } from '@/models/schema/adminProfile';
import { ApiErrorCode, AuthException, HttpApiException, ServiceUnavailableException, ValidateException } from '@/utils/errors';
import { md5 } from '@/utils/jwt';
import { assertAdminProfileReady } from '@/migrations/adminProfile';
import { detectImageType } from '@/services/system/AttachmentService';
import { acquireAdminAuthorityWriteBarrier, adminAuthorityWriteError, assertAdminAuthoritySession, type AdminAuthorityActor } from './AdminAuthorityWriteService';
import { AdminProfileSmsService } from './AdminProfileSmsService';

export type AdminProfileKind = 'name' | 'avatar' | 'password' | 'phone';
export type AdminProfileInput = { operation_id:string; revision:string; operation:AdminProfileKind; payload:Record<string,string> };
export interface AdminProfileReceipt { operation_id:string; actor_id:number; operation:AdminProfileKind; state:'committed'|'not_applied'|'unknown' }
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const SHA = /^[a-f0-9]{64}$/;
const conflict = (msg:string) => new HttpApiException(msg,409,409);
export function profileId(value:unknown):string {
  if (typeof value!=='string' || !UUID.test(value)) throw new ValidateException('操作标识须为小写UUIDv4');
  return value;
}
export function profileKind(value:unknown):AdminProfileKind {
  if (value!=='name' && value!=='avatar' && value!=='password' && value!=='phone') throw new ValidateException('资料操作类型错误');
  return value;
}
function object(value:unknown):Record<string,unknown> {
  if (!value || typeof value!=='object' || Array.isArray(value)) throw new ValidateException('请求须为对象');
  return value as Record<string,unknown>;
}
function only(row:Record<string,unknown>,fields:readonly string[]) {
  if (Object.keys(row).some(k=>!fields.includes(k))) throw new ValidateException('请求包含未知字段');
}
function text(v:unknown,max:number,label:string):string {
  if (typeof v!=='string' || !v || [...v].length>max || /[\u0000-\u001f\u007f]/u.test(v)) throw new ValidateException(`${label}无效`);
  return v;
}
export function normalizeProfileInput(value:unknown):AdminProfileInput {
  const row=object(value); only(row,['operation_id','revision','operation','payload']);
  const operation=profileKind(row.operation),payload=object(row.payload);
  const fields=operation==='name'?['real_name']:operation==='avatar'?['head_pic']:operation==='password'?['pwd','new_pwd','conf_pwd']:['phone','code'];
  only(payload,fields);
  if (Object.keys(payload).length!==fields.length) throw new ValidateException('资料字段不完整');
  const out:Record<string,string>={};
  for (const field of fields) {
    if (operation==='password' && field==='pwd') {
      // Match the current login contract exactly; historical passwords are
      // neither trimmed nor subjected to the new-password character policy.
      const old=payload.pwd;
      if(typeof old!=='string' || !old || old.length>256) throw new ValidateException('原密码无效');
      out.pwd=old;
    } else out[field]=text(payload[field],field==='real_name'?16:field==='head_pic'?100:field==='phone'?11:field==='code'?6:200,field);
  }
  if (operation==='name' && out.real_name!==out.real_name.trim()) throw new ValidateException('姓名不能带首尾空白');
  if (operation==='avatar' && !/^\/admin-profile-avatar\/[a-f0-9-]{36}$/.test(out.head_pic)) throw new ValidateException('请选择本人上传的头像');
  if (operation==='avatar') profileId(out.head_pic.split('/').at(-1));
  if (operation==='phone' && (!/^1[3-9]\d{9}$/.test(out.phone) || !/^\d{6}$/.test(out.code))) throw new ValidateException('手机号或验证码无效');
  // Historical old passwords remain valid; this policy applies only to the new value.
  if (operation==='password' && ([...out.new_pwd].length<12 || new TextEncoder().encode(out.new_pwd).length>72 || out.new_pwd!==out.conf_pwd))
    throw new ValidateException('新密码须至少12字符、最多72字节，且两次一致');
  if (typeof row.revision!=='string' || !SHA.test(row.revision)) throw new ValidateException('请重新读取当前资料');
  return {operation_id:profileId(row.operation_id),revision:row.revision,operation,payload:out};
}
/** Seven-field PHP priority is preserved; identity/role fields are never writable. */
export function legacyProfilePayload(value:unknown):{operation:AdminProfileKind;payload:Record<string,string>} {
  const row=object(value);only(row,['real_name','head_pic','pwd','new_pwd','conf_pwd','phone','code']);
  for (const value of Object.values(row)) if (typeof value!=='string') throw new ValidateException('旧资料字段须为字符串');
  if (row.head_pic) return {operation:'avatar',payload:{head_pic:row.head_pic as string}};
  if (row.real_name) return {operation:'name',payload:{real_name:row.real_name as string}};
  if (row.pwd) return {operation:'password',payload:{pwd:row.pwd as string,new_pwd:row.new_pwd as string,conf_pwd:row.conf_pwd as string}};
  if (row.phone) return {operation:'phone',payload:{phone:row.phone as string,code:row.code as string}};
  throw new ValidateException('请选择要修改的资料');
}
export async function loadAdminProfileActor(tx:DbClient,actor:AdminAuthorityActor) {
  assertAdminAuthoritySession(actor);
  const [live]=await tx.select().from(systemAdmin).where(eq(systemAdmin.id,actor.id)).limit(1);
  if (!live || live.adminType!==1 || live.relationId!==0 || live.status!==1 || live.isDel!==0) throw new AuthException('管理员身份已变化',ApiErrorCode.ERR_BANNED);
  const auth=md5(live.pwd);
  if (!timingSafeEqual(new TextEncoder().encode(auth),new TextEncoder().encode(actor.authVersion))) throw new AuthException('登录凭据已变化',ApiErrorCode.ERR_EXPIRED);
  return live;
}
export class AdminProfileService {
  constructor(private readonly container:Container,private readonly env:Env) {}
  private digest(domain:string,value:unknown) {
    if (!this.env.APP_KEY) throw new ServiceUnavailableException('资料签名尚未配置');
    return createHmac('sha256',this.env.APP_KEY).update(`cinashop.profile.${domain}.v1\0${JSON.stringify(value)}`).digest('hex');
  }
  private revision(row:typeof systemAdmin.$inferSelect,actor:AdminAuthorityActor) {
    return this.digest('revision',[actor.id,actor.authVersion,actor.expiresAt,row.headPic,row.realName,row.phone]);
  }
  private async transaction<T>(actor:AdminAuthorityActor,fn:(tx:DbClient,live:typeof systemAdmin.$inferSelect)=>Promise<T>) {
    assertAdminAuthoritySession(actor);
    try {return await withTx(this.container,async tx=>{
      await acquireAdminAuthorityWriteBarrier(tx);
      const live=await loadAdminProfileActor(tx,actor),result=await fn(tx,live);
      assertAdminAuthoritySession(actor);return result;
    });} catch(e) {return adminAuthorityWriteError(e);}
  }
  async info(actor:AdminAuthorityActor) {
    return this.transaction(actor,async (_tx,row)=>({id:row.id,account:row.account,real_name:row.realName,head_pic:row.headPic,
      phone:row.phone,revision:this.revision(row,actor),avatar_id:(()=>{const id=/^\/admin-profile-avatar\/(.+)$/.exec(row.headPic)?.[1];return id&&UUID.test(id)?id:null;})()}));
  }
  private async prior(tx:DbClient,id:string,actor:AdminAuthorityActor,kind:AdminProfileKind) {
    const [row]=await tx.select().from(adminProfileOperation).where(eq(adminProfileOperation.operationId,id)).limit(1);
    if (row && row.actorId!==actor.id) throw new AuthException('无权读取该资料回执',ApiErrorCode.ERR_AUTH);
    if (row && row.operation!==kind) throw conflict('操作标识已用于其他资料操作');
    return row;
  }
  async commit(value:unknown,actor:AdminAuthorityActor):Promise<AdminProfileReceipt> {
    const input=normalizeProfileInput(value),hash=this.digest('request',[actor.id,input.operation_id,input.operation,input.revision,input.payload]);
    return this.transaction(actor,async(tx,live)=>{
      await assertAdminProfileReady(tx);
      const prior=await this.prior(tx,input.operation_id,actor,input.operation);
      if(prior) {
        if(prior.state!=='committed' || prior.requestHash!==hash) throw conflict('操作标识已封存或请求已变化，请查询原结果');
        return {operation_id:prior.operationId,actor_id:actor.id,operation:input.operation,state:'committed'};
      }
      if(input.revision!==this.revision(live,actor)) throw conflict('资料已变化，请重新读取后再提交');
      const changes:Partial<typeof systemAdmin.$inferInsert>={};
      if(input.operation==='name') changes.realName=input.payload.real_name;
      if(input.operation==='avatar') {
        const id=profileId(input.payload.head_pic.split('/').at(-1));
        await this.ownedAvatar(tx,actor,id);changes.headPic=input.payload.head_pic;
      }
      if(input.operation==='password') {
        if(!await bcrypt.compare(input.payload.pwd,live.pwd)) throw new ValidateException('原密码错误');
        changes.pwd=await bcrypt.hash(input.payload.new_pwd,12);
      }
      if(input.operation==='phone') changes.phone=await new AdminProfileSmsService(this.container,this.env)
        .consumeCode(actor,input.payload.phone,input.payload.code,tx);
      assertAdminAuthoritySession(actor);
      const [saved]=await tx.update(systemAdmin).set(changes).where(and(eq(systemAdmin.id,actor.id),eq(systemAdmin.pwd,live.pwd))).returning();
      if(!saved) throw conflict('资料身份已变化');
      for(const key of Object.keys(changes) as Array<keyof typeof changes>) if(saved[key]!==changes[key]) throw conflict('资料保存回读不一致');
      await tx.insert(adminProfileOperation).values({operationId:input.operation_id,actorId:actor.id,operation:input.operation,
        requestHash:hash,state:'committed',createdAt:Math.floor(Date.now()/1000)});
      // Business update and immutable owner receipt commit in this same PG transaction.
      return {operation_id:input.operation_id,actor_id:actor.id,operation:input.operation,state:'committed'};
    });
  }
  async legacy(value:unknown,actor:AdminAuthorityActor,operationId:string) {
    const action=legacyProfilePayload(value),info=await this.info(actor);
    return this.commit({operation_id:profileId(operationId),revision:info.revision,...action},actor);
  }
  async receipt(id:unknown,kind:unknown,actor:AdminAuthorityActor,seal=false):Promise<AdminProfileReceipt> {
    const operationId=profileId(id),operation=profileKind(kind);
    return this.transaction(actor,async tx=>{
      await assertAdminProfileReady(tx);
      const prior=await this.prior(tx,operationId,actor,operation);
      if(prior) return {operation_id:operationId,actor_id:actor.id,operation,state:prior.state as 'committed'|'not_applied'};
      if(seal) await tx.insert(adminProfileOperation).values({operationId,actorId:actor.id,operation,requestHash:'',state:'not_applied',createdAt:Math.floor(Date.now()/1000)});
      return {operation_id:operationId,actor_id:actor.id,operation,state:seal?'not_applied':'unknown'};
    });
  }
  private async ownedAvatar(tx:DbClient,actor:AdminAuthorityActor,id:string) {
    await assertAdminProfileReady(tx);
    const [row]=await tx.select().from(adminProfileAvatar).where(and(eq(adminProfileAvatar.avatarId,id),eq(adminProfileAvatar.actorId,actor.id))).limit(1);
    if(!row || row.objectKey!==`admin-profile/${actor.id}/${id}` || !SHA.test(row.sha256) || row.size<1 || row.size>2097152
      || !['image/jpeg','image/png','image/webp','image/gif'].includes(row.mime)) throw new ValidateException('头像不属于当前管理员');
    return row;
  }
  async upload(actor:AdminAuthorityActor,idValue:unknown,bytes:Uint8Array,mime:string) {
    const id=profileId(idValue),detected=detectImageType(bytes);
    if(!bytes.length || bytes.length>2097152 || !detected || detected.mime!==mime) throw new ValidateException('头像须为2 MiB内的JPEG、PNG、WebP或GIF图片');
    const sha=createHash('sha256').update(bytes).digest('hex'),key=`admin-profile/${actor.id}/${id}`;
    return this.transaction(actor,async tx=>{
      await assertAdminProfileReady(tx);
      const [prior]=await tx.select().from(adminProfileAvatar).where(eq(adminProfileAvatar.avatarId,id)).limit(1);
      if(prior) {
        const owned=await this.ownedAvatar(tx,actor,id);
        if(owned.sha256!==sha || owned.mime!==mime || owned.size!==bytes.length) throw conflict('上传标识已用于其他图片');
      } else {
        if(!this.env.ASSETS_BUCKET) throw new ServiceUnavailableException('头像存储尚未配置');
        const stored=await this.env.ASSETS_BUCKET.put(key,bytes,{httpMetadata:{contentType:mime},onlyIf:{etagDoesNotMatch:'*'}});
        if(!stored) throw conflict('头像对象已存在，请使用新的上传标识');
        // Never delete on an unknown DB commit: that might erase a committed avatar.
        await loadAdminProfileActor(tx,actor);
        await tx.insert(adminProfileAvatar).values({avatarId:id,actorId:actor.id,objectKey:key,sha256:sha,mime,size:bytes.length,createdAt:Math.floor(Date.now()/1000)});
      }
      return {avatar_id:id,head_pic:`/admin-profile-avatar/${id}`};
    });
  }
  async avatar(actor:AdminAuthorityActor,idValue:unknown) {
    const id=profileId(idValue),row=await this.transaction(actor,async tx=>this.ownedAvatar(tx,actor,id));
    const object=await this.env.ASSETS_BUCKET.get(row.objectKey);
    if(!object || object.size!==row.size || object.httpMetadata?.contentType!==row.mime) throw new ServiceUnavailableException('头像文件不可用');
    // Recheck after external I/O before releasing private image bytes.
    await this.transaction(actor,async()=>undefined);
    return new Response(object.body,{headers:{'Content-Type':row.mime,'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'; sandbox"}});
  }
}
