import { apiRequest } from './http';
import { getShippingTemplate, getShippingTemplates, previewMode } from './supplier';

export interface ProductShippingOption { id: number; name: string; type: string }
export interface ProductShippingOptionsPage { data: ProductShippingOption[]; count: number }

export async function getProductShippingOptions(params: Record<string, string | number>, signal?: AbortSignal): Promise<ProductShippingOptionsPage> {
  if (previewMode) {
    const page = await getShippingTemplates(params, signal);
    return { count: page.count, data: page.data.map(({ id, name, type }) => ({ id, name, type })) };
  }
  return apiRequest<ProductShippingOptionsPage>({ method: 'GET', url: '/product/product/shipping-template-options', params, signal });
}

export async function getProductShippingOption(id: number, signal?: AbortSignal): Promise<ProductShippingOption> {
  if (previewMode) {
    const { formData } = await getShippingTemplate(id, signal);
    return { id, name: formData.name, type: { 1: '按件数', 2: '按重量', 3: '按体积' }[formData.type] };
  }
  return apiRequest<ProductShippingOption>({ method: 'GET', url: `/product/product/shipping-template-options/${id}`, signal });
}
