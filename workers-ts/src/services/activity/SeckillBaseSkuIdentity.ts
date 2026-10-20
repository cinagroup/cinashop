/** Canonicalize only a selected type-0 row's PostgreSQL char(8) padding.
 * Activity identities, client input and historical cart strings keep their own rules. */
export function canonicalSeckillBaseSkuUnique(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const unique = value.replace(/ +$/, '');
  return unique && unique.length <= 8 && !/[\s\x00-\x1f\x7f]/u.test(unique) ? unique : null;
}

export function validSeckillBaseSkuIdentities(rows: Array<{ unique: string; suk: string }>): boolean {
  const uniques = rows.map(row => canonicalSeckillBaseSkuUnique(row.unique));
  return !uniques.includes(null) && new Set(uniques).size === rows.length &&
    rows.every(row => row.suk === row.suk.trim()) && new Set(rows.map(row => row.suk)).size === rows.length;
}

/** Validate stored aliases without rewriting them. Existing activity/base keys
 * and server-authored ASCII right padding remain valid; other whitespace does not. */
export function validSeckillStoredSkuAlias(value: unknown): boolean {
  return typeof value === 'string' && value.length <= 8 && /^[^\s\x00-\x1f\x7f]+ *$/u.test(value);
}
