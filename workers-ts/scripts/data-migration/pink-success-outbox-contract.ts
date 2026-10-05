import type { CatalogRow } from './postgres-catalog-audit';
import { PINK_SUCCESS_NOTICE_CHECK_DEFINITION, PINK_SUCCESS_NOTICE_EVENTS } from '../../src/migrations/pinkSuccessNotice';
import { PRESALE_OUTBOX_CHECK_KEY, PRESALE_OUTBOX_CHECK_DEFINITION } from './presale-outbox-contract';
const expression = 'IN (\n' + PINK_SUCCESS_NOTICE_EVENTS.map(event => `      '${event}'`).join(',\n') + '\n    )';
export const PINK_SUCCESS_OUTBOX_CHECK_SNAPSHOT = { name: 'soob_event_type_ck', value: '"store_order_outbox"."event_type" ' + expression };
export const PINK_SUCCESS_OUTBOX_MODEL_DECLARATION = 'check("soob_event_type_ck", sql' + String.fromCharCode(96)
  + '${t.eventType} ' + expression + String.fromCharCode(96) + ')';

/** Forward overlay after the preserved nine -> ten-event presale contract. */
export function withPinkSuccessOutboxContract<T extends { entries: Array<{ key: string; catalog: CatalogRow }> }>(manifest: T): T {
  const entries = manifest.entries.filter(entry => entry.key === PRESALE_OUTBOX_CHECK_KEY);
  if (entries.length !== 1 || entries[0].catalog.definition !== PRESALE_OUTBOX_CHECK_DEFINITION)
    throw Error('Pink success forward contract requires the exact prior ten-event CHECK');
  const current = structuredClone(manifest);
  current.entries.find(entry => entry.key === PRESALE_OUTBOX_CHECK_KEY)!.catalog.definition = PINK_SUCCESS_NOTICE_CHECK_DEFINITION;
  return current;
}
