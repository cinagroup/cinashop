import { sql, eq } from 'drizzle-orm';
import type { Container, DbClient } from '@/lib/di';
import type { Env } from '@/env';
import { systemAdmin, storeOrderStatus } from '@/models/schema';
import { assertPurchasedLabelRuntimeTx, type PurchasedLabelRuntimePurpose } from '@/migrations/purchasedProductLabelRuntime';
import { NotFoundException, ServiceUnavailableException, ValidateException } from '@/utils/errors';
import { emitOperationalEvent, operationalErrorCode } from '@/utils/observability';
import { purchasedLabelRuntimeFromEnv, type PurchasedLabelRuntimeDeclaration } from './PurchasedProductLabelRuntimeDeclaration';
import { capturePurchasedProductLabelMessage, purchasedLabelUuid, type PurchasedProductLabelMessage } from './PurchasedProductLabelQueue';
import { capturePurchasedLabelResult } from './PurchasedProductLabelResult';
import { readPurchasedLabelIntent, verifyPurchasedLabelIntent, type PurchasedLabelIntentRow } from './PurchasedProductLabelSource';
import { grantPurchasedProductLabelsTx } from './PurchasedProductLabelGrant';

type Environment = Pick<Env, 'ORDER_QUEUE'> & Partial<Pick<Env, 'PURCHASED_PRODUCT_LABEL_RUNTIME'>>;
interface State { taskId: string; status: string; attemptCount: number; dispatchCount: number; replayCount: number;
  availableAt: number; leaseUntil: number; leaseToken: string; processedAt: number }
