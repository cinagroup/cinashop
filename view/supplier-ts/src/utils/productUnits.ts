export interface SupplierProductUnit { id: number; name: string }

/** A directory assists text entry; its IDs never become product authors. */
export function parseSupplierProductUnits(value: unknown): SupplierProductUnit[] {
  const invalid = () => Error('单位目录资料无效，请重新读取');
  if (!Array.isArray(value)) throw invalid();
  const seen = new Set<number>();
  return value.map(raw => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw invalid();
    const row = raw as Record<string, unknown>;
    if (Object.keys(row).some(key => !['id', 'name'].includes(key))
      || typeof row.id !== 'number' || !Number.isSafeInteger(row.id) || row.id <= 0 || row.id > 2_147_483_647 || seen.has(row.id)
      || typeof row.name !== 'string' || !row.name.trim() || row.name !== row.name.trim() || [...row.name].length > 50
      || /[\u0000-\u001f\u007f-\u009f\ud800-\udfff]/u.test(row.name)) throw invalid();
    seen.add(row.id);
    return { id: row.id, name: row.name };
  });
}

export function supplierProductUnitNames(units: SupplierProductUnit[]): string[] {
  // Keep the server's sort/id order; equal names author the same durable text.
  return [...new Set(units.map(unit => unit.name))];
}
