import { ValidateException } from '@/utils/errors';
import { productCodeValue } from '../../../../view/common/productCode';

export function checkedProductCode(raw: unknown): string {
  try { return productCodeValue(raw); }
  catch (error) { throw new ValidateException((error as Error).message); }
}

/** Omitted fields preserve stored text; an explicit empty string clears it. */
export function productCodeInput(raw: Record<string, unknown>): string | undefined {
  return !Object.hasOwn(raw, 'code') || raw.code === undefined ? undefined : checkedProductCode(raw.code);
}

/** The PHP ERP guard uses empty()/truthiness, which also rejects string "0". */
export function productErpCodePresent(code: string): boolean {
  return code.trim() !== '' && code.trim() !== '0';
}
