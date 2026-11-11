/** User-approved rule: a platform label stays platform-wide; a store label
 * can be granted only in the order's actual financial store. Dispatch targets
 * and product echoes do not supply ownership authority. */
export interface PurchasedLabelCatalogRow { id: number; type: number; relationId: number; status: number }
export interface PurchasedLabelTarget { labelId: number; type: 0 | 1; relationId: number }
export interface PurchasedLabelSkipped { labelId: number; reason: 'missing' | 'retired' }
export interface PurchasedLabelSelection { targets: readonly PurchasedLabelTarget[]; skipped: readonly PurchasedLabelSkipped[] }
const valid = (value: unknown, zero = false): value is number => typeof value === 'number'
  && Number.isSafeInteger(value) && value >= (zero ? 0 : 1) && value <= 2147483647;
export function purchasedLabelSelection(ids: readonly number[], rows: readonly PurchasedLabelCatalogRow[], financialStoreId: number): PurchasedLabelSelection {
  if (!valid(financialStoreId, true) || ids.length > 10000 || rows.length > 10000
    || ids.some(id => !valid(id)) || new Set(ids).size !== ids.length) throw Error('购买标签选集须维护核对');
  const requested = new Set(ids), catalog = new Map<number, PurchasedLabelCatalogRow>();
  for (const row of rows) {
    if (!requested.has(row.id) || catalog.has(row.id) || !valid(row.relationId, true)
      || ![0, 1].includes(row.status)) throw Error('购买标签目录须维护核对');
    catalog.set(row.id, row);
  }
  const targets: PurchasedLabelTarget[] = [], skipped: PurchasedLabelSkipped[] = [];
  for (const id of [...ids].sort((a, b) => a - b)) {
    const row = catalog.get(id);
    // As with the existing paid promotion effect, a deliberately retired or
    // removed label is not recreated by a later asynchronous task.
    if (!row || row.status === 0) { skipped.push({ labelId: id, reason: row ? 'retired' : 'missing' }); continue; }
    if (row.type === 0 && row.relationId === 0) targets.push({ labelId: id, type: 0, relationId: 0 });
    else if (row.type === 1 && financialStoreId > 0 && row.relationId === financialStoreId)
      targets.push({ labelId: id, type: 1, relationId: financialStoreId });
    else throw Error('购买标签归属与实际财务门店不匹配，须维护核对');
  }
  return { targets: Object.freeze(targets.map(row => Object.freeze(row))), skipped: Object.freeze(skipped.map(row => Object.freeze(row))) };
}
