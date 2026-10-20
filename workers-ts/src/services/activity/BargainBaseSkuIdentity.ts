/** Only a selected type0 database identity may lose char(8) ASCII padding. */
export function canonicalBargainBaseSkuUnique(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const unique = value.replace(/ +$/, '');
  return unique && unique.length <= 8 && !/[\s\x00-\x1f\x7f]/u.test(unique) ? unique : null;
}
