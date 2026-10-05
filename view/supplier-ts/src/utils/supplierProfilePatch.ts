import type { SupplierProfile } from "../types";

const editableFields = [
  "supplier_name", "name", "phone", "email", "address", "detailed_address", "account",
] as const;

export type SupplierProfilePatch = Partial<Pick<SupplierProfile, typeof editableFields[number]>>;

/** The profile form displays more fields than it edits; only user changes belong in PUT. */
export function supplierProfilePatch(
  original: SupplierProfile,
  edited: SupplierProfile,
): SupplierProfilePatch {
  const patch: SupplierProfilePatch = {};
  for (const field of editableFields) {
    if (edited[field] !== original[field]) patch[field] = edited[field];
  }
  return patch;
}
