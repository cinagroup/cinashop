/** Only canonicalize the selected base row's PostgreSQL char(8) padding.
 * Activity identities and client/historical strings are separate inputs. */
export function canonicalNewcomerBaseSkuUnique(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const unique = value.replace(/ +$/, '');
  return unique && unique.length <= 8 && !/[\s\x00-\x1f\x7f]/u.test(unique) ? unique : null;
}
