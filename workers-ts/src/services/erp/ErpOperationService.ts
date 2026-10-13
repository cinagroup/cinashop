import { and,eq,sql } from 'drizzle-orm';
import { withTx,type Container,type DbClient } from '@/lib/di';
import { erpCredential,erpOperation,type ErpBusinessResult,type ErpOperationKind,type ErpOperationScope } from '@/models/erp';
import { ForbiddenException,ServiceUnavailableException } from '@/utils/errors';
import { erpCapabilityHash,erpCanonical,erpEqualHash,erpRandomToken,erpSha256,type ErpCallbackQuery } from './ErpProtocol';
import { ErpSecretCodec } from './ErpSecretCodec';
import { assertErpStateReady,erpConflict,erpCredentialAad,erpDeadlines,lockErpConfig,lockErpScope,readErpConfig,readErpConnection,
  type ErpConfigSnapshot,type ErpConnectionRow,type ErpCredentialRow,type ErpEnv } from './ErpConnectionPolicy';

export const ERP_OPERATION_LOCK=731746;
export type ErpOperationRow=typeof erpOperation.$inferSelect;
export interface ErpRuntimeSnapshot {connection:ErpConnectionRow;credential:ErpCredentialRow;config:ErpConfigSnapshot;accessToken:string}
export interface ErpOperationAdmission {snapshot:ErpRuntimeSnapshot;operation:ErpOperationRow;lease:string;replay:boolean}
const now=()=>Math.floor(Date.now()/1000);
const unavailable=()=>new ServiceUnavailableException('ERP 操作状态尚未就绪');
export function erpOperationDto(row:ErpOperationRow){return {operation_id:row.id,connection_id:row.connectionId,kind:row.kind,state:row.state,
  created_at:row.createdAt,updated_at:row.updatedAt,completed_at:row.completedAt,error_code:row.errorCode,result:row.businessResult};}
