import { desc,eq } from 'drizzle-orm';
import { withTx,type Container,type DbClient } from '@/lib/di';
import { systemAdmin,systemLog } from '@/models/schema';
import { erpAuthState,erpConnection,erpCredential,type ErpShopBinding } from '@/models/erp';
import { acquireAdminAuthorityWriteBarrier,assertAdminAuthoritySession,loadAdminAuthorityLiveActor,type AdminAuthorityActor } from '@/services/admin/AdminAuthorityWriteService';
import { BadRequestException,ForbiddenException,ServiceUnavailableException } from '@/utils/errors';
import { erpId,erpInteger,erpObject,erpOnly,erpText } from './ErpInput';
import { erpCapabilityHash,erpCanonical,erpEqualHash,erpEqualSign,erpOrderedQuery,erpPopSign,erpRandomToken,erpSha256 } from './ErpProtocol';
import { ErpProviderClient } from './ErpProviderPolicy';
import { ErpSecretCodec } from './ErpSecretCodec';
import { assertErpBindings,assertErpStateReady,erpCallbackOrigin,erpConflict,erpCredentialAad,erpDeadlines,erpPrivateCapabilityUrl,
  lockErpConfig,lockErpScope,readErpConfig,readErpConnection,validateErpConnection,type ErpConnectionRow,type ErpCredentialRow,type ErpEnv } from './ErpConnectionPolicy';

export const ERP_CONNECTION_VIEW='erp.connection.view',ERP_CONNECTION_MANAGE='erp.connection.manage',ERP_CONNECTION_SECRET_READ='erp.connection.secret.read';
type Actor=AdminAuthorityActor;
type CredentialInput=typeof erpCredential.$inferInsert;
const now=()=>Math.floor(Date.now()/1000);
const unavailable=()=>new ServiceUnavailableException('ERP 授权状态尚未就绪，请重新授权');
function dto(row:ErpConnectionRow,credential?:ErpCredentialRow) {
  validateErpConnection(row);return {id:row.id,name:row.name,provider:row.provider,state:row.state,revision:row.revision,app_key:row.appKey,
    capability_version:row.capabilityVersion,scope_revision:row.scopeRevision,bindings:row.bindings,created_at:row.createdAt,updated_at:row.updatedAt,
    authorized:credential?.state==='usable'&&(credential.expiresAt>now()),expires_at:credential?.expiresAt??null,needs_reauth:!credential||credential.state!=='usable'||credential.expiresAt<=now()};
}
function tokenResponse(value:unknown,issuedAt:number) {
  const row=erpObject(value),access=erpText(row.access_token,'ERP 授权凭据',4096),refresh=erpText(row.refresh_token,'ERP 刷新凭据',4096);
  const expires=erpInteger(row.expires_in,'ERP 授权有效期',60,366*86400);
  return {access,refresh,issuedAt,expiresAt:issuedAt+expires,refreshAfter:issuedAt+Math.max(1,expires-Math.min(48*3600,Math.floor(expires/5)))};
}
async function exactConnection(tx:DbClient,expected:ErpConnectionRow):Promise<void>{
  const [saved]=await tx.select().from(erpConnection).where(eq(erpConnection.id,expected.id)).limit(1);
  if(!saved||erpCanonical(saved)!==erpCanonical(expected))throw erpConflict('ERP 连接写入或回读不一致');
}
async function exactCredential(tx:DbClient,expected:ErpCredentialRow):Promise<void>{
  const [saved]=await tx.select().from(erpCredential).where(eq(erpCredential.connectionId,expected.connectionId)).limit(1);
  if(!saved||erpCanonical(saved)!==erpCanonical(expected))throw erpConflict('ERP 凭据写入或回读不一致');
}
function parsedBindings(value:unknown):ErpShopBinding[]{
  if(!Array.isArray(value)||!value.length||value.length>100)throw new BadRequestException('ERP 店铺绑定数量无效');
  const bindings=value.map(item=>{const row=erpObject(item);erpOnly(row,['provider_shop_id','store_id','supplier_id']);
    return {providerShopId:erpInteger(row.provider_shop_id,'ERP 店铺'),storeId:erpInteger(row.store_id,'本地门店',0),supplierId:erpInteger(row.supplier_id,'供应商',0)};});
  const keys=bindings.map(item=>erpCanonical(item));if(new Set(keys).size!==keys.length)throw new BadRequestException('ERP 店铺绑定重复');
  return bindings.sort((a,b)=>a.providerShopId-b.providerShopId||a.storeId-b.storeId||a.supplierId-b.supplierId);
}

