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
}

export function apiAdminShippingTemplateList(): Promise<ShippingTemplateListResult> {
  return getData(request.get<ShippingTemplateListResult>("/shipping_template/list"));
}

export function apiAdminShippingTemplateSave(data: Record<string, unknown>): Promise<{ id: number }> {
  return getData(request.post<{ id: number }>("/shipping_template/save", data));
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
