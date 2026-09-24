import type { CatalogRow } from './postgres-catalog-audit';

export const PRESALE_OUTBOX_CHECK_KEY = 'store_order_outbox.soob_event_type_ck';
const legacyEvents = [
  'order.paid', 'order.delivery.notice', 'order.refund.refused.notice',
  'order.second_card.advent.notice', 'order.second_card.expired.notice',
  'withdrawal.approved.notice', 'withdrawal.refused.notice',
  'withdrawal.applied.notice', 'withdrawal.staff.refresh',
];
const currentEvents = [...legacyEvents, 'order.presale.fulfillment'];
const definition = (events: string[]) => `CHECK (((event_type)::text = ANY ((ARRAY[${events.map(event => `'${event}'::character varying`).join(', ')}])::text[])))`;
const expression = (events: string[]) => `IN (\n${events.map(event => `      '${event}'`).join(',\n')}\n    )`;
export const LEGACY_OUTBOX_CHECK_DEFINITION = definition(legacyEvents);
export const PRESALE_OUTBOX_CHECK_DEFINITION = definition(currentEvents);
export const LEGACY_OUTBOX_CHECK_SNAPSHOT = { name: 'soob_event_type_ck', value: `"store_order_outbox"."event_type" ${expression(legacyEvents)}` };
export const PRESALE_OUTBOX_CHECK_SNAPSHOT = { name: 'soob_event_type_ck', value: `"store_order_outbox"."event_type" ${expression(currentEvents)}` };
export const PRESALE_OUTBOX_MODEL_DECLARATION = 'check("soob_event_type_ck", sql`${t.eventType} ' + expression(currentEvents) + '`)';

/** Forward audit overlay only. The immutable 0144 manifest remains historical evidence. */
export function withPresaleOutboxContract<T extends { entries: Array<{ key: string; catalog: CatalogRow }> }>(manifest: T): T {
  const entries = manifest.entries.filter(entry => entry.key === PRESALE_OUTBOX_CHECK_KEY);
  if (entries.length !== 1 || entries[0].catalog.definition !== LEGACY_OUTBOX_CHECK_DEFINITION)
    throw Error('Presale forward contract requires the exact historical nine-event CHECK');
  const current = structuredClone(manifest);
  current.entries.find(entry => entry.key === PRESALE_OUTBOX_CHECK_KEY)!.catalog.definition = PRESALE_OUTBOX_CHECK_DEFINITION;
  return current;
}
