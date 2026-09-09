export interface BargainShippingFields {
  deliveryType: string; freight: number; postage: string; tempId: number;
}
export interface BargainShippingOptions {
  current: BargainShippingFields | null; productType: number; templates: { id: number; name: string }[];
}
export interface BargainShippingForm { methods: string[]; freight: number; postage: string; tempId: number }
export function shippingForm(current?: BargainShippingFields | null): BargainShippingForm {
  return { methods: current ? current.deliveryType.split(',').filter(Boolean) : ['1'],
    freight: current?.freight ?? 1, postage: current?.postage ?? '0.00', tempId: current?.tempId ?? 0 };
}
export function withBargainShipping(payload: Record<string, unknown>, form: BargainShippingForm,
  original: BargainShippingFields | null, loadedProductId: number, productId: number,
  options?: BargainShippingOptions): Record<string, unknown> {
  const raw = { deliveryType: form.methods.join(','), freight: form.freight, postage: form.postage, tempId: form.tempId };
  if (payload.id && (!loadedProductId || original && Object.keys(raw).every(key =>
    raw[key as keyof BargainShippingFields] === original[key as keyof BargainShippingFields]))) return payload;
  if (!options || loadedProductId !== productId) throw new Error('请先加载当前商品的配送配置');
  const nonLogistics = [1, 2, 3].includes(options.productType);
  if (options.productType !== 0) raw.deliveryType = '2';
  if (!raw.deliveryType) throw new Error('请至少选择一种配送方式');
  if (nonLogistics) Object.assign(raw, { freight: 2, postage: '0.00', tempId: 0 });
  else if (raw.freight === 1) Object.assign(raw, { postage: '0.00', tempId: 0 });
  else if (raw.freight === 2) {
    if (!/^(?:0|[1-9]\d{0,7})(?:\.\d{1,2})?$/.test(raw.postage) || Number(raw.postage) <= 0) throw new Error('请设置大于零且最多两位小数的运费金额');
    raw.tempId = 0;
  } else if (raw.freight === 3) {
    if (!options.templates.some(row => row.id === raw.tempId)) throw new Error('请选择可用运费模板');
    raw.postage = '0.00';
  }
  return { ...payload, shipping: { ...raw, ...(payload.id ? { expected: original } : {}) } };
}