interface Claim { row: PurchasedLabelIntentRow; token: string }
type ProcessResult = 'completed' | 'already-completed' | 'busy' | 'dead' | 'not-found';
export const PURCHASED_LABEL_MAX_ATTEMPTS = 8, PURCHASED_LABEL_PROCESS_LEASE = 120, PURCHASED_LABEL_DELIVERY_LEASE = 600;
const delay = (attempt: number) => Math.min(30 * 2 ** Math.max(0, attempt-1), 3600);
const statuses = ['PENDING', 'ENQUEUING', 'ENQUEUED', 'PROCESSING', 'FAILED', 'DEAD', 'COMPLETED'];
async function time(tx: DbClient) {
  const [row] = await tx.execute<{ now: number }>(sql`SELECT floor(extract(epoch FROM clock_timestamp()))::integer AS now`);
  if (!row || !Number.isSafeInteger(row.now) || row.now <= 0) throw Error('购买标签数据库时间无效'); return row.now;
}
async function state(tx: DbClient, taskId: string, locked = false) {
  const [row] = await tx.execute<State & Record<string, unknown>>(sql`SELECT task_id::text AS "taskId",status,attempt_count AS "attemptCount",
    dispatch_count AS "dispatchCount",replay_count AS "replayCount",available_at AS "availableAt",lease_until AS "leaseUntil",lease_token AS "leaseToken",
    processed_at AS "processedAt" FROM public.purchased_product_label_state WHERE task_id=${taskId}::uuid ${sql.raw(locked ? 'FOR UPDATE SKIP LOCKED' : '')}`);
  return row;
}
async function receipt(tx: DbClient, row: PurchasedLabelIntentRow) {
  const [r] = await tx.execute<{ sourceHash: string; result: unknown; completedAt: number }>(sql`SELECT source_hash AS "sourceHash",result,completed_at AS "completedAt"
    FROM public.purchased_product_label_result WHERE task_id=${row.taskId}::uuid`);
  if (!r) return undefined;
  if (r.sourceHash !== row.sourceHash) throw Error('购买标签回执来源冲突');
  const intent = await verifyPurchasedLabelIntent(row), result = capturePurchasedLabelResult(r.result, intent, row.taskId, row.sourceHash);
  if (r.completedAt !== result.completedAt) throw Error('购买标签回执完成时间冲突'); return result;
}
export class PurchasedProductLabelTaskService {
  private readonly declaration: PurchasedLabelRuntimeDeclaration | undefined;
  constructor(private readonly container: Container, private readonly env: Environment) { this.declaration = purchasedLabelRuntimeFromEnv(env); }
  private async transaction<T>(purpose: PurchasedLabelRuntimePurpose, work: (tx: DbClient) => Promise<T>): Promise<T> {
    const declaration = this.declaration;
    if (!declaration) throw new ServiceUnavailableException('购买标签运行声明尚未配置');
    return this.container.db.transaction(async raw => {
      const tx = raw as unknown as DbClient; await assertPurchasedLabelRuntimeTx(tx, declaration.target, purpose); return work(tx);
    }, { isolationLevel: purpose === 'read' ? 'repeatable read' : 'read committed',
      accessMode: purpose === 'read' ? 'read only' : 'read write' });
  }
  private async claim(message: Readonly<PurchasedProductLabelMessage>): Promise<Claim | ProcessResult> {
    return this.transaction('claim', async tx => {
      const row = await readPurchasedLabelIntent(tx, message.taskId);
      if (!row) return 'not-found';
      if (row.eventKey !== message.eventKey) throw new ValidateException('购买标签任务引用不匹配');
      await verifyPurchasedLabelIntent(row);
      const s = await state(tx, row.taskId, true);
      if (!s) { if (await state(tx, row.taskId)) return 'busy'; throw Error('购买标签任务状态缺失'); }
      const now = await time(tx), prior = await receipt(tx, row);
      // The immutable success receipt wins even after a mutable state replay.
      // No live source/config/catalog/member reads occur on this path.
      if (prior) {
        if (s.status !== 'COMPLETED') await tx.execute(sql`UPDATE public.purchased_product_label_state SET status='COMPLETED',
          lease_until=0,lease_token='',last_error='',processed_at=${prior.completedAt},updated_at=${now} WHERE task_id=${row.taskId}::uuid`);
        return 'already-completed';
      }
      if (s.status === 'COMPLETED') throw Error('购买标签完成状态缺少不可变回执');
      if (s.status === 'DEAD') return 'dead';
      if (s.availableAt > now || s.status === 'PROCESSING' && s.leaseUntil >= now) return 'busy';
      if (s.attemptCount >= PURCHASED_LABEL_MAX_ATTEMPTS) {
        await tx.execute(sql`UPDATE public.purchased_product_label_state SET status='DEAD',lease_until=0,lease_token='',updated_at=${now} WHERE task_id=${row.taskId}::uuid`);
        return 'dead';
      }
      const token = crypto.randomUUID();
      await tx.execute(sql`UPDATE public.purchased_product_label_state SET status='PROCESSING',attempt_count=attempt_count+1,
        lease_until=${now+PURCHASED_LABEL_PROCESS_LEASE},lease_token=${token},updated_at=${now} WHERE task_id=${row.taskId}::uuid`);
      return { row, token };
    });
  }
  async process(input: unknown): Promise<ProcessResult> {
    const message = capturePurchasedProductLabelMessage(input), claim = await this.claim(message);
    if (typeof claim === 'string') return claim;
    try {
      return await this.transaction('consume', async tx => {
        const row = await readPurchasedLabelIntent(tx, message.taskId), s = await state(tx, message.taskId, true), now = await time(tx);
        if (!row || row.eventKey !== message.eventKey || row.sourceHash !== claim.row.sourceHash) throw Error('购买标签任务来源已改变');
        const prior = await receipt(tx, row);
        if (prior) return 'already-completed';
        if (!s || s.status !== 'PROCESSING' || s.leaseToken !== claim.token || s.leaseUntil < now) throw Error('购买标签处理租约已失效');
        const intent = await verifyPurchasedLabelIntent(row);
        const result = await grantPurchasedProductLabelsTx(tx, intent, row.taskId, row.sourceHash, now);
        await tx.execute(sql`INSERT INTO public.purchased_product_label_result(task_id,source_hash,result,completed_at)
          VALUES(${row.taskId}::uuid,${row.sourceHash},${JSON.stringify(result)}::jsonb,${now})`);
        const completed = await tx.execute(sql`UPDATE public.purchased_product_label_state SET status='COMPLETED',lease_until=0,
          lease_token='',last_error='',processed_at=${now},updated_at=${now}
          WHERE task_id=${row.taskId}::uuid AND status='PROCESSING' AND lease_token=${claim.token} RETURNING task_id`);
        if (completed.length !== 1) throw Error('购买标签原子完成状态写入失败');
        return 'completed';
      });
    } catch (error) {
      try {
        await this.transaction('claim', async tx => {
          const s = await state(tx, message.taskId, true);
          if (!s || s.status !== 'PROCESSING' || s.leaseToken !== claim.token || await receipt(tx, claim.row)) return;
          const now = await time(tx), terminal = s.attemptCount >= PURCHASED_LABEL_MAX_ATTEMPTS;
          await tx.execute(sql`UPDATE public.purchased_product_label_state SET status=${terminal ? 'DEAD' : 'FAILED'},
            available_at=${now+delay(s.attemptCount)},lease_until=0,lease_token='',last_error='购买标签处理失败，请核对来源、归属或配置',updated_at=${now}
            WHERE task_id=${message.taskId}::uuid AND status='PROCESSING' AND lease_token=${claim.token}`);
        });
      } catch (cause) { emitOperationalEvent('error', { event: 'purchased_product_labels_failure_record_failed', component: 'queue',
        operation: 'outbox_consume', outcome: 'failure', errorCode: operationalErrorCode(cause) }); }
      throw error;
    }
  }
  /** Claim in SQL, commit, then send a reference only. An ambiguous send is
   * recovered by availability/lease expiry; it never restarts paid effects. */
  async dispatchPending(limit = 20, taskId?: string, paymentEventId?: number) {
    if (!this.declaration) return { claimed: 0, enqueued: 0 };
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || taskId !== undefined && !purchasedLabelUuid(taskId)
      || paymentEventId !== undefined && (!Number.isSafeInteger(paymentEventId) || paymentEventId <= 0)) throw new ValidateException('购买标签派发范围无效');
    const claims = await this.transaction('dispatch', async tx => {
      const now = await time(tx);
      const rows = await tx.execute<{ taskId: string; eventKey: string; dispatchCount: number; attemptCount: number }>(sql`SELECT
        s.task_id::text AS "taskId",i.event_key AS "eventKey",s.dispatch_count AS "dispatchCount",s.attempt_count AS "attemptCount"
        FROM public.purchased_product_label_state s JOIN public.purchased_product_label_intent i ON i.task_id=s.task_id
        JOIN public.store_order_outbox p ON p.id=i.payment_event_id WHERE p.status='COMPLETED' AND s.available_at<=${now}
        AND (s.status IN('PENDING','FAILED') OR s.status IN('ENQUEUING','ENQUEUED','PROCESSING') AND s.lease_until<${now})
        ${taskId ? sql`AND s.task_id=${taskId}::uuid` : sql``} ${paymentEventId ? sql`AND i.payment_event_id=${paymentEventId}` : sql``}
        ORDER BY s.available_at,s.task_id LIMIT ${limit} FOR UPDATE OF s SKIP LOCKED`);
      const result: Array<{ message: Readonly<PurchasedProductLabelMessage>; token: string; count: number }> = [];
      for (const row of rows) {
        if (row.attemptCount >= PURCHASED_LABEL_MAX_ATTEMPTS || row.dispatchCount >= PURCHASED_LABEL_MAX_ATTEMPTS) {
          await tx.execute(sql`UPDATE public.purchased_product_label_state SET status='DEAD',lease_until=0,lease_token='',updated_at=${now} WHERE task_id=${row.taskId}::uuid`); continue;
        }
        const token = crypto.randomUUID(), message = capturePurchasedProductLabelMessage({ action: 'processPurchasedProductLabels', taskId: row.taskId, eventKey: row.eventKey });
        await tx.execute(sql`UPDATE public.purchased_product_label_state SET status='ENQUEUING',dispatch_count=dispatch_count+1,
          lease_until=${now+PURCHASED_LABEL_DELIVERY_LEASE},lease_token=${token},updated_at=${now} WHERE task_id=${row.taskId}::uuid`);
        result.push({ message, token, count: row.dispatchCount+1 });
      }
      return result;
    });
    let enqueued = 0;
    for (const c of claims) {
      try {
        await this.env.ORDER_QUEUE.send(c.message);
        await this.transaction('dispatch', async tx => {
          const now = await time(tx);
          await tx.execute(sql`UPDATE public.purchased_product_label_state SET status='ENQUEUED',lease_token='',last_error='',
            lease_until=${now+PURCHASED_LABEL_DELIVERY_LEASE},updated_at=${now} WHERE task_id=${c.message.taskId}::uuid AND status='ENQUEUING' AND lease_token=${c.token}`);
        });
        enqueued++;
      } catch (error) {
        await this.transaction('dispatch', async tx => {
          const now = await time(tx);
          await tx.execute(sql`UPDATE public.purchased_product_label_state SET status=${c.count >= PURCHASED_LABEL_MAX_ATTEMPTS ? 'DEAD' : 'FAILED'},
            available_at=${now+delay(c.count)},lease_until=0,lease_token='',last_error='购买标签 Queue 派发未确认',updated_at=${now}
            WHERE task_id=${c.message.taskId}::uuid AND status='ENQUEUING' AND lease_token=${c.token}`);
        });
        emitOperationalEvent('warn', { event: 'purchased_product_labels_dispatch_failed', component: 'queue', operation: 'outbox_consume',
          outcome: 'retry', errorCode: operationalErrorCode(error) });
      }
    }
    return { claimed: claims.length, enqueued };
  }
  async list(query: { status?: string; afterId?: string; limit?: number } = {}) {
    const limit = query.limit ?? 50;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || query.status !== undefined && !statuses.includes(query.status)
      || query.afterId !== undefined && !purchasedLabelUuid(query.afterId)) throw new ValidateException('购买标签查询范围无效');
    return this.transaction('read', async tx => {
      const rows = await tx.execute(sql`SELECT i.task_id::text AS "taskId",i.event_key AS "eventKey",i.order_id AS "orderId",i.customer_uid AS "userId",
        i.created_at AS "createdAt",s.status,s.attempt_count AS "attemptCount",s.dispatch_count AS "dispatchCount",s.replay_count AS "replayCount",
        s.available_at AS "availableAt",s.processed_at AS "processedAt",s.last_error AS "lastError",r.completed_at AS "receiptCompletedAt"
        FROM public.purchased_product_label_intent i JOIN public.purchased_product_label_state s ON s.task_id=i.task_id
        LEFT JOIN public.purchased_product_label_result r ON r.task_id=i.task_id WHERE true
        ${query.status ? sql`AND s.status=${query.status}` : sql``} ${query.afterId ? sql`AND i.task_id>${query.afterId}::uuid` : sql``}
        ORDER BY i.task_id LIMIT ${limit+1}`);
      const items = rows.slice(0, limit);
      return { items, nextAfterId: rows.length > limit ? items[items.length-1]?.taskId : null };
    });
  }
  /** Also used inside the existing authenticated DLQ replay transaction. */
  async replayInTransaction(tx: DbClient, taskId: string, operatorId: number, reasonInput: unknown) {
    const declaration = this.declaration;
    if (!declaration) throw new ServiceUnavailableException('购买标签运行声明尚未配置');
    if (!purchasedLabelUuid(taskId) || !Number.isSafeInteger(operatorId) || operatorId <= 0 || operatorId > 2147483647 || typeof reasonInput !== 'string') throw new ValidateException('购买标签重放确认无效');
    const reason = reasonInput.trim();
    if (!reason || Array.from(reason).length > 100 || /[\u0000-\u001f\u007f]/u.test(reason)) throw new ValidateException('购买标签重放说明须为1至100个字符');
    await assertPurchasedLabelRuntimeTx(tx, declaration.target, 'replay');
    const [admin] = await tx.select({ id: systemAdmin.id, status: systemAdmin.status, isDel: systemAdmin.isDel, adminType: systemAdmin.adminType }).from(systemAdmin).where(eq(systemAdmin.id, operatorId)).limit(1);
    if (!admin || admin.status !== 1 || admin.isDel !== 0 || admin.adminType !== 1) throw new ValidateException('购买标签重放管理员已失效');
    const row = await readPurchasedLabelIntent(tx, taskId), s = await state(tx, taskId, true);
    if (!row) throw new NotFoundException('购买标签任务不存在');
    if (!s) throw new ValidateException('购买标签任务正在处理或状态缺失');
    await verifyPurchasedLabelIntent(row);
    if (await receipt(tx, row)) return { taskId, eventKey: row.eventKey, replayed: false, completed: true };
    const now = await time(tx);
    if (s.status === 'COMPLETED') throw new ValidateException('购买标签完成状态缺少回执，请先维护核对');
    if (s.status === 'PENDING') return { taskId, eventKey: row.eventKey, replayed: false, completed: false };
    if (!['FAILED', 'DEAD', 'PROCESSING', 'ENQUEUING', 'ENQUEUED'].includes(s.status) || s.leaseUntil >= now)
      throw new ValidateException('购买标签任务租约仍有效');
    if (s.replayCount >= 20) throw new ValidateException('购买标签人工重放次数已达上限');
    await tx.execute(sql`UPDATE public.purchased_product_label_state SET status='PENDING',attempt_count=0,dispatch_count=0,replay_count=replay_count+1,
      available_at=${now},lease_until=0,lease_token='',last_error='',processed_at=0,updated_at=${now} WHERE task_id=${taskId}::uuid`);
    await tx.insert(storeOrderStatus).values({ oid: row.orderId, changeType: 'product_label_replay',
      changeMessage: `管理员${operatorId}重放购买标签任务${taskId}：${reason}`, changeTime: now });
    return { taskId, eventKey: row.eventKey, replayed: true, completed: false };
  }
  async replay(taskId: string, operatorId: number, reason: unknown) {
    const result = await this.transaction('replay', tx => this.replayInTransaction(tx, taskId, operatorId, reason));
    if (!result.completed) await this.dispatchPending(1, taskId);
    return result;
  }
}
