import { and, asc, eq, gt, lte, lt, or, sql } from 'drizzle-orm';
import { withTx, type Container, type DbClient } from '@/lib/di';
import { storeProduct } from '@/models/schema';
import type { Env, OrderMessage, ScheduledMaintenanceMessage, ProductAutoShelfScanMessage, ProductAutoShelfMessage } from '@/env';
import { boundBargainSourceProductChange, lockBargainSourceProductChange } from '@/services/activity/BargainSourceProductLifecycle';
import { tryLockProductWrite } from './ProductAssociationService';
import { HttpApiException } from '@/utils/errors';

export const PRODUCT_AUTO_SHELF_PAGE_SIZE = 80;
const maximum = 2_147_483_647;
type Product = typeof storeProduct.$inferSelect;
const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= maximum;
function root(value: unknown): value is Record<string, unknown> & { scheduledAt: number; runId: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return row.job === 'product_auto_shelf' && typeof row.scheduledAt === 'number' && Number.isSafeInteger(row.scheduledAt)
    && row.scheduledAt > 0 && row.scheduledAt <= maximum * 1000 && row.runId === `scheduled:${row.scheduledAt}`;
}
export function isProductAutoShelfScanMessage(value: unknown): value is ProductAutoShelfScanMessage {
  return root(value) && Object.keys(value).length === 8 && value.action === 'scanProductAutoShelf'
    && (value.phase === 'on' || value.phase === 'off') && integer(value.maximumId) && integer(value.cursorTime)
    && integer(value.cursorId) && value.cursorId <= value.maximumId;
}
export function isProductAutoShelfMessage(value: unknown): value is ProductAutoShelfMessage {
  return root(value) && Object.keys(value).length === 5 && value.action === 'processProductAutoShelf'
    && integer(value.productId) && value.productId > 0;
}
/** The PHP timer executes all due ons, then offs. For a product with both due,
 * this is a single atomic final-state write, including a possible 0->1->0.
 * It deliberately does not clear schedules or rewrite carts/relations. */
export function planProductAutoShelf(product: Product, cutoff: number): { isShow: number; transitions: Array<'on' | 'off'> } {
  if (!integer(cutoff)) throw Error('Invalid product schedule cutoff');
  let isShow = product.isShow;
  const transitions: Array<'on' | 'off'> = [];
  if (product.isDel !== 0) return { isShow, transitions };
  if (isShow === 0 && product.autoOnTime > 0 && product.autoOnTime <= cutoff) { isShow = 1; transitions.push('on'); }
  if (isShow === 1 && product.autoOffTime > 0 && product.autoOffTime < cutoff) { isShow = 0; transitions.push('off'); }
  return { isShow, transitions };
}
function owner(product: Product): boolean {
  return product.type === 0 && product.relationId === 0 || [1, 2].includes(product.type) && Number.isSafeInteger(product.relationId) && product.relationId > 0;
}
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
async function clock(tx: DbClient, cutoff: number): Promise<number> {
  const [row] = await tx.execute(sql`SELECT floor(extract(epoch FROM clock_timestamp()))::bigint AS now`) as unknown as Array<{ now: string | number }>;
  if (!row || !integer(Number(row.now)) || Number(row.now) < cutoff) throw Error('Product schedule is ahead of database clock');
  return Number(row.now);
}

export class ProductAutoShelfService {
  constructor(private readonly container: Container, private readonly env: Pick<Env, 'ORDER_QUEUE'>) {}

  async start(message: ScheduledMaintenanceMessage): Promise<Record<string, unknown>> {
    if (!root(message) || message.action !== 'runScheduledMaintenance' || Object.keys(message).length !== 6 || message.cursor !== 0 || message.threshold !== null) throw Error('Invalid product schedule root');
    const cutoff = Math.floor(message.scheduledAt / 1000);
    const maximumId = await withTx(this.container, async tx => {
      await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
      await tx.execute(sql`SET LOCAL statement_timeout='5s'`); await clock(tx, cutoff);
      const [row] = await tx.select({ id: sql<number>`coalesce(max(${storeProduct.id}),0)` }).from(storeProduct);
      if (!integer(row?.id)) throw Error('Product schedule maximum invalid'); return row.id;
    });
    if (maximumId) await this.send((['on', 'off'] as const).map(phase => ({ action: 'scanProductAutoShelf', job: 'product_auto_shelf', runId: message.runId,
      scheduledAt: message.scheduledAt, phase, maximumId, cursorTime: 0, cursorId: 0 })));
    return { event: 'scheduled_product_shelf_started', job: message.job, runId: message.runId, maximumId, scans: maximumId ? 2 : 0 };
  }

