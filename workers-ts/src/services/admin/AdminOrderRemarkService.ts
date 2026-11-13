import { and, asc, eq, getTableColumns, sql, type SQLWrapper } from 'drizzle-orm';
import type { Container } from '@/lib/di';
import { storeOrder, storeOrderStatus } from '@/models/schema';
import { HttpApiException, NotFoundException } from '@/utils/errors';
import { loadAdminAuthorityLiveActor, withAdminAuthorityWriteTx, type AdminAuthorityActor } from './AdminAuthorityWriteService';
import { parseAdminOrderPrimaryId } from './AdminMobileOrderReadService';
import { parseAdminOrderRemarkInput, parseAdminLegacyOrderRemarkValue } from './AdminOrderRemarkInput';

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const conflict = () => new HttpApiException('订单备注或审计记录已变化，请刷新后重试', 409, 409);
type Target = { kind: 'number'; orderId: string } | { kind: 'primary'; id: number };

// Preserve large historical content without fetching it into the Worker.
// NULL, byte length and the catalog SHA-256 function bind every text column.
const textFingerprint = (column: SQLWrapper) => sql<string | null>`
  CASE WHEN ${column} IS NULL THEN NULL ELSE octet_length(${column})::text || ':' ||
    pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(${column},'UTF8')),'hex') END`;
const orderColumns = { ...getTableColumns(storeOrder),
  cartId: textFingerprint(storeOrder.cartId), virtualInfo: textFingerprint(storeOrder.virtualInfo),
  customForm: textFingerprint(storeOrder.customForm), promotionsGive: textFingerprint(storeOrder.promotionsGive),
  giveCoupon: textFingerprint(storeOrder.giveCoupon), expressDump: textFingerprint(storeOrder.expressDump),
  refundReasonWapImg: textFingerprint(storeOrder.refundReasonWapImg),
};

export class AdminOrderRemarkService {
  constructor(private readonly container: Container) {}

  byNumber(actor: AdminAuthorityActor, body: Record<string, unknown>) {
    const input = parseAdminOrderRemarkInput(body);
    return this.commit(actor, { kind: 'number', orderId: input.orderId }, input.remark);
  }

  byPrimaryId(actor: AdminAuthorityActor, id: unknown, body: Record<string, unknown>) {
    return this.commit(actor, { kind: 'primary', id: parseAdminOrderPrimaryId(id) }, parseAdminLegacyOrderRemarkValue(body.remark));
  }

  private commit(actor: AdminAuthorityActor, target: Target, remark: string) {
    return withAdminAuthorityWriteTx(this.container, actor, 'order.manage', async tx => {
      // Number and primary-ID routes never fall back to one another, even for
      // a numeric order number. The selected row remains locked through audit.
      const rows = await tx.select(orderColumns).from(storeOrder).where(and(
        target.kind === 'number' ? eq(storeOrder.orderId, target.orderId) : eq(storeOrder.id, target.id),
        // PHP's primary-ID writer can annotate deleted history without
        // restoring it. Number-based modern/mobile paths remain active-only.
        ...(target.kind === 'number' ? [eq(storeOrder.isDel, 0), eq(storeOrder.isSystemDel, 0)] : []),
      )).orderBy(asc(storeOrder.id)).limit(2).for('update', { noWait: true }).catch(error => {
        let cause: unknown = error;
        for (let depth = 0; depth < 4 && cause && typeof cause === 'object'; depth++) {
          if ('code' in cause && String(cause.code) === '55P03')
            throw new HttpApiException('订单正在变更，请刷新后重试', 409, 409);
          cause = 'cause' in cause ? cause.cause : undefined;
        }
        throw error;
      });
      if (rows.length !== 1) throw new NotFoundException('订单不存在或编号不唯一');
      const current = rows[0];
      if (current.remark === remark) {
        await loadAdminAuthorityLiveActor(tx, actor, 'order.manage');
        return { changed: false };
      }
      const expected = { ...current, remark };
      const updated = await tx.update(storeOrder).set({ remark }).where(and(eq(storeOrder.id, current.id),
        eq(storeOrder.isDel, current.isDel), eq(storeOrder.isSystemDel, current.isSystemDel))).returning({ id: storeOrder.id });
      if (updated.length !== 1 || updated[0].id !== current.id) throw conflict();
      const auditValues = { oid: current.id, changeType: 'admin_order_remark',
        changeMessage: `管理员 ${actor.id} 更新订单备注`, changeTime: Math.floor(Date.now() / 1000) };
      const audits = await tx.insert(storeOrderStatus).values(auditValues).returning();
      if (audits.length !== 1 || Object.entries(auditValues).some(([key, value]) => audits[0][key as keyof typeof auditValues] !== value)) throw conflict();
      await tx.execute(sql`SET CONSTRAINTS ALL IMMEDIATE`);
      const [finalOrder] = await tx.select(orderColumns).from(storeOrder).where(eq(storeOrder.id, current.id));
      const [finalAudit] = await tx.select().from(storeOrderStatus).where(eq(storeOrderStatus.id, audits[0].id));
      if (!same(finalOrder, expected) || !same(finalAudit, audits[0])) throw conflict();
      await loadAdminAuthorityLiveActor(tx, actor, 'order.manage');
      return { changed: true };
    });
  }
}
