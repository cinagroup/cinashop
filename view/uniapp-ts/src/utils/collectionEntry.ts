const LEGACY_COLLECTION_HASH = '#/pages/users/user_goods_collection/index';
const COLLECTION_HASH = '#/pages/user/collect';

/** Match one complete PHP entry path and keep its raw query suffix unchanged. */
export function normalizeCollectionEntryHash(hash: string): string {
  const separator = hash.indexOf('?');
  const path = separator < 0 ? hash : hash.slice(0, separator);
  if (path !== LEGACY_COLLECTION_HASH) return hash;
  return COLLECTION_HASH + (separator < 0 ? '' : hash.slice(separator));
}

type CollectionEntryHost = {
  location: { hash: string; pathname: string; search: string };
  history: Pick<History, 'replaceState'>;
};

/** Called only by the H5 entry before router creation; OAuth keeps its own entry. */
export function prepareCollectionEntry(
  host: CollectionEntryHost | undefined = typeof window === 'undefined' ? undefined : window,
): void {
  if (!host || new URLSearchParams(host.location.search).get('work_oauth') === '1') return;
  const current = host.location.hash;
  const next = normalizeCollectionEntryHash(current);
  if (next === current) return;
  host.history.replaceState(null, '', host.location.pathname + host.location.search + next);
}
