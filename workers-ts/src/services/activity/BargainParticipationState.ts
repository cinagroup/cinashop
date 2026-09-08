/** Worker semantics: 1=participating, 2=closed, 3=cut complete, 4=used by an order.
 * This is participation readiness only, not activity visibility, stock or a quote.
 * A malformed/over-cut row must never turn into purchase permission.
 */
export function isBargainParticipationReady(record: {
  status: number; bargainPrice: string; bargainPriceMin: string; price: string;
}): boolean {
  if (record.status !== 1 && record.status !== 3) return false;
  const money = [record.bargainPrice, record.bargainPriceMin, record.price];
  if (money.some(value => !/^\d{1,10}\.\d{2}$/.test(value))) return false;
  const [original, minimum, cut] = money.map(value => {
    const [whole, fraction] = value.split(".");
    return Number(whole) * 100 + Number(fraction);
  });
  return original >= minimum && original - cut === minimum;
}
