import { SQL, sql } from 'drizzle-orm';
import { getTableConfig, PgDialect } from 'drizzle-orm/pg-core';
import { storeOrderInvoice, userInvoice } from '@/models/schema';
import { supplierOrderReviewFixture } from './supplierOrderReview';

export const supplierInvoiceFields = {
  type: 1, headerType: 2, name: '冻结发票抬头', dutyNumber: 'FROZEN-TAX-ONLY', email: 'frozen@example.invalid',
  bank: '冻结开户银行', address: '冻结企业地址12号', drawerPhone: '01012345678',
} as const;
/** Synthetic display/history cases. Real checkout/application/split authority is
 * covered separately by the actual registered runtime fixture in native tests. */
export async function supplierOrderInvoiceReviewFixture() {
  const f = await supplierOrderReviewFixture();
  try {
    const definition = getTableConfig(userInvoice), dialect = new PgDialect();
    const columns = definition.columns.map(column => {
      const initial = column.default === undefined ? '' : ` DEFAULT ${column.default instanceof SQL
        ? dialect.sqlToQuery(column.default).sql : dialect.sqlToQuery(sql`${column.default}`.inlineParams()).sql}`;
      return `"${column.name}" ${column.getSQLType()}${initial}${column.notNull ? ' NOT NULL' : ''}${column.primary ? ' PRIMARY KEY' : ''}`;
    });
    await f.exec(`CREATE TABLE public."${definition.name}" (${columns.join(',')})`);
    await f.db.insert(userInvoice).values({ id: 1, uid: 11, ...supplierInvoiceFields, name: '当前可变发票模板',
      cardNumber: 'PRIVATE-TEMPLATE-CARD', tell: 'PRIVATE-TEMPLATE-TELL' });
    const row = (id: number, orderId: number, invoiceAmount: string, changes: Partial<typeof storeOrderInvoice.$inferInsert> = {}) => ({
      id, uid: 11, orderId, category: 'order', invoiceId: 1, ...supplierInvoiceFields, invoiceAmount,
      isPay: 1, isInvoice: 0, cardNumber: 'PRIVATE-FROZEN-CARD', tell: 'PRIVATE-FROZEN-TELL', ...changes });
    await f.db.insert(storeOrderInvoice).values([
      row(501, 100, '63.00'), row(502, 200, '63.00', { isDel: 1 }), row(503, 201, '31.50'),
      row(504, 300, '63.00', { name: 'PRIVATE-PLATFORM-ROOT-TAX' }), row(505, 110, '12.00', { uid: 12, name: 'PRIVATE-FOREIGN-TAX' }),
    ]);
    // Explicit IDs above must not collide with later maintenance test inserts.
    await f.exec("SELECT setval(pg_get_serial_sequence('public.store_order_invoice','id'),505,true)");
    return { ...f, invoiceIds: { single: 501, archivedRoot: 502, child: 503, platformRoot: 504, invalid: 505 },
      expectedInvoice: { id: 501, order_id: 100, archived: false, type: 1, header_type: 2,
        name: supplierInvoiceFields.name, duty_number: supplierInvoiceFields.dutyNumber,
        email: supplierInvoiceFields.email, bank: supplierInvoiceFields.bank, address: supplierInvoiceFields.address,
        drawer_phone: supplierInvoiceFields.drawerPhone, recorded_amount: '63.00', issuance_state: 0 } };
  } catch (error) { await f.close(); throw error; }
}
