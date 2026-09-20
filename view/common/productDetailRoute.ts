export function productDetailId(value: unknown): number {
  if (typeof value !== 'string' || !/^[1-9]\d{0,9}$/.test(value) || Number(value) > 2147483647) {
    throw new Error('商品链接标识无效，请返回商品列表');
  }
  return Number(value);
}

/** H5 may reuse a mounted page without another native onLoad. */
export function productDetailHashId(hash: string): number | null {
  const route = hash.replace(/^#/, ''), separator = route.indexOf('?');
  const path = separator < 0 ? route : route.slice(0, separator);
  const query = separator < 0 ? '' : route.slice(separator + 1);
  if (path !== '/pages/goods/detail') return null;
  if (hash.length > 8192) throw new Error('商品链接标识无效');
  const ids = new URLSearchParams(query).getAll('id');
  if (ids.length !== 1) throw new Error('商品链接标识无效');
  return productDetailId(ids[0]);
}