async function exact(tx:DbClient,expected:ErpOperationRow){
  const [fresh]=await tx.select().from(erpOperation).where(eq(erpOperation.id,expected.id)).limit(1);
  if(!fresh||erpCanonical(fresh)!==erpCanonical(expected))throw erpConflict('ERP 操作回执保存或回读不一致');
}
export class ErpOperationService {
  constructor(private readonly container:Container,private readonly env:ErpEnv){}
  async snapshot(query:ErpCallbackQuery):Promise<ErpRuntimeSnapshot>{
    return withTx(this.container,async tx=>{
      await erpDeadlines(tx);await assertErpStateReady(tx);await lockErpConfig(tx);await lockErpScope(tx);
      const config=await readErpConfig(tx,this.env),connection=await readErpConnection(tx,query.connectionId,config);
      if(!erpEqualHash(connection.capabilityHash,erpCapabilityHash(query.capability)))throw new ForbiddenException('ERP 回调凭据已撤回');
      const [credential]=await tx.select().from(erpCredential).where(eq(erpCredential.connectionId,connection.id)).limit(1).for('share',{noWait:true});
      if(!credential||credential.state!=='usable'||credential.expiresAt<=now()||credential.appKey!==config.appKey
        || !erpEqualHash(credential.credentialFingerprint,config.fingerprint)||credential.shopObservationHash!==connection.shopObservationHash)throw unavailable();
      const accessToken=await new ErpSecretCodec(this.env).open(credential.accessTokenSealed,erpCredentialAad(connection,credential.version,'access'));
      return {connection,credential,config,accessToken};
    });
  }
  async recheck(tx:DbClient,snapshot:ErpRuntimeSnapshot):Promise<ErpConnectionRow>{
    await assertErpStateReady(tx);await lockErpConfig(tx);await lockErpScope(tx);
    const config=await readErpConfig(tx,this.env),connection=await readErpConnection(tx,snapshot.connection.id,config);
    if(config.revision!==snapshot.config.revision||erpCanonical(connection)!==erpCanonical(snapshot.connection))throw erpConflict();
    const [credential]=await tx.select().from(erpCredential).where(eq(erpCredential.connectionId,connection.id)).limit(1).for('share',{noWait:true});
    if(!credential||erpCanonical(credential)!==erpCanonical(snapshot.credential)||credential.expiresAt<=now())throw erpConflict('ERP 授权凭据已变化');
    return connection;
  }
  /** Claims only genuine observed facts. This receipt does not itself prove a
   * stock, fulfillment or monetary effect. That effect must call complete in
   * its actual mature SQL transaction. */
  async claim(snapshot:ErpRuntimeSnapshot,kind:ErpOperationKind,businessKey:string,request:unknown,sourceTs:number,
    scope:ErpOperationScope,facts:Record<string,unknown>):Promise<ErpOperationAdmission>{
    if(!businessKey||businessKey.length>255)throw unavailable();
    const requestHash=erpSha256(erpCanonical(request)),observationHash=erpSha256(erpCanonical(facts)),lease=erpRandomToken();
    return withTx(this.container,async tx=>{
      await erpDeadlines(tx);await this.recheck(tx,snapshot);
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${ERP_OPERATION_LOCK},hashtext(${`${snapshot.connection.id}:${kind}:${businessKey}`}))`);
      const [before]=await tx.select().from(erpOperation).where(and(eq(erpOperation.connectionId,snapshot.connection.id),eq(erpOperation.kind,kind),eq(erpOperation.businessKey,businessKey)))
        .limit(1).for('update',{noWait:true});
      if(before){
        if(!erpEqualHash(before.requestHash,requestHash))throw erpConflict('ERP 事件标识与原始正文不一致');
        if(before.state==='business_committed'||before.state==='provider_pending'||before.state==='rejected')return {snapshot,operation:before,lease:'',replay:true};
        if(!erpEqualHash(before.observationHash??'',observationHash)||erpCanonical(before.scope)!==erpCanonical(scope))throw erpConflict('ERP 当前事实与原始待处理事件不一致');
        if(before.leaseExpiresAt!==null&&before.leaseExpiresAt>now())return {snapshot,operation:before,lease:'',replay:true};
        const expected={...before,leaseHash:erpSha256(lease),leaseExpiresAt:now()+120,attemptCount:before.attemptCount+1,updatedAt:now(),state:'observed' as const,errorCode:null};
        const [saved]=await tx.update(erpOperation).set(expected).where(eq(erpOperation.id,before.id)).returning();
        if(!saved||erpCanonical(saved)!==erpCanonical(expected))throw erpConflict('ERP 事件领取不一致');await exact(tx,expected);return {snapshot,operation:expected,lease,replay:false};
      }
      const timestamp=now(),expected:ErpOperationRow={id:crypto.randomUUID(),connectionId:snapshot.connection.id,kind,businessKey,providerEventId:null,
        requestHash,sourceTs,receivedAt:timestamp,connectionRevision:snapshot.connection.revision,capabilityVersion:snapshot.connection.capabilityVersion,
        scopeRevision:snapshot.connection.scopeRevision,credentialVersion:snapshot.credential.version,state:'observed',leaseHash:erpSha256(lease),leaseExpiresAt:timestamp+120,attemptCount:1,
        scope,observationHash,observedAt:timestamp,providerFacts:facts,businessResult:null,paymentAdmissionId:null,errorCode:null,createdAt:timestamp,updatedAt:timestamp,completedAt:null};
      const [saved]=await tx.insert(erpOperation).values(expected).returning();if(!saved||erpCanonical(saved)!==erpCanonical(expected))throw erpConflict('ERP 事件未完整保存');
      await exact(tx,expected);return {snapshot,operation:expected,lease,replay:false};
    });
  }
  async authorize(tx:DbClient,admission:ErpOperationAdmission):Promise<ErpOperationRow>{
    await this.recheck(tx,admission.snapshot);
    const [row]=await tx.select().from(erpOperation).where(eq(erpOperation.id,admission.operation.id)).limit(1).for('update',{noWait:true});
    if(!row||row.connectionId!==admission.snapshot.connection.id||row.requestHash!==admission.operation.requestHash
      || row.observationHash!==admission.operation.observationHash||erpCanonical(row.scope)!==erpCanonical(admission.operation.scope))throw erpConflict('ERP 原始操作范围不一致');
    if(row.state==='business_committed'||row.state==='provider_pending')return row;
    if(row.state!=='observed'||!admission.lease||!erpEqualHash(row.leaseHash??'',erpSha256(admission.lease))||row.leaseExpiresAt!<=now())throw erpConflict('ERP 操作领取已变化或过期');
    return row;
  }
  async complete(tx:DbClient,admission:ErpOperationAdmission,result:ErpBusinessResult,paymentAdmissionId?:string):Promise<ErpOperationRow>{
    const before=await this.authorize(tx,admission);
    if(before.state==='business_committed'||before.state==='provider_pending'){
      if(erpCanonical(before.businessResult)!==erpCanonical(result)||before.paymentAdmissionId!==(paymentAdmissionId??null))throw erpConflict('ERP 最终回执与业务结果不一致');return before;
    }
    const expected={...before,state:paymentAdmissionId?'provider_pending' as const:'business_committed' as const,businessResult:result,paymentAdmissionId:paymentAdmissionId??null,
      updatedAt:now(),completedAt:paymentAdmissionId?null:now(),leaseHash:null,leaseExpiresAt:null,errorCode:null};
    const [written]=await tx.update(erpOperation).set(expected).where(eq(erpOperation.id,before.id)).returning();
    if(!written||erpCanonical(written)!==erpCanonical(expected))throw erpConflict('ERP 最终回执未完整保存');await exact(tx,expected);return expected;
  }
  async pending(admission:ErpOperationAdmission,code:string):Promise<ErpOperationRow>{
    if(!/^[a-z_]{1,64}$/.test(code))throw unavailable();return withTx(this.container,async tx=>{
      await erpDeadlines(tx);const before=await this.authorize(tx,admission);
      if(before.state==='business_committed'||before.state==='provider_pending')return before;
      const expected={...before,errorCode:code,leaseHash:null,leaseExpiresAt:null,updatedAt:now()};
      const [written]=await tx.update(erpOperation).set(expected).where(eq(erpOperation.id,before.id)).returning();
      if(!written||erpCanonical(written)!==erpCanonical(expected))throw erpConflict('ERP 待处理回执不一致');await exact(tx,expected);return expected;
    });
  }
}
