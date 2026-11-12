import { and, eq, sql } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { storeProduct, systemForm } from '@/models/schema';
import { supplierProductSystemFormInput, lockSupplierProductSystemForm, assertSupplierProductSystemForm } from '@/services/supplier/SupplierProductSystemFormBindings';
import { ValidateException } from '@/utils/errors';

/** Legacy custom_form is a stored snapshot, not the active order template. */
export function outProductCustomFormInput(input: Record<string, unknown>): string | undefined {
  const value = input.custom_form;
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype)) {
    throw new ValidateException('自定义表单格式错误');
  }
  if (Object.keys(value).length > 100) throw new ValidateException('自定义表单不能超过100项');
  let nodes = 0;
  const copy = (item: unknown, depth: number): unknown => {
    if (++nodes > 30_000 || depth > 24) throw new ValidateException('自定义表单内容过多或层级过深');
    if (item === null || typeof item === 'boolean' || typeof item === 'string') return item;
    if (typeof item === 'number' && Number.isFinite(item)) return Object.is(item, -0) ? 0 : item;
    if (Array.isArray(item)) return item.map(entry => copy(entry, depth + 1));
    if (item && typeof item === 'object' && Object.getPrototypeOf(item) === Object.prototype) {
      const result: Record<string, unknown> = {};
      for (const key of Object.keys(item).sort()) {
        if (['__proto__', 'constructor', 'prototype'].includes(key)) throw new ValidateException('自定义表单字段无效');
        result[key] = copy((item as Record<string, unknown>)[key], depth + 1);
      }
      return result;
    }
    throw new ValidateException('自定义表单格式错误');
  };
  const normalized = copy(value, 0);
  const encoded = Object.keys(value).length ? JSON.stringify(normalized) : '';
  if (new TextEncoder().encode(encoded).length > 262_144) throw new ValidateException('自定义表单超过容量');
  return encoded;
}
export const outProductSystemFormInput = supplierProductSystemFormInput;
async function formVersion(tx: DbClient, id: number) {
  const [row] = await tx.select({ version: sql<string>`xmin::text` }).from(systemForm).where(eq(systemForm.id, id)).limit(1);
  return row?.version;
}
/** Keep the version as well as the bounded parser image: two different large
 * default values may both project to null in the supplier reader. */
export async function lockOutProductSystemForm(tx: DbClient, id: number) {
  const form = await lockSupplierProductSystemForm(tx, id);
  const version = id === 0 ? undefined : await formVersion(tx, id);
  if (id > 0 && !version) throw new ValidateException('系统表单已变化');
  return { form, version };
}

type Product = typeof storeProduct.$inferSelect;
type Admitted = Awaited<ReturnType<typeof lockOutProductSystemForm>> | undefined;
export interface OutProductFormProof {
  productId: number;
  productType: 0 | 1 | 2 | 3 | 4;
  customForm: string | null;
  systemFormId: number;
  admitted: Admitted;
  selected: boolean;
}
export function outProductFormProof(productId: number, productType: 0 | 1 | 2 | 3 | 4, existing: Product | undefined, customForm: string | undefined,
  systemFormId: number | undefined, admitted: Admitted): OutProductFormProof {
  return { productId, productType, customForm: customForm === undefined ? existing?.customForm ?? null : customForm,
    systemFormId: systemFormId === undefined ? existing?.systemFormId ?? 0 : systemFormId,
    admitted, selected: systemFormId !== undefined };
}
/** Run after all authors, receipt and deferred constraints. Omitted definitions
 * are not consulted, but their stored ID and legacy snapshot are protected. */
export async function assertOutProductForm(tx: DbClient, proof: OutProductFormProof) {
  const [product] = await tx.select({ customForm: storeProduct.customForm, systemFormId: storeProduct.systemFormId })
    .from(storeProduct).where(and(eq(storeProduct.id, proof.productId), eq(storeProduct.type, 0),
      eq(storeProduct.relationId, 0), eq(storeProduct.productType, proof.productType), eq(storeProduct.isDel, 0))).limit(1);
  if (!product || product.customForm !== proof.customForm || product.systemFormId !== proof.systemFormId) {
    throw new ValidateException('平台商品表单数据已变化');
  }
  if (proof.selected) {
    if (!proof.admitted) throw new ValidateException('平台商品表单准入已变化');
    await assertSupplierProductSystemForm(tx, proof.systemFormId, proof.admitted.form);
    if (proof.systemFormId > 0 && await formVersion(tx, proof.systemFormId) !== proof.admitted.version) {
      throw new ValidateException('平台商品表单定义已变化');
    }
  }
}
