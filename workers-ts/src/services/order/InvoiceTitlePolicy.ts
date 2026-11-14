import { and, desc, eq, inArray } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { systemConfig, userInvoice, storeOrderInvoice } from '@/models/schema';
import { normalizeConfigScalar } from '@/utils/config';
import { checkoutFingerprint } from './CheckoutConfirmation';
import type { BuyerInvoiceCapabilities, BuyerInvoiceFields } from '../../../../view/common/buyerInvoices';

type Title = typeof userInvoice.$inferSelect;
export const invoiceTitleFields = (r: Title | typeof storeOrderInvoice.$inferSelect): BuyerInvoiceFields => ({
  headerType: r.headerType as 1 | 2, type: r.type as 1 | 2, name: r.name, dutyNumber: r.dutyNumber,
  drawerPhone: r.drawerPhone, email: r.email, tell: r.tell, address: r.address, bank: r.bank, cardNumber: r.cardNumber,
});
export const invoiceTitleRevision = (r: Title) => checkoutFingerprint({ ...invoiceTitleFields(r), id: r.id, uid: r.uid,
  isDefault: r.isDefault, isDel: r.isDel, addTime: r.addTime });

/** Global configuration and deterministic historical duplicate precedence shared
 * by existing-order applications and checkout. At most two bounded VARCHARs. */
export async function readInvoiceCapabilities(db: DbClient): Promise<BuyerInvoiceCapabilities> {
  const rows = await db.selectDistinctOn([systemConfig.menuName], { key: systemConfig.menuName, value: systemConfig.value }).from(systemConfig)
    .where(and(eq(systemConfig.isStore, 0), inArray(systemConfig.menuName, ['invoice_func_status', 'special_invoice_status'])))
    .orderBy(systemConfig.menuName, desc(systemConfig.sort), desc(systemConfig.id)).limit(2);
  const enabled = (key: string) => {
    const matches = rows.filter(r => r.key === key);
    return matches.length === 1 && normalizeConfigScalar(matches[0].value) === '1';
  };
  const on = enabled('invoice_func_status'); return { enabled: on, special: on && enabled('special_invoice_status') };
}