  async scan(message: ProductAutoShelfScanMessage): Promise<Record<string, unknown>> {
    if (!isProductAutoShelfScanMessage(message)) throw Error('Invalid product schedule scan');
    const cutoff = Math.floor(message.scheduledAt / 1000), time = message.phase === 'on' ? storeProduct.autoOnTime : storeProduct.autoOffTime;
    const rows = await withTx(this.container, async tx => {
      await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
      await tx.execute(sql`SET LOCAL statement_timeout='5s'`); await clock(tx, cutoff);
      return tx.select({ id: storeProduct.id, time }).from(storeProduct).where(and(
        eq(storeProduct.isDel, 0), eq(storeProduct.isShow, message.phase === 'on' ? 0 : 1), gt(time, 0),
        message.phase === 'on' ? lte(time, cutoff) : lt(time, cutoff), lte(storeProduct.id, message.maximumId),
        or(gt(time, message.cursorTime), and(eq(time, message.cursorTime), gt(storeProduct.id, message.cursorId))),
      )).orderBy(asc(time), asc(storeProduct.id)).limit(PRODUCT_AUTO_SHELF_PAGE_SIZE + 1);
    });
    const page = rows.slice(0, PRODUCT_AUTO_SHELF_PAGE_SIZE), last = page.at(-1), hasMore = rows.length > PRODUCT_AUTO_SHELF_PAGE_SIZE;
    const messages: OrderMessage[] = page.map(row => ({ action: 'processProductAutoShelf', job: 'product_auto_shelf', runId: message.runId, scheduledAt: message.scheduledAt, productId: row.id }));
    if (hasMore && last) messages.push({ ...message, cursorTime: last.time, cursorId: last.id });
    await this.send(messages);
    return { event: 'scheduled_product_shelf_scan', job: message.job, runId: message.runId, phase: message.phase, candidates: page.length, hasMore };
  }

  async process(message: ProductAutoShelfMessage): Promise<Record<string, unknown>> {
    if (!isProductAutoShelfMessage(message)) throw Error('Invalid product schedule work');
    const cutoff = Math.floor(message.scheduledAt / 1000);
    return withTx(this.container, async tx => {
      await boundBargainSourceProductChange(tx); await clock(tx, cutoff);
      // Must precede the product fence and row lock, just as current visibility
      // and moderation writers do, to avoid a bargain-admission lock cycle.
      await lockBargainSourceProductChange(tx, message.productId);
      if (!await tryLockProductWrite(tx, message.productId)) throw new HttpApiException('商品正在编辑', 409, 409);
      const [product] = await tx.select().from(storeProduct).where(eq(storeProduct.id, message.productId)).limit(1).for('update', { noWait: true });
      if (!product || product.isDel !== 0) return { event: 'scheduled_product_shelf_skipped', productId: message.productId, reason: 'no_longer_eligible' };
      if (!owner(product)) throw Error('Product schedule owner invalid');
      // Delivery may be out of order across minute roots. A stale root must
      // never reopen a product already closed by a newer due-off run. Decide
      // using current DB time AFTER acquiring the product row, as PHP's live
      // timer does; only the bounded scan retains its original cutoff.
      const appliedAt = await clock(tx, cutoff);
      const plan = planProductAutoShelf(product, appliedAt);
      if (!plan.transitions.length) return { event: 'scheduled_product_shelf_skipped', productId: message.productId, reason: 'no_longer_eligible' };
      const expected = { ...product, isShow: plan.isShow };
      const changed = await tx.update(storeProduct).set({ isShow: plan.isShow }).where(eq(storeProduct.id, product.id)).returning();
      if (changed.length !== 1 || !same(changed[0], expected)) throw Error('Product schedule full write receipt inconsistent');
      const [read] = await tx.select().from(storeProduct).where(eq(storeProduct.id, product.id)).limit(1);
      if (!same(read, expected)) throw Error('Product schedule full readback inconsistent');
      await clock(tx, cutoff);
      return { event: 'scheduled_product_shelf_processed', productId: product.id, isShow: plan.isShow, transitions: plan.transitions, appliedAt };
    });
  }

  private async send(messages: OrderMessage[]): Promise<void> {
    if (messages.length) await this.env.ORDER_QUEUE.sendBatch(messages.map(body => ({ body, contentType: 'json' as const })));
  }
}
