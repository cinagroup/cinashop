/**
 * 运费模板 + 快递公司 API
 */
import request, { getData } from "@/utils/request";

export interface ShippingRegion {
  id?: number;
  /** 后端返回 camelCase, 兼容 snake */
  regionId?: number;
  region_id?: number;
  regionName?: string;
  region_name?: string;
  first: string;
  firstPrice?: string;
  first_price?: string;
  continue: string;
  continuePrice?: string;
  continue_price?: string;
}

export interface ShippingTemplate {
  id: number;
  name: string;
  type: number;
  sort: number;
  status: number;
  addTime: number;
}

export interface ShippingTemplateListResult {
  list: ShippingTemplate[];
  regions: (ShippingRegion & { templateId: number })[];
  count: number;
  limit: number;
  nextCursor: string | null;
}

export async function apiAdminShippingTemplateList(params: { limit: number; name?: string; cursor?: string }): Promise<ShippingTemplateListResult> {
  const result = await getData<ShippingTemplateListResult>(request.get("/shipping_template/list", { params }));
  if (!result || !Array.isArray(result.list) || !Array.isArray(result.regions) || result.list.length > params.limit
    || result.regions.length > 1000 || result.limit !== params.limit || !Number.isSafeInteger(result.count) || result.count < result.list.length
    || (result.nextCursor !== null && (typeof result.nextCursor !== 'string' || !/^-?\d{1,10}:[1-9]\d{0,9}$/.test(result.nextCursor)))
    || result.regions.some(region => !result.list.some(template => template.id === region.templateId))) {
    throw new Error('运费列表响应不完整，请刷新后重试');
  }
  return result;
}

export function apiAdminShippingTemplateSave(data: Record<string, unknown>): Promise<{ id: number }> {
  return getData(request.post<{ id: number }>("/shipping_template/save", data));
}

export interface ShippingGroupedRegion { city_ids: number[][]; first: string; first_price: string; continue: string; continue_price: string }
export interface ShippingGroupedFree { city_ids: number[][]; number: string; price: string }
export interface ShippingGroupedNoDelivery { city_ids: number[][] }
export interface ShippingGroupedForm {
  id: number; name: string; type: number; status: number; sort: number; appoint: number; no_delivery: number;
  region_info: ShippingGroupedRegion[]; appoint_info: ShippingGroupedFree[]; no_delivery_info: ShippingGroupedNoDelivery[];
  expectedRevision?: string;
}
export interface ShippingCity { city_id: number; name: string; children?: ShippingCity[] }
interface ShippingDetail {
  revision: string;
  formData: Omit<ShippingGroupedForm, 'region_info' | 'appoint_info' | 'no_delivery_info' | 'expectedRevision'>;
  region_info: ShippingGroupedRegion[]; appoint_info: ShippingGroupedFree[]; no_delivery_info: ShippingGroupedNoDelivery[];
}
export async function apiAdminShippingTemplateDetail(id: number): Promise<ShippingDetail> {
  const data = await getData<ShippingDetail>(request.get(`/shipping_template/${id}/edit`));
  const paths = (rows: unknown, fields: string[]) => Array.isArray(rows) && rows.length <= 100 && rows.every(row =>
    row && typeof row === 'object' && Array.isArray(row.city_ids) && row.city_ids.length <= 1000
    && row.city_ids.every((path: unknown) => Array.isArray(path) && path.length > 0 && path.length <= 4 && path.every(p => Number.isSafeInteger(p) && p >= 0))
    && fields.every(field => typeof row[field] === 'string' && /^\d{1,10}(?:\.\d{1,2})?$/.test(row[field])));
  if (!data || !/^shipping-v1:[a-f0-9]{64}$/.test(data.revision) || !data.formData || data.formData.id !== id
    || typeof data.formData.name !== 'string' || ![1,2,3].includes(data.formData.type) || ![0,1].includes(data.formData.status)
    || !Number.isSafeInteger(data.formData.sort) || ![0,1].includes(data.formData.appoint) || ![0,1].includes(data.formData.no_delivery)
    || !paths(data.region_info, ['first','first_price','continue','continue_price']) || !paths(data.appoint_info, ['number','price'])
    || !paths(data.no_delivery_info, [])) throw new Error('模板详情不完整，请重新打开后重试');
  return data;
}
export async function apiAdminShippingCities(): Promise<ShippingCity[]> {
  const data = await getData<ShippingCity[]>(request.get('/shipping_template/city_list'));
  if (!Array.isArray(data) || data.length > 64 || data.some(root => !root || !Number.isSafeInteger(root.city_id) || root.city_id <= 0
    || typeof root.name !== 'string' || !Array.isArray(root.children) || root.children.length > 1000
    || root.children.some(city => !city || !Number.isSafeInteger(city.city_id) || city.city_id <= 0 || typeof city.name !== 'string'))) {
    throw new Error('城市列表不完整，请重试');
  }
  return data;
}

export function apiAdminShippingTemplateDel(id: number): Promise<null> {
  return getData(request.delete<null>(`/shipping_template/del/${id}`));
}

export interface ExpressItem {
  id: number;
  code: string;
  name: string;
  isShow: number;
  sort: number;
  status: number;
  addTime: number;
}

export function apiAdminExpressList(): Promise<ExpressItem[]> {
  return getData(request.get<ExpressItem[]>("/express/list"));
}

export function apiAdminExpressSave(data: Record<string, unknown>): Promise<{ id: number }> {
  return getData(request.post<{ id: number }>("/express/save", data));
}

export function apiAdminExpressDel(id: number): Promise<null> {
  return getData(request.delete<null>(`/express/del/${id}`));
}
