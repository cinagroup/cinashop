import { describe, expect, it } from 'vitest';
import { combinationId, combinationCartInput, combinationCheckoutQuery, combinationOpen, combinationGroupOpen,
  parseCombinationList, parseCombinationSelection } from '../../view/common/combinationPurchase';

function catalogue() {
  const group = { id: 400, combination_id: 30, required_people: 4, active_people: 2, reserved_people: 1,
    available_places: 1, already_joined: false, has_pending_order: false, stop_time: '2026-09-08T12:00:00.000Z' };
  return { selection_only: true, type: 3, combination_id: 30, product_id: 70, title: 'Typed activity', image: '/image.svg',
    people: 4, once_limit: 3, total_limit: 6, start_time: '2026-09-08T00:00:00.000Z', stop_time: '2026-09-08T12:00:00.000Z', date_window: 'active',
    skus: [
      { unique: 'actred30', base_unique: 'qared001', suk: 'Red', stock: 6, max_quantity: 3, catalog_price: '6.25', ot_price: '10.00', image: '' },
      { unique: 'actblu30', base_unique: 'qablue01', suk: 'Blue', stock: 2, max_quantity: 2, catalog_price: '8.75', ot_price: '20.00', image: '' },
    ], groups: [group], requested_group: group };
}
const now = Date.parse('2026-09-08T06:00:00Z');
describe('combination frontend selection boundary', () => {
  it('keeps activity, base product, activity SKU, cart and leader identities separate without client pricing', () => {
    const detail = parseCombinationSelection(catalogue(), 30, 400);
    expect(combinationCartInput(detail, 'actblu30', 2, 400, now)).toEqual({ productId: 70, activityId: 30, unique: 'actblu30', cartNum: 2, new: 1, type: 3 });
    expect(detail.skus[1]).not.toHaveProperty('base_unique');
    expect(combinationCheckoutQuery(91, 30, 400)).toEqual({ mode: 'buy', cartId: '91', type: '3', combinationId: '30', pinkId: '400' });
    expect(combinationCheckoutQuery(91, 30)).not.toHaveProperty('pinkId');
  });
  it('parses server list titles and rejects legacy, duplicate, wrong-namespace and contradictory selections', () => {
    expect(parseCombinationList([{ id: 30, product_id: 70, title: 'Title', image: '', people: 4, price: 6.25, ot_price: 10 }])[0].title).toBe('Title');
    const changes = [
      { selection_only: false }, { type: 1 }, { combination_id: 70 }, { people: 0 }, { once_limit: 0 },
      { skus: [catalogue().skus[0], catalogue().skus[0]] },
      { skus: [{ ...catalogue().skus[0], unique: 'qablue01' }, catalogue().skus[1]] },
      { skus: [{ ...catalogue().skus[0], catalog_price: '6.255' }] },
      { skus: [{ ...catalogue().skus[0], max_quantity: 4 }] },
      { requested_group: null }, { requested_group: { ...catalogue().requested_group, id: 401 } },
      { groups: [{ ...catalogue().groups[0], available_places: 2 }] },
      { groups: [{ ...catalogue().groups[0], combination_id: 31 }] },
      { groups: [{ ...catalogue().groups[0], already_joined: 1 }] },
      { groups: [catalogue().groups[0], catalogue().groups[0]] },
      { stop_time: 'bad date' }, { start_time: '2026-09-09T00:00:00Z' },
    ];
    for (const change of changes) expect(() => parseCombinationSelection({ ...catalogue(), ...change }, 30, 400)).toThrow();
    expect(() => parseCombinationSelection(catalogue(), 30)).toThrow();
    expect(() => parseCombinationList({ list: [] })).toThrow();
    for (const id of ['', '0', '-1', '30.0', '030', '2147483648', ['30'], 30]) expect(() => combinationId(id)).toThrow();
  });
  it('preserves distinct activity-inclusive and group-exclusive endpoints and nullable bounds', () => {
    const detail = parseCombinationSelection(catalogue(), 30, 400), end = Date.parse(detail.stop_time!);
    expect(combinationOpen(detail, end)).toBe(true); expect(combinationOpen(detail, end + 1)).toBe(false);
    expect(combinationGroupOpen(detail.requested_group!, end)).toBe(false);
    expect(combinationGroupOpen(detail.requested_group!, end - 1)).toBe(true);
    expect(combinationOpen({ ...detail, start_time: null, stop_time: null }, now)).toBe(true);
    expect(combinationOpen({ ...detail, date_window: 'future' }, now)).toBe(false);
  });
  it('refuses base unique, malformed quantities and unavailable target groups without falling back to new-group', () => {
    const detail = parseCombinationSelection(catalogue(), 30, 400);
    for (const qty of [0, -1, 1.5, 3, Infinity, NaN]) expect(() => combinationCartInput(detail, 'actblu30', qty, 400, now)).toThrow();
    expect(() => combinationCartInput(detail, 'qablue01', 1, 400, now)).toThrow();
    expect(() => combinationCartInput(detail, 'actblu30', 1, 30, now)).toThrow();
    for (const change of [{ available_places: 0 }, { already_joined: true }, { has_pending_order: true }, { stop_time: '2026-09-08T01:00:00Z' }]) {
      expect(() => combinationCartInput({ ...detail, requested_group: { ...detail.requested_group!, ...change } }, 'actblu30', 1, 400, now)).toThrow();
    }
    expect(combinationCartInput(detail, 'actblu30', 2, 400, now).cartNum).toBe(2); // two pieces, only one available group seat
  });
});
