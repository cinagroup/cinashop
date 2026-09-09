export interface BargainPickupStore {
  id: number; name: string; introduction: string; phone: string; address: string; detailed_address: string;
  image: string; latitude: string; longitude: string; valid_time: string; day_time: string;
}
export interface BargainShippingSelection {
  kind: 'bargain'; cartIds: number[]; activityId: number; methods: number[]; shippingTypes: (1 | 2)[];
  requiresAddress: boolean; stores: BargainPickupStore[];
}
const invalid = (): never => { throw new Error('砍价配送响应无效，请刷新后重试'); };
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : invalid();
const id = (value: unknown): number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= 2_147_483_647 ? value : invalid();
export function normalizeBargainShipping(value: unknown, cartIds: readonly number[]): BargainShippingSelection {
  const row = record(value);
  if (!cartIds.length || cartIds.length > 200 || new Set(cartIds).size !== cartIds.length) return invalid();
  cartIds.forEach(id);
  if (row.kind !== 'bargain' || !Array.isArray(row.cartIds) || row.cartIds.length !== cartIds.length ||
    row.cartIds.some((value,index) => value !== cartIds[index]) || !Array.isArray(row.methods) || row.methods.length > 3 ||
    row.methods.some(method => ![1,2,3].includes(method)) || new Set(row.methods).size !== row.methods.length ||
    !Array.isArray(row.shippingTypes) || row.shippingTypes.length > 2 || typeof row.requiresAddress !== 'boolean' ||
    !Array.isArray(row.stores) || row.stores.length > 200) return invalid();
  const methods: number[] = row.methods;
  const shippingTypes = ([1,2] as const).filter(type => type === 1 ? methods.includes(1) || methods.includes(3) : methods.includes(2));
  if (JSON.stringify(shippingTypes) !== JSON.stringify(row.shippingTypes)) return invalid();
  const stores = row.stores.map(value => {
    const store = record(value), text = (key: string) => typeof store[key] === 'string' && store[key].length <= 2000 ? store[key] : invalid();
    return { id:id(store.id),name:text('name'),introduction:text('introduction'),phone:text('phone'),address:text('address'),
      detailed_address:text('detailed_address'),image:text('image'),latitude:text('latitude'),longitude:text('longitude'),valid_time:text('valid_time'),day_time:text('day_time') };
  });
  if (new Set(stores.map(store => store.id)).size !== stores.length || shippingTypes.includes(2) !== (stores.length > 0)) return invalid();
  return { kind:'bargain', cartIds:[...cartIds], activityId:id(row.activityId), methods:[...row.methods], shippingTypes, requiresAddress:row.requiresAddress, stores };
}
