/** PHP community primes alternating columns, then places its first tail by card
 * count because boxHeight is initially empty. Only a second tail uses measured
 * heights. Unknown sizes use a finite estimate; no post is discarded. */
export function diyCommunityColumns<T extends { id: number }>(rows: readonly T[], heights: ReadonlyMap<number, number>): [T[], T[]] {
  const columns: [T[], T[]] = [[], []], totals = [0, 0];
  const initial = rows.length < 3 ? rows.length : rows.length <= 7 ? rows.length - 1 : rows.length - 2;
  const actual = rows.map(row => heights.get(row.id)).filter((n): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0 && n <= 1_000_000);
  const estimate = actual.length ? actual.reduce((sum, n) => sum + n, 0) / actual.length : 1;
  rows.forEach((row, index) => {
    const side = index < initial ? index % 2 : index === initial
      ? columns[1].length < columns[0].length ? 1 : 0
      : totals[0]! > totals[1]! ? 1 : 0;
    const height = heights.get(row.id);
    columns[side]!.push(row);
    totals[side]! += typeof height === 'number' && Number.isFinite(height) && height > 0 && height <= 1_000_000 ? height : estimate;
  });
  return columns;
}
