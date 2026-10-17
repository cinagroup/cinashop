/** The read-only product surface never falls back to a different product. */
export function supplierProductDetailId(
  params: Record<string, unknown>, query: Record<string, unknown>, developmentPreview = false,
): number | null {
  if (Object.keys(params).some(key => key !== 'id')
    || Object.keys(query).some(key => !(developmentPreview && key === 'preview' && query.preview === '1'))) return null;
  const value = params.id;
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) && id <= 2_147_483_647 ? id : null;
}