/** Management uses real current Admin JWT claims. Callback execution never
 * calls this service with an invented Admin or Out actor. */
export class ErpConnectionService {
  constructor(private readonly container:Container,private readonly env:ErpEnv,private readonly provider=new ErpProviderClient()){}
  private async adminTx<T>(actor:Actor,permission:string,work:(tx:DbClient)=>Promise<T>):Promise<T>{
    assertAdminAuthoritySession(actor);
    return withTx(this.container,async tx=>{
      await acquireAdminAuthorityWriteBarrier(tx);await assertErpStateReady(tx);await lockErpConfig(tx);await lockErpScope(tx);
      await loadAdminAuthorityLiveActor(tx,actor,permission);
      const [baseline]=await tx.select().from(systemAdmin).where(eq(systemAdmin.id,actor.id)).limit(1);
      const result=await work(tx);await loadAdminAuthorityLiveActor(tx,actor,permission);
      const [fresh]=await tx.select().from(systemAdmin).where(eq(systemAdmin.id,actor.id)).limit(1);
      if(!baseline||!fresh||erpCanonical(baseline)!==erpCanonical(fresh))throw erpConflict('ERP 操作不能改写管理员账号');
      assertAdminAuthoritySession(actor);return result;
    });
  }
  private async audit(tx:DbClient,actor:Actor,id:string,operation:string){
    const value={adminId:actor.id,path:`erp/connections/${id}`,page:'ERP 连接',method:'POST',type:'erp_connection',action:JSON.stringify({connection_id:id,operation}),addTime:now()};
    const [saved]=await tx.insert(systemLog).values(value).returning();
    if(!saved||Object.entries(value).some(([key,item])=>saved[key as keyof typeof saved]!==item))throw erpConflict('ERP 审计写入不一致');
  }
  async list(actor:Actor){
    return this.adminTx(actor,ERP_CONNECTION_VIEW,async tx=>{
      const rows=await tx.select().from(erpConnection).orderBy(desc(erpConnection.createdAt),erpConnection.id).limit(101);
      if(rows.length>100)throw new ServiceUnavailableException('ERP 连接目录超过100项，请先整理');
      const credentials=await tx.select().from(erpCredential);
      let configuration:{ready:boolean;app_key:string;default_shop_id:number|null}={ready:false,app_key:'',default_shop_id:null};
      try{const config=await readErpConfig(tx,this.env);configuration={ready:true,app_key:config.appKey,default_shop_id:config.defaultShopId};}catch{/* Redacted management remains available for revocation. */}
      return {list:rows.map(row=>dto(row,credentials.find(value=>value.connectionId===row.id))),configuration};
    });
  }
  async create(actor:Actor,value:unknown){
    const input=erpObject(value);erpOnly(input,['name']);const name=erpText(input.name,'ERP 连接名称',64);
    const id=crypto.randomUUID(),capability=erpRandomToken(),origin=erpCallbackOrigin(this.env),timestamp=now();
    return this.adminTx(actor,ERP_CONNECTION_MANAGE,async tx=>{
      const config=await readErpConfig(tx,this.env);
      const expected:ErpConnectionRow={id,provider:'jushuitan',name,state:'enrolled',revision:1,appKey:config.appKey,credentialFingerprint:config.fingerprint,
        capabilityHash:erpCapabilityHash(capability),capabilityVersion:1,rotatedAt:timestamp,bindings:[],scopeRevision:1,shopObservationHash:null,
        createdBy:actor.id,updatedBy:actor.id,createdAt:timestamp,updatedAt:timestamp,revokedAt:null,revokeReason:null};
      const [saved]=await tx.insert(erpConnection).values(expected).returning();if(!saved||erpCanonical(saved)!==erpCanonical(expected))throw erpConflict('ERP 连接未完整保存');
      await this.audit(tx,actor,id,'enroll');await exactConnection(tx,expected);
      return {connection:dto(expected),callback_urls:this.urls(origin,id,capability),capability_once:true};
    });
  }
  private urls(origin:string,id:string,capability:string){return {
    stock:erpPrivateCapabilityUrl(origin,id,capability,'/erpapi/stock/callback'),deliver:erpPrivateCapabilityUrl(origin,id,capability,'/erpapi/order/deliver_callback'),
    cancel:erpPrivateCapabilityUrl(origin,id,capability,'/erpapi/order/cancel_callback'),refund_receive:erpPrivateCapabilityUrl(origin,id,capability,'/erpapi/refund/receive_callback')};}
  async change(actor:Actor,idValue:unknown,operation:'disable'|'revoke'|'rotate',value:unknown){
    const id=erpId(idValue),input=erpObject(value);erpOnly(input,operation==='revoke'?['revision','reason']:['revision']);
    const revision=erpInteger(input.revision,'ERP 连接版本'),reason=operation==='revoke'?erpText(input.reason,'ERP 撤回原因',255):null;
    const capability=operation==='rotate'?erpRandomToken():null,origin=operation==='rotate'?erpCallbackOrigin(this.env):null;
    return this.adminTx(actor,ERP_CONNECTION_MANAGE,async tx=>{
      const [before]=await tx.select().from(erpConnection).where(eq(erpConnection.id,id)).limit(1).for('update',{noWait:true});
      if(!before)throw new ForbiddenException('ERP 连接不存在');validateErpConnection(before);
      if(before.revision!==revision||before.state==='revoked')throw erpConflict();
      if(operation==='rotate'&&before.state==='disabled')throw new ForbiddenException('停用 ERP 连接不能轮换回调凭据');
      const expected:ErpConnectionRow={...before,revision:before.revision+1,updatedAt:now(),updatedBy:actor.id,
        ...(operation==='disable'?{state:'disabled' as const}:operation==='revoke'?{state:'revoked' as const,revokedAt:now(),revokeReason:reason}:
          {capabilityHash:erpCapabilityHash(capability!),capabilityVersion:before.capabilityVersion+1,rotatedAt:now()})};
      const [saved]=await tx.update(erpConnection).set(expected).where(eq(erpConnection.id,id)).returning();
      if(!saved||erpCanonical(saved)!==erpCanonical(expected))throw erpConflict('ERP 连接变更未完整保存');
      if(operation==='revoke'){
        const [credential]=await tx.select().from(erpCredential).where(eq(erpCredential.connectionId,id)).limit(1).for('update',{noWait:true});
        if(credential){const next={...credential,state:'revoked' as const,refreshLeaseHash:null,refreshLeaseExpiresAt:null,updatedAt:now()};
          const [written]=await tx.update(erpCredential).set(next).where(eq(erpCredential.connectionId,id)).returning();
          if(!written||erpCanonical(written)!==erpCanonical(next))throw erpConflict('ERP 凭据撤回未完整保存');await exactCredential(tx,next);}
      }
      await this.audit(tx,actor,id,operation);await exactConnection(tx,expected);
      return {connection:dto(expected),...(capability?{callback_urls:this.urls(origin!,id,capability),capability_once:true}:{})};
    });
  }
  async auth(actor:Actor,idValue:unknown){
    const id=erpId(idValue),state=erpRandomToken(),timestamp=now();erpCallbackOrigin(this.env);
    return this.adminTx(actor,ERP_CONNECTION_MANAGE,async tx=>{
      const config=await readErpConfig(tx,this.env),connection=await readErpConnection(tx,id,config,false,true);
      const stateRow:typeof erpAuthState.$inferInsert={stateHash:erpSha256(state),connectionId:id,connectionRevision:connection.revision,capabilityVersion:connection.capabilityVersion,
        appKey:config.appKey,credentialFingerprint:config.fingerprint,actorId:actor.id,actorAuthVersion:actor.authVersion,actorExpiresAt:actor.expiresAt,
        requiredPermission:ERP_CONNECTION_MANAGE,createdAt:timestamp,expiresAt:Math.min(timestamp+900,actor.expiresAt),state:'issued',codeHash:null,exchangeLeaseHash:null,leaseExpiresAt:null,consumedAt:null,errorCode:null};
      if(stateRow.expiresAt<=timestamp)throw new ForbiddenException('ERP 授权登录已过期');
      const [saved]=await tx.insert(erpAuthState).values(stateRow).returning();if(!saved||erpCanonical(saved)!==erpCanonical(stateRow))throw erpConflict('ERP 授权状态未完整保存');
      const parameters:Record<string,string|number>={app_key:config.appKey,timestamp,state,charset:'utf-8'};parameters.sign=erpPopSign(parameters,config.appSecret);
      const [readback]=await tx.select().from(erpAuthState).where(eq(erpAuthState.stateHash,saved.stateHash)).limit(1);
      if(!readback||erpCanonical(readback)!==erpCanonical(saved))throw erpConflict('ERP 授权状态回读不一致');
      return {'0':parameters,jump_url:`https://openweb.jushuitan.com/auth?${new URLSearchParams(Object.entries(parameters).map(([key,item])=>[key,String(item)])).toString()}`,expires_at:stateRow.expiresAt};
    });
  }
  async authCallback(rawUrl:string):Promise<void>{
    const entries=erpOrderedQuery(rawUrl),query=new Map(entries);
    if(entries.some(([key])=>!['app_key','code','state','sign','timestamp'].includes(key)))throw new BadRequestException('ERP 授权回调包含未知参数');
    const state=erpText(query.get('state'),'ERP 授权状态',43),code=erpText(query.get('code'),'ERP 授权代码',1024),stateHash=erpCapabilityHash(state),lease=erpRandomToken();
    const admission=await withTx(this.container,async tx=>{
      await acquireAdminAuthorityWriteBarrier(tx);await assertErpStateReady(tx);await lockErpConfig(tx);await lockErpScope(tx);
      const config=await readErpConfig(tx,this.env);
      if(query.get('app_key')!==config.appKey||!erpEqualSign(query.get('sign')??'',erpPopSign(Object.fromEntries(entries),config.appSecret)))throw new ForbiddenException('ERP 授权签名无效');
      const [before]=await tx.select().from(erpAuthState).where(eq(erpAuthState.stateHash,stateHash)).limit(1).for('update',{noWait:true});
      if(!before||before.state!=='issued'||before.expiresAt<=now()||before.appKey!==config.appKey||!erpEqualHash(before.credentialFingerprint,config.fingerprint))throw new ForbiddenException('ERP 授权状态无效或已使用');
      const actor:Actor={id:before.actorId,authVersion:before.actorAuthVersion,expiresAt:before.actorExpiresAt};await loadAdminAuthorityLiveActor(tx,actor,ERP_CONNECTION_MANAGE);
      const connection=await readErpConnection(tx,before.connectionId,config,false,true);
      if(connection.revision!==before.connectionRevision||connection.capabilityVersion!==before.capabilityVersion)throw erpConflict();
      const expected={...before,state:'exchanging' as const,codeHash:erpSha256(code),exchangeLeaseHash:erpSha256(lease),leaseExpiresAt:now()+30};
      const [written]=await tx.update(erpAuthState).set(expected).where(eq(erpAuthState.stateHash,stateHash)).returning();
      const [fresh]=await tx.select().from(erpAuthState).where(eq(erpAuthState.stateHash,stateHash)).limit(1);
      if(!written||!fresh||erpCanonical(written)!==erpCanonical(expected)||erpCanonical(fresh)!==erpCanonical(expected))throw erpConflict('ERP 授权领取结果不一致');
      await loadAdminAuthorityLiveActor(tx,actor,ERP_CONNECTION_MANAGE);await exactConnection(tx,connection);assertAdminAuthoritySession(actor);
      return {actor,config,connection,state:expected};
    });
    try{
      const issuedAt=now(),tokens=tokenResponse(await this.provider.exchange(admission.config,code,issuedAt),issuedAt),codec=new ErpSecretCodec(this.env);
      await this.adminTx(admission.actor,ERP_CONNECTION_MANAGE,async tx=>{
        const config=await readErpConfig(tx,this.env),connection=await readErpConnection(tx,admission.connection.id,config,false,true);
        if(config.revision!==admission.config.revision||connection.revision!==admission.connection.revision)throw erpConflict();
        const [stateRow]=await tx.select().from(erpAuthState).where(eq(erpAuthState.stateHash,stateHash)).limit(1).for('update',{noWait:true});
        if(!stateRow||stateRow.state!=='exchanging'||!erpEqualHash(stateRow.exchangeLeaseHash??'',erpSha256(lease))||stateRow.leaseExpiresAt!<=now()||stateRow.expiresAt<=now())throw erpConflict('ERP 授权领取已过期');
        const [before]=await tx.select().from(erpCredential).where(eq(erpCredential.connectionId,connection.id)).limit(1).for('update',{noWait:true});
        const version=(before?.version??0)+1;
        const expected:CredentialInput={connectionId:connection.id,version,appKey:config.appKey,credentialFingerprint:config.fingerprint,
          accessTokenSealed:await codec.seal(tokens.access,erpCredentialAad(connection,version,'access')),refreshTokenSealed:await codec.seal(tokens.refresh,erpCredentialAad(connection,version,'refresh')),
          issuedAt:tokens.issuedAt,expiresAt:tokens.expiresAt,refreshAfter:tokens.refreshAfter,authStateHash:stateHash,shopObservationHash:null,
          refreshLeaseHash:null,refreshLeaseExpiresAt:null,updatedAt:now(),state:'usable',errorCode:null};
        const [saved]=before?await tx.update(erpCredential).set(expected).where(eq(erpCredential.connectionId,connection.id)).returning():await tx.insert(erpCredential).values(expected).returning();
        if(!saved||erpCanonical(saved)!==erpCanonical(expected))throw erpConflict('ERP 授权凭据未完整保存');
        const finalState={...stateRow,state:'consumed' as const,consumedAt:now(),exchangeLeaseHash:null,leaseExpiresAt:null};
        const [written]=await tx.update(erpAuthState).set(finalState).where(eq(erpAuthState.stateHash,stateHash)).returning();
        const [freshState]=await tx.select().from(erpAuthState).where(eq(erpAuthState.stateHash,stateHash)).limit(1);
        if(!written||!freshState||erpCanonical(written)!==erpCanonical(finalState)||erpCanonical(freshState)!==erpCanonical(finalState))throw erpConflict('ERP 授权完成回读不一致');
        await this.audit(tx,admission.actor,connection.id,'authorize');await exactCredential(tx,saved);await exactConnection(tx,connection);
      });
    }catch(error){await this.failAuthState(stateHash,erpSha256(lease));throw error;}
  }
  private async failAuthState(stateHash:string,leaseHash:string){
    try{await withTx(this.container,async tx=>{await erpDeadlines(tx);const [row]=await tx.select().from(erpAuthState).where(eq(erpAuthState.stateHash,stateHash)).limit(1).for('update',{noWait:true});
      if(row?.state==='exchanging'&&erpEqualHash(row.exchangeLeaseHash??'',leaseHash))await tx.update(erpAuthState).set({state:'failed',errorCode:'authorization_incomplete',exchangeLeaseHash:null,leaseExpiresAt:null}).where(eq(erpAuthState.stateHash,stateHash));});}catch{/* Receipt stays exchanging/expired: never usable. */}
  }
  async accessToken(actor:Actor,idValue:unknown):Promise<string>{
    const id=erpId(idValue);return this.adminTx(actor,ERP_CONNECTION_SECRET_READ,async tx=>{
      const config=await readErpConfig(tx,this.env),connection=await readErpConnection(tx,id,config,false);
      const [credential]=await tx.select().from(erpCredential).where(eq(erpCredential.connectionId,id)).limit(1).for('share',{noWait:true});
      if(!credential||credential.state!=='usable'||credential.expiresAt<=now()||credential.appKey!==config.appKey||!erpEqualHash(credential.credentialFingerprint,config.fingerprint))throw unavailable();
      return new ErpSecretCodec(this.env).open(credential.accessTokenSealed,erpCredentialAad(connection,credential.version,'access'));
    });
  }
  async bind(actor:Actor,idValue:unknown,value:unknown){
    const id=erpId(idValue),input=erpObject(value);erpOnly(input,['revision','bindings']);const revision=erpInteger(input.revision,'ERP 连接版本'),bindings=parsedBindings(input.bindings);
    const admission=await this.adminTx(actor,ERP_CONNECTION_MANAGE,async tx=>{
      const config=await readErpConfig(tx,this.env),connection=await readErpConnection(tx,id,config,false);
      if(connection.revision!==revision)throw erpConflict();await assertErpBindings(tx,{...connection,bindings},config);
      const [credential]=await tx.select().from(erpCredential).where(eq(erpCredential.connectionId,id)).limit(1).for('share',{noWait:true});
      if(!credential||credential.state!=='usable'||credential.expiresAt<=now()||!erpEqualHash(credential.credentialFingerprint,config.fingerprint))throw unavailable();
      const accessToken=await new ErpSecretCodec(this.env).open(credential.accessTokenSealed,erpCredentialAad(connection,credential.version,'access'));
      return {config,connection,credential,accessToken};
    });
    const requested=[...new Set(bindings.map(binding=>binding.providerShopId))],observed:Array<{shopId:number;name:string}>=[];
    for(let offset=0;offset<requested.length;offset+=50){const result=await this.provider.query('shops',{...admission.config,accessToken:admission.accessToken},{shop_ids:requested.slice(offset,offset+50),page_index:1,page_size:50},now());
      if(!Array.isArray(result.shops)||result.has_next===true||result.shops.length>50)throw unavailable();
      for(const item of result.shops){const shop=erpObject(item),shopId=erpInteger(shop.shop_id,'ERP 店铺');if(!requested.includes(shopId)||observed.some(row=>row.shopId===shopId))throw unavailable();
        observed.push({shopId,name:erpText(shop.shop_name??'','ERP 店铺名称',128,true)});}}
    if(requested.some(idValue=>!observed.some(row=>row.shopId===idValue)))throw new ForbiddenException('ERP 未证实所选店铺的当前归属');
    const hash=erpSha256(erpCanonical(observed.sort((a,b)=>a.shopId-b.shopId)));
    return this.adminTx(actor,ERP_CONNECTION_MANAGE,async tx=>{
      const config=await readErpConfig(tx,this.env),before=await readErpConnection(tx,id,config,false,true);
      if(config.revision!==admission.config.revision||before.revision!==revision)throw erpConflict();
      const [credential]=await tx.select().from(erpCredential).where(eq(erpCredential.connectionId,id)).limit(1).for('update',{noWait:true});
      if(!credential||erpCanonical(credential)!==erpCanonical(admission.credential)||credential.expiresAt<=now())throw erpConflict();
      const expected:ErpConnectionRow={...before,bindings,state:'active',scopeRevision:before.scopeRevision+1,revision:before.revision+1,shopObservationHash:hash,updatedAt:now(),updatedBy:actor.id};
      await assertErpBindings(tx,expected,config);
      const [saved]=await tx.update(erpConnection).set(expected).where(eq(erpConnection.id,id)).returning();
      if(!saved||erpCanonical(saved)!==erpCanonical(expected))throw erpConflict('ERP 店铺授权未完整保存');
      const next={...credential,shopObservationHash:hash,updatedAt:now()};const [savedCredential]=await tx.update(erpCredential).set(next).where(eq(erpCredential.connectionId,id)).returning();
      if(!savedCredential||erpCanonical(savedCredential)!==erpCanonical(next))throw erpConflict('ERP 店铺凭据未完整保存');
      await this.audit(tx,actor,id,'bind-shops');await exactCredential(tx,next);await exactConnection(tx,expected);return {connection:dto(expected,next),shops:observed};
    });
  }
}
