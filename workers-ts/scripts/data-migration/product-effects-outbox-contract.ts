import type { CatalogRow } from './postgres-catalog-audit';
import { PINK_SUCCESS_NOTICE_CHECK_DEFINITION } from '../../src/migrations/pinkSuccessNotice';
import { PRODUCT_STOCK_EFFECTS_CHECK_DEFINITION, PRODUCT_STOCK_EFFECTS_EVENTS } from '../../src/migrations/productStockEffects';
import { PRODUCT_RECYCLE_EFFECTS_CHECK_DEFINITION, PRODUCT_RECYCLE_EFFECTS_EVENTS } from '../../src/migrations/productRecycleEffects';
import { PRODUCT_SAVE_EFFECTS_CHECK_DEFINITION, PRODUCT_SAVE_EFFECTS_EVENTS } from '../../src/migrations/productSaveEffects';
import { PRESALE_OUTBOX_CHECK_KEY } from './presale-outbox-contract';

const expression = 'IN (\n' + PRODUCT_SAVE_EFFECTS_EVENTS.map(event => `      '${event}'`).join(',\n') + '\n    )';

/** Preserve the reviewed eleven-event history; apply each exact successor in order. */
export const PRODUCT_EFFECTS_OUTBOX_STAGES = [
  { migration: '0175_product_stock_effects.sql', previousDefinition: PINK_SUCCESS_NOTICE_CHECK_DEFINITION,
    definition: PRODUCT_STOCK_EFFECTS_CHECK_DEFINITION, events: PRODUCT_STOCK_EFFECTS_EVENTS },
  { migration: '0177_product_recycle_effects.sql', previousDefinition: PRODUCT_STOCK_EFFECTS_CHECK_DEFINITION,
    definition: PRODUCT_RECYCLE_EFFECTS_CHECK_DEFINITION, events: PRODUCT_RECYCLE_EFFECTS_EVENTS },
  { migration: '0178_product_save_effects.sql', previousDefinition: PRODUCT_RECYCLE_EFFECTS_CHECK_DEFINITION,
    definition: PRODUCT_SAVE_EFFECTS_CHECK_DEFINITION, events: PRODUCT_SAVE_EFFECTS_EVENTS },
] as const;
export const PRODUCT_EFFECTS_OUTBOX_CHECK_SNAPSHOT = { name: 'soob_event_type_ck', value: '"store_order_outbox"."event_type" ' + expression };
export const PRODUCT_EFFECTS_OUTBOX_MODEL_DECLARATION = 'check("soob_event_type_ck", sql' + String.fromCharCode(96)
  + '${t.eventType} ' + expression + String.fromCharCode(96) + ')';

export function withProductEffectsOutboxContract<T extends { entries: Array<{ key: string; catalog: CatalogRow }> }>(manifest: T): T {
  const entries = manifest.entries.filter(entry => entry.key === PRESALE_OUTBOX_CHECK_KEY);
  if (entries.length !== 1 || entries[0].catalog.definition !== PINK_SUCCESS_NOTICE_CHECK_DEFINITION)
    throw Error('Product effects forward contract requires the exact prior eleven-event CHECK');
  const current = structuredClone(manifest);
  current.entries.find(entry => entry.key === PRESALE_OUTBOX_CHECK_KEY)!.catalog.definition = PRODUCT_SAVE_EFFECTS_CHECK_DEFINITION;
  return current;
}
