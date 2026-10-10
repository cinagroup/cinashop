import { asc, eq, inArray } from 'drizzle-orm';
import { createHmac, timingSafeEqual } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { createContainerFromDb, withTx, type Container, type DbClient } from '@/lib/di';
import { systemAdmin, systemMenus, systemRole } from '@/models/schema';
import { adminAuthorityOperation } from '@/models/schema/adminAuthorityOperation';
import { acquireAdminAuthorityMenuLock, assertAdminAuthorityOperationReady } from '@/migrations/adminAuthorityOperation';
import { AuthException, ApiErrorCode, HttpApiException, ServiceUnavailableException, ValidateException } from '@/utils/errors';
import { md5 } from '@/utils/jwt';
import { AdminPermissionService, assertDelegablePermissions } from './AdminPermissionService';
import { acquireAdminAuthorityWriteBarrier, adminAuthorityWriteError, applyAdminAuthorityWrite, assertAdminAuthoritySession,
  inspectAdminRoleMutationImpact, normalizeAdminAuthorityRules,
  loadAdminAuthorityLiveActor, parseAdminAuthorityRoleIds, planAdminAuthorityWrite, prepareAdminAuthorityWrite,
  type AdminAuthorityActor, type AdminAuthorityLiveActor, type AdminAuthorityOperationKind,
  type AdminAuthorityWritePlan, type PreparedAdminAuthorityWrite } from './AdminAuthorityWriteService';

export const ADMIN_AUTHORITY_PREVIEW_TTL_SECONDS = 300;
export const MAX_ADMIN_AUTHORITY_DECISION_ROWS = 10_000;
export interface AdminAuthorityOperationResult { id: number; created?: boolean; deleted?: boolean }
export interface AdminAuthorityReceipt {
  operation_id: string; actor_id: number; operation: AdminAuthorityOperationKind;
  state: 'committed' | 'not_applied' | 'unknown'; request_hash: string | null; result: AdminAuthorityOperationResult | null;
}
export interface AdminAuthorityPreview {
  operation_id: string; actor_id: number; operation: AdminAuthorityOperationKind;
  request_hash: string; revision: string; expires_at: number;
  summary: { target_id: number; target_name: string; action: 'create' | 'update' | 'delete';
    before: AdminAuthoritySummaryFields | null; after: AdminAuthoritySummaryFields };
  affected_accounts: AdminAuthorityAffectedAccount[]; requires_confirmation: true;
}
export interface AdminAuthoritySummaryFields { role_name?: string; rules?: string; level?: number; status?: number; roles?: string }
export interface AdminAuthorityAffectedAccount { id: number; account: string; real_name: string; level: number; status: number; is_del: number }
interface Envelope { operationId: string; operation: AdminAuthorityOperationKind; prepared: PreparedAdminAuthorityWrite }
type ReceiptRow = typeof adminAuthorityOperation.$inferSelect;
const conflict = (message: string) => new HttpApiException(message, 409, 409);
const UUID_V4 = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

export function adminAuthorityOperationId(value: unknown): string {
  if (typeof value !== 'string' || !UUID_V4.test(value)) throw new ValidateException('操作ID必须为小写UUIDv4');
  return value;
}
export function adminAuthorityOperationKind(value: unknown): AdminAuthorityOperationKind {
  if (value !== 'admin-save' && value !== 'role-save' && value !== 'role-delete') throw new ValidateException('管理员权限操作类型错误');
  return value;
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ValidateException('请求数据格式错误');
  return value as Record<string, unknown>;
}
function onlyFields(row: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(row).some(key => !allowed.includes(key))) throw new ValidateException('操作提交包含未知字段');
}
function envelope(value: unknown, commit = false): Envelope {
  const row = object(value);
  onlyFields(row, commit ? ['operation_id','operation','payload','revision','expires_at','confirmed'] : ['operation_id','operation','payload']);
  const operationId = adminAuthorityOperationId(row.operation_id), operation = adminAuthorityOperationKind(row.operation);
  const payload = object(row.payload);
  onlyFields(payload, operation === 'admin-save' ? ['id','account','real_name','phone','pwd','roles','level','status']
    : operation === 'role-save' ? ['id','role_name','rules','level','status'] : ['id']);
  return { operationId, operation, prepared: prepareAdminAuthorityWrite(operation,payload) };
}
/** Every signed representation is deterministic and rejects JSON constructs
 * which a request cannot represent. Undefined optional prepared fields vanish. */
