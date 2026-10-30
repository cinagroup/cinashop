import { customerWorkRecord, customerWorkImage } from './customerWork';
import { parseOrderSystemFormTemplate, prepareOrderSystemFormSubmission } from '../../../common/order-system-form';
import { customerWorkCanonicalJson } from '../../../common/customerWorkIntent';
import type { CustomerCashierCatalogProduct, CustomerCashierCatalogRow, CustomerCashierCatalogList, CustomerCashierCatalogDetail, CustomerCashierCatalogEnvelope, CustomerCashierReadiness } from '@/types/customerWorkCashierCatalog';
import type { SystemFormComponent, SystemFormInfo } from '@/types/systemForm';
const id = (v: unknown, minimum = 1): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= minimum && v <= 2_147_483_647;
const text = (v: unknown, maximum = 10000): v is string => typeof v === 'string' && v.length <= maximum && !/[\u0000-\u001f\u007f]/u.test(v);
const hash = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/u.test(v);
const keys = (v: Record<string, unknown>, names: string[]) => Object.keys(v).sort().join('|') === [...names].sort().join('|');
function readiness(v: unknown): v is CustomerCashierReadiness { return customerWorkRecord(v) && keys(v, ['writes','reason']) && typeof v.writes === 'boolean' && text(v.reason, 1000); }
function product(v: unknown): v is CustomerCashierCatalogProduct { return customerWorkRecord(v) && id(v.id) && text(v.store_name, 512) && customerWorkImage(v.image) && v.product_type === 4 && id(v.system_form_id, 0); }
function row(v: unknown): v is CustomerCashierCatalogRow { return product(v) && customerWorkRecord(v) && keys(v, ['id','store_name','image','product_type','system_form_id','sku_count']) && id(v.sku_count); }
export function isCustomerCashierCatalogList(v: unknown): v is CustomerCashierCatalogList {
  return customerWorkRecord(v) && keys(v, ['list','page','limit','has_more','readiness']) && Array.isArray(v.list) && id(v.page) && id(v.limit) && v.limit <= 50 && v.list.length <= v.limit
    && typeof v.has_more === 'boolean' && (!v.has_more || v.list.length > 0) && readiness(v.readiness) && v.list.every(row) && new Set(v.list.map(item => item.id)).size === v.list.length;
}
function form(v: unknown): v is SystemFormInfo {
  if (!customerWorkRecord(v) || !keys(v, ['id','name','value']) || !id(v.id) || !text(v.name, 255) || !Array.isArray(v.value)) return false;
  try {
    if (new TextEncoder().encode(customerWorkCanonicalJson(v)).length > 65536) return false;
    const components = parseOrderSystemFormTemplate(v.value);
    return components.every(item => {
      for (const name of ['titleConfig','tipConfig','defaultValConfig']) if (item[name] !== undefined && (!customerWorkRecord(item[name]) || item[name].value !== undefined && !text(item[name].value))) return false;
      if (item.wordsConfig !== undefined) {
        const config = item.wordsConfig;
        if (!customerWorkRecord(config) || !Array.isArray(config.list) || config.list.length > 100 || !config.list.every((choice: unknown) => typeof choice === 'number' && Number.isFinite(choice) || text(choice) || customerWorkRecord(choice) && ['val','value','label'].some(name => text(choice[name]) || typeof choice[name] === 'number' && Number.isFinite(choice[name])))) return false;
      }
      return true;
    });
  } catch { return false; }
}
export const isCustomerCashierSystemForm = form;
export function isCustomerCashierCatalogDetail(v: unknown): v is CustomerCashierCatalogDetail {
  if (!customerWorkRecord(v) || !keys(v, ['product','skus','system_form','readiness']) || !customerWorkRecord(v.product) || !keys(v.product, ['id','store_name','image','product_type','system_form_id']) || !product(v.product) || !readiness(v.readiness)
    || !Array.isArray(v.skus) || !v.skus.length || v.skus.length > 500 || !(v.system_form === null ? v.product.system_form_id === 0 || !v.readiness.writes && v.readiness.reason === 'cashier_form_capacity_exceeded' : form(v.system_form) && v.system_form.id === v.product.system_form_id)) return false;
  return v.skus.every(sku => customerWorkRecord(sku) && keys(sku, ['sku_unique','sku','image','price','stock','write_times','write_valid','write_days','write_start','write_end'])
    && text(sku.sku_unique, 16) && sku.sku_unique.length > 0 && text(sku.sku, 512) && customerWorkImage(sku.image) && typeof sku.price === 'string' && /^(0|[1-9]\d{0,9})\.\d{2}$/u.test(sku.price)
    && id(sku.stock) && id(sku.write_times) && [1,2,3].includes(Number(sku.write_valid)) && id(sku.write_days, 0) && id(sku.write_start, 0) && id(sku.write_end, 0)
    && (sku.write_valid !== 2 || sku.write_days > 0) && (sku.write_valid !== 3 || sku.write_start > 0 && sku.write_end > sku.write_start))
    && new Set(v.skus.map(sku => sku.sku_unique)).size === v.skus.length;
}
export function parseCustomerCashierCatalogEnvelope<T>(v: unknown, actorUid: number, guard: (data: unknown) => data is T, authority: { scope_key: string; principal: { service_id: number } }): CustomerCashierCatalogEnvelope<T> {
  if (!customerWorkRecord(v) || !keys(v, ['version','actor_uid','principal','scope_key','consistency_key','data']) || v.version !== 'customer-cashier-catalog-v1' || v.actor_uid !== actorUid
    || !customerWorkRecord(v.principal) || !keys(v.principal, ['kind','service_id','scope']) || v.principal.kind !== 'customer-order-manager' || v.principal.scope !== 'global' || v.principal.service_id !== authority.principal.service_id
    || !hash(v.scope_key) || v.scope_key !== authority.scope_key || !hash(v.consistency_key) || !guard(v.data)) throw Error('次卡选品响应与当前经营身份不匹配，请重新读取');
  return v as unknown as CustomerCashierCatalogEnvelope<T>;
}
export function customerCashierFormDraft(info: SystemFormInfo | null): SystemFormComponent[] {
  if (!info) return [];
  return JSON.parse(customerWorkCanonicalJson(info.value)).map((item: SystemFormComponent) => ({ ...item, value: ['checkboxs','dateranges','uploadPicture'].includes(item.name) ? [] : item.defaultValConfig?.value ?? '' }));
}
export function customerCashierFormAnswers(info: SystemFormInfo | null, answers: SystemFormComponent[]): unknown {
  if (!info) { if (answers.length) throw Error('次卡系统表单已变化，请重新选品'); return []; }
  if (answers.some(item => item.name === 'uploadPicture' && (!Array.isArray(item.value) || item.value.some(reference => typeof reference !== 'string'
    || !/^\/api\/assets\/[1-9]\d{0,9}$/u.test(reference) || Number(reference.slice('/api/assets/'.length)) > 2_147_483_647)))) throw Error('图片表单只能使用本次已核对的上传图片');
  const prepared = prepareOrderSystemFormSubmission(parseOrderSystemFormTemplate(info.value), answers, info.id);
  const result = JSON.parse(prepared.snapshotJson).map((item: SystemFormComponent) => ({ ...(item.id === undefined ? {} : { id: item.id }), name: item.name, value: item.value }));
  if (new TextEncoder().encode(customerWorkCanonicalJson(result)).length > 65536) throw Error('次卡系统表单答案过大');
  return result;
}
