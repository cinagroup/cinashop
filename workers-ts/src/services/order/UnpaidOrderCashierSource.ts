import { and, eq, inArray, sql } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { storeOrderStatus, type storeOrder, type storeOrderCartInfo } from '@/models/schema';
import { ServiceUnavailableException, ValidateException } from '@/utils/errors';
import { readCashierOrdinaryUnpaidOrigin } from './CashierOrdinaryOrigin';
import { assertCashierSecondCardUnpaidSource } from './CashierSecondCardOrigin';

/** Both sides of an order edit prove any actual cashier origin. Other order
 * creation realms acquire no new table prerequisite. No origin means no
 * authority is inferred from channel/product flags alone. */
export async function assertUnpaidOrderCashierEditSource(db:DbClient,order:typeof storeOrder.$inferSelect,
  carts:readonly typeof storeOrderCartInfo.$inferSelect[]):Promise<void>{
  const created=await db.select({id:storeOrderStatus.id,kind:storeOrderStatus.changeType}).from(storeOrderStatus).where(and(eq(storeOrderStatus.oid,order.id),
    inArray(storeOrderStatus.changeType,['customer_cashier_create','customer_ordinary_cashier_create']))).limit(2);
  if(created.length>1||created.length&&(order.isChannel!==2||order.staffId<=0||order.productType!==(created[0].kind==='customer_cashier_create'?4:0)))
    throw new ValidateException('收银原始创建类型或身份已变化');
  if(order.isChannel!==2||order.staffId<=0||![0,4].includes(order.productType))return;
  const relation=order.productType===4?'cashier_second_card_origin_v1':'cashier_ordinary_origin_v1';
  const [catalog]=await db.execute(sql`SELECT to_regclass(${'public.'+relation}) IS NOT NULL AS present`);
  if(catalog?.present!==true){if(created.length)throw new ServiceUnavailableException('收银创建来源维护协议缺失');return;}
  // The relation name comes from the fixed local dispatch above. Missing
  // SELECT is a real commissioning error, never an absent-origin success.
  const rows=await db.execute(sql`SELECT order_id FROM ${sql.raw('public.'+relation)} WHERE order_id=${order.id} LIMIT 2`);
  if(!rows.length){if(created.length)throw new ServiceUnavailableException('收银创建来源凭据缺失');return;}
  if(order.productType===4)await assertCashierSecondCardUnpaidSource(db,order,carts);
  else await readCashierOrdinaryUnpaidOrigin(db,order);
}