function canonical(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(item => canonical(item)).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>)
    .filter(([,item]) => item !== undefined).sort(([left],[right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key,item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  throw new ValidateException('操作包含不能签名的数据');
}
function equalHash(actual: string, expected: string): boolean {
  return /^[a-f0-9]{64}$/.test(actual) && timingSafeEqual(new TextEncoder().encode(actual),new TextEncoder().encode(expected));
}
function capabilityError(error: unknown, capability: 'receipt' | 'menu-lock' = 'receipt'): never {
  let cause = error;
  for (let depth=0; depth<6 && cause && typeof cause === 'object'; depth++) {
    if ('code' in cause && (['42P01','42501'].includes(String(cause.code)) || capability === 'menu-lock' && String(cause.code) === '42883')) {
      throw new ServiceUnavailableException(capability === 'menu-lock' ? '权限目录锁尚未就绪，请稍后重试' : '权限操作回执尚未就绪，请稍后重试');
    }
    if ('code' in cause && String(cause.code) === '23505') throw conflict('操作ID已被使用，请恢复原操作');
    cause = 'cause' in cause ? cause.cause : undefined;
  }
  throw error;
}
function receiptDto(row: ReceiptRow): AdminAuthorityReceipt {
  return { operation_id:row.operationId,actor_id:row.actorId,operation:adminAuthorityOperationKind(row.operation),
    state:row.state as 'committed' | 'not_applied',request_hash:row.state === 'committed' ? row.requestHash : null,
    result:row.result as AdminAuthorityOperationResult | null };
}
function validateReceipt(row: ReceiptRow, actorId: number, operation: AdminAuthorityOperationKind): void {
  if (row.actorId !== actorId || row.adminType !== 1 || row.relationId !== 0) throw new AuthException('无权读取该权限操作',ApiErrorCode.ERR_AUTH);
  if (row.operation !== operation) throw conflict('操作ID与原操作类型不一致');
  const result = row.result as AdminAuthorityOperationResult | null;
  if (!Number.isSafeInteger(row.createdAt) || row.createdAt <= 0 || !UUID_V4.test(row.operationId)
    || row.state !== 'committed' && row.state !== 'not_applied'
    || row.state === 'not_applied' && (row.requestHash !== '' || row.revision !== '' || result !== null)
    || row.state === 'committed' && (!/^[a-f0-9]{64}$/.test(row.requestHash) || !/^[a-f0-9]{64}$/.test(row.revision)
      || !result || !Number.isSafeInteger(result.id) || result.id <= 0 || result.id > 2147483647
      || operation === 'role-delete' && (result.deleted !== true || result.created !== undefined)
      || operation !== 'role-delete' && (typeof result.created !== 'boolean' || result.deleted !== undefined)
      || Object.keys(result).some(key => !['id',operation === 'role-delete' ? 'deleted' : 'created'].includes(key)))) {
    throw new ServiceUnavailableException('权限操作回执数据不完整');
  }
}
async function readReceipt(tx: DbClient, operationId: string, actorId: number, operation: AdminAuthorityOperationKind): Promise<ReceiptRow | undefined> {
  const [row] = await tx.select().from(adminAuthorityOperation).where(eq(adminAuthorityOperation.operationId,operationId)).limit(1);
  if (row) validateReceipt(row,actorId,operation);
  return row;
}
async function appendReceipt(tx: DbClient, row: typeof adminAuthorityOperation.$inferInsert): Promise<ReceiptRow> {
  const [saved] = await tx.insert(adminAuthorityOperation).values(row).returning();
  if (!saved || canonical(saved) !== canonical(row)) throw conflict('权限操作回执保存结果不一致');
  validateReceipt(saved,row.actorId,adminAuthorityOperationKind(row.operation));
  const [readBack] = await tx.select().from(adminAuthorityOperation).where(eq(adminAuthorityOperation.operationId,saved.operationId)).limit(1);
  if (!readBack || canonical(readBack) !== canonical(saved)) throw conflict('权限操作回执回读不一致');
  return saved;
}

function affectedAccount(row: typeof systemAdmin.$inferSelect): AdminAuthorityAffectedAccount {
  if (!Number.isSafeInteger(row.id) || row.id <= 0 || row.id > 2147483647 || !Number.isInteger(row.level) || row.level < 0 || row.level > 9
    || ![0,1].includes(row.status) || ![0,1].includes(row.isDel) || [...row.account].length > 32 || [...row.realName].length > 16) {
    throw new ServiceUnavailableException('角色引用管理员数据不完整');
  }
  return { id:row.id,account:row.account,real_name:row.realName,level:row.level,status:row.status,is_del:row.isDel };
}
function summary(plan: AdminAuthorityWritePlan): AdminAuthorityPreview['summary'] {
  const { prepared,currentAdmin,currentRole } = plan;
  // Legacy role metadata uses level 10. An unchanged existing value remains
  // representable; newly requested values are still validated as 0..9.
  if (currentRole && (!Number.isInteger(currentRole.level) || currentRole.level < 0 || currentRole.level > 2147483647)) {
    throw new ServiceUnavailableException('角色等级数据不完整');
  }
  if (prepared.operation === 'admin-save') return { target_id:prepared.id,
    target_name:prepared.realName || currentAdmin?.realName || prepared.account || currentAdmin?.account || '',
    action:currentAdmin ? 'update' : 'create',
    before:currentAdmin ? { roles:currentAdmin.roles,level:currentAdmin.level,status:currentAdmin.status } : null,
    after:{ roles:prepared.roles ?? currentAdmin?.roles ?? '',level:prepared.level ?? currentAdmin?.level ?? 1,status:prepared.status ?? currentAdmin?.status ?? 1 } };
  return { target_id:prepared.id,target_name:prepared.roleName ?? currentRole?.roleName ?? '新角色',
    action:prepared.operation === 'role-delete' ? 'delete' : currentRole ? 'update' : 'create',
    before:currentRole ? { role_name:currentRole.roleName,rules:currentRole.rules,level:currentRole.level,status:currentRole.status } : null,
    after:{ role_name:prepared.roleName ?? currentRole?.roleName ?? '新角色',rules:prepared.rules ?? currentRole?.rules ?? '',
      level:prepared.level ?? currentRole?.level ?? 0,status:prepared.operation === 'role-delete' ? -1 : prepared.status ?? currentRole?.status ?? 1 } };
}

/** All rows used by permission decisions and impact presentation remain on
 * the original transaction. Private proof values never enter the HTTP DTO. */
async function decision(tx: DbClient, live: AdminAuthorityLiveActor, plan: AdminAuthorityWritePlan) {
  const ids = new Set<number>(live.roleIds);
  for (const value of [plan.currentAdmin?.roles,plan.prepared.roles]) if (value !== undefined) {
    for (const id of parseAdminAuthorityRoleIds(value)) ids.add(id);
  }
  // The confirmation binds every reference even for a harmless role rename;
  // only real authority changes run the affected-account permission policy.
  const referenceImpact = plan.currentRole ? plan.roleImpact ?? await inspectAdminRoleMutationImpact(tx,plan.currentRole,
    { rules:plan.currentRole.rules,status:plan.currentRole.status }) : undefined;
  const references = referenceImpact?.references ?? [];
  if (references.some(account => account.adminType !== 1 || account.relationId !== 0)) {
    throw conflict('角色引用包含其他管理域，不能从平台确认变更');
  }
  const accounts = references.length ? await tx.select().from(systemAdmin)
    .where(inArray(systemAdmin.id,references.map(row => row.id))).orderBy(asc(systemAdmin.id)) : plan.currentAdmin ? [plan.currentAdmin] : [];
  for (const account of accounts) for (const id of parseAdminAuthorityRoleIds(account.roles)) ids.add(id);
  if (plan.currentRole) ids.add(plan.currentRole.id);
  if (ids.size > MAX_ADMIN_AUTHORITY_DECISION_ROWS) throw new ServiceUnavailableException('权限目录超过10000，请先整理目录');
  const roles = ids.size ? await tx.select().from(systemRole).where(inArray(systemRole.id,[...ids])).orderBy(asc(systemRole.id)) : [];
  for (const role of roles) normalizeAdminAuthorityRules(role.rules);
  const menus = await tx.select().from(systemMenus).where(eq(systemMenus.type,1)).orderBy(asc(systemMenus.id))
    .limit(MAX_ADMIN_AUTHORITY_DECISION_ROWS+1).for('share',{ noWait:true });
  if (menus.length > MAX_ADMIN_AUTHORITY_DECISION_ROWS || roles.length > MAX_ADMIN_AUTHORITY_DECISION_ROWS) {
    throw new ServiceUnavailableException('权限目录超过10000，请先整理目录');
  }
  const permissionService = new AdminPermissionService(createContainerFromDb(tx));
  const projectedKeys = plan.currentRole && plan.roleImpact ? await permissionService.resolveRulePermissionKeys(plan.roleImpact.next.rules) : [];
  if (plan.roleImpact?.authorityChanged) {
    for (const account of accounts) {
      if (live.level !== 0 && account.level === 0) throw new AuthException('只有超级管理员可以影响超级管理员账号',ApiErrorCode.ERR_AUTH);
      const before = await permissionService.resolveRoleAssignment(account.roles,true);
      const remaining = parseAdminAuthorityRoleIds(account.roles).filter(id => id !== plan.currentRole!.id).join(',');
      const after = await permissionService.resolveRoleAssignment(remaining,true);
      if (plan.roleImpact.next.status === 1) for (const key of projectedKeys) after.keys.add(key);
      if (live.level !== 0) {
        assertDelegablePermissions(live.keys,before.keys);
        assertDelegablePermissions(live.keys,after.keys);
      }
    }
  }
  const [actorRow] = await tx.select().from(systemAdmin).where(eq(systemAdmin.id,live.id)).limit(1);
  return { proof:{ actor:actorRow,roles,menus,accounts,plan:{ prepared:plan.prepared,currentAdmin:plan.currentAdmin,
    currentRole:plan.currentRole,adminFields:plan.adminFields,roleFields:plan.roleFields },catalogue:permissionService.permissionTree() },
    affected:accounts.map(affectedAccount) };
}

export class AdminAuthorityOperationService {
  constructor(private readonly container: Container,private readonly appKey: string) {}
  private async writeTransaction<T>(actor: AdminAuthorityActor,
    callback: (tx: DbClient,live: AdminAuthorityLiveActor) => Promise<T>): Promise<T> {
    assertAdminAuthoritySession(actor);
    try {
      return await withTx(this.container,async tx => {
        await acquireAdminAuthorityWriteBarrier(tx);
        // Row locks on existing menus do not fence a new menu which gives an
        // existing numeric role token authority. Freeze the whole catalogue
        // before the first identity/permission decision read.
        try { await acquireAdminAuthorityMenuLock(tx); } catch (error) { return capabilityError(error,'menu-lock'); }
        const live = await loadAdminAuthorityLiveActor(tx,actor,'system.manage');
        await assertAdminAuthorityOperationReady(tx);
        const result = await callback(tx,live); assertAdminAuthoritySession(actor); return result;
      });
    } catch (error) { return adminAuthorityWriteError(error); }
  }
  /** Only these owner-recovery methods use identity admission. This is not a
   * write-authority bypass: its callback is private and can only read a receipt
   * or seal an absent operation key, never apply a business mutation. */
  private async recovery<T>(actor: AdminAuthorityActor,callback: (tx: DbClient) => Promise<T>): Promise<T> {
    assertAdminAuthoritySession(actor);
    try {
      return await withTx(this.container,async tx => {
        await acquireAdminAuthorityWriteBarrier(tx);
        const [live] = await tx.select().from(systemAdmin).where(eq(systemAdmin.id,actor.id)).limit(1);
        if (!live || live.adminType !== 1 || live.relationId !== 0 || live.status !== 1 || live.isDel !== 0) {
          throw new AuthException('管理员已禁用或身份已变化',ApiErrorCode.ERR_BANNED);
        }
        if (!timingSafeEqual(new TextEncoder().encode(md5(live.pwd)),new TextEncoder().encode(actor.authVersion))) {
          throw new AuthException('登录凭据已变化',ApiErrorCode.ERR_EXPIRED);
        }
        await assertAdminAuthorityOperationReady(tx);
        assertAdminAuthoritySession(actor);
        const result = await callback(tx); assertAdminAuthoritySession(actor); return result;
      });
    } catch (error) { return adminAuthorityWriteError(error); }
  }
  private digest(domain: string, value: unknown): string {
    if (typeof this.appKey !== 'string' || !this.appKey) throw new ServiceUnavailableException('权限操作签名密钥尚未就绪');
    return createHmac('sha256',this.appKey).update(`cinashop.authority.${domain}.v1\0${canonical(value)}`).digest('hex');
  }
  private requestHash(input: Envelope,actorId: number): string {
    return this.digest('request',{ actorId,operationId:input.operationId,operation:input.operation,prepared:input.prepared });
  }
  private revision(input: Envelope,actor: AdminAuthorityActor,requestHash: string,expiresAt: number,proof: unknown): string {
    return this.digest('revision',{ operationId:input.operationId,operation:input.operation,actorId:actor.id,
      authVersion:actor.authVersion,tokenExpiresAt:actor.expiresAt,requestHash,expiresAt,proof });
  }
  async preview(value: unknown,actorInput: AdminAuthorityActor): Promise<AdminAuthorityPreview> {
    const input = envelope(value),actor = Object.freeze({ ...actorInput }); assertAdminAuthoritySession(actor);
    const requestHash = this.requestHash(input,actor.id);
    try {
      return await this.writeTransaction(actor,async (tx,live) => {
        const prior = await readReceipt(tx,input.operationId,actor.id,input.operation);
        if (prior) throw conflict('操作ID已有耐久结果，请先恢复原操作');
        const plan = await planAdminAuthorityWrite(tx,live,input.prepared),current = await decision(tx,live,plan);
        const expiresAt = Math.min(Math.floor(Date.now()/1000)+ADMIN_AUTHORITY_PREVIEW_TTL_SECONDS,actor.expiresAt);
        return { operation_id:input.operationId,actor_id:actor.id,operation:input.operation,request_hash:requestHash,
          revision:this.revision(input,actor,requestHash,expiresAt,current.proof),expires_at:expiresAt,
          summary:summary(plan),affected_accounts:current.affected,requires_confirmation:true };
      });
    } catch (error) { return capabilityError(error); }
  }
  async commit(value: unknown,actorInput: AdminAuthorityActor): Promise<AdminAuthorityReceipt> {
    const input = envelope(value,true),row = object(value),actor = Object.freeze({ ...actorInput }); assertAdminAuthoritySession(actor);
    if (row.confirmed !== true) throw new ValidateException('请明确确认本次权限变更');
    if (typeof row.revision !== 'string' || !/^[a-f0-9]{64}$/.test(row.revision) || typeof row.expires_at !== 'number'
      || !Number.isSafeInteger(row.expires_at)) throw new ValidateException('权限确认版本参数错误');
    const revision = row.revision,expiresAt = row.expires_at,requestHash = this.requestHash(input,actor.id);
    const passwordHash = input.prepared.password ? await bcrypt.hash(input.prepared.password,12) : undefined;
    try {
      return await this.writeTransaction(actor,async (tx,live) => {
        const prior = await readReceipt(tx,input.operationId,actor.id,input.operation);
        if (prior) {
          if (prior.state === 'not_applied') throw conflict('操作已封存为未执行，不能再提交');
          if (!equalHash(prior.requestHash,requestHash)) throw conflict('操作ID与原提交内容不一致');
          return receiptDto(prior);
        }
        const now = Math.floor(Date.now()/1000);
        if (expiresAt <= now || expiresAt > now+ADMIN_AUTHORITY_PREVIEW_TTL_SECONDS || expiresAt > actor.expiresAt) {
          throw conflict('权限确认已过期，请重新预览');
        }
        const plan = await planAdminAuthorityWrite(tx,live,input.prepared),current = await decision(tx,live,plan);
        if (!equalHash(revision,this.revision(input,actor,requestHash,expiresAt,current.proof))) throw conflict('权限或影响范围已变化，请重新预览');
        assertAdminAuthoritySession(actor);
        const saved = await applyAdminAuthorityWrite(tx,plan,passwordHash);
        const result: AdminAuthorityOperationResult = input.operation === 'role-delete' ? { id:saved.id,deleted:true } : saved;
        const receipt = await appendReceipt(tx,{ operationId:input.operationId,actorId:actor.id,adminType:1,relationId:0,
          operation:input.operation,requestHash,revision,state:'committed',result,createdAt:Math.floor(Date.now()/1000) });
        return receiptDto(receipt);
      });
    } catch (error) { return capabilityError(error); }
  }
  async receipt(operationIdInput: unknown,operationInput: unknown,actorInput: AdminAuthorityActor): Promise<AdminAuthorityReceipt> {
    const operationId = adminAuthorityOperationId(operationIdInput),operation = adminAuthorityOperationKind(operationInput),actor = Object.freeze({ ...actorInput });
    try {
      return await this.recovery(actor,async tx => {
        const row = await readReceipt(tx,operationId,actor.id,operation);
        return row ? receiptDto(row) : { operation_id:operationId,actor_id:actor.id,operation,state:'unknown',request_hash:null,result:null };
      });
    } catch (error) { return capabilityError(error); }
  }
  async resolve(value: unknown,actorInput: AdminAuthorityActor): Promise<AdminAuthorityReceipt> {
    const row = object(value); onlyFields(row,['operation_id','operation']);
    const operationId = adminAuthorityOperationId(row.operation_id),operation = adminAuthorityOperationKind(row.operation),actor = Object.freeze({ ...actorInput });
    try {
      return await this.recovery(actor,async tx => {
        const prior = await readReceipt(tx,operationId,actor.id,operation);
        if (prior) return receiptDto(prior);
        return receiptDto(await appendReceipt(tx,{ operationId,actorId:actor.id,adminType:1,relationId:0,operation,
          requestHash:'',revision:'',state:'not_applied',result:null,createdAt:Math.floor(Date.now()/1000) }));
      });
    } catch (error) { return capabilityError(error); }
  }
}
