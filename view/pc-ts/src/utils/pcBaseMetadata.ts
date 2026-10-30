/** Compare-and-restore ownership keeps a late global response from replacing
 * metadata already authored by the current product/route. */
export function pcBaseMetadataLease(head: HTMLHeadElement) {
  const initial = new Map<string, { node: HTMLMetaElement | null; content: string | null }>();
  const owned = new Map<string, { node: HTMLMetaElement; content: string; original: string | null }>();
  for (const key of ['name:description', 'name:keywords', 'property:og:title', 'property:og:description', 'property:og:image']) {
    const attribute = key.startsWith('name:') ? 'name' : 'property';
    const contentKey = key.slice(attribute.length + 1);
    const node = head.querySelector<HTMLMetaElement>(`meta[${attribute}="${contentKey}"]`);
    initial.set(key, { node, content: node?.getAttribute('content') ?? null });
  }
  function set(attribute: 'name' | 'property', key: string, content: string) {
    const identity = `${attribute}:${key}`, before = initial.get(identity); if (!before) return;
    const current = head.querySelector<HTMLMetaElement>(`meta[${attribute}="${key}"]`), own = owned.get(identity);
    if (own ? current !== own.node || current?.getAttribute('content') !== own.content
      : current !== before.node || (current?.getAttribute('content') ?? null) !== before.content) return;
    if (!content && !current) return;
    const node = current ?? head.ownerDocument.createElement('meta');
    node.setAttribute(attribute, key); node.setAttribute('content', content);
    if (!current) head.append(node);
    owned.set(identity, { node, content, original: before.content });
  }
  function close() {
    for (const { node, content, original } of owned.values()) {
      if (node.parentNode !== head || node.getAttribute('content') !== content) continue;
      if (original === null) node.remove(); else node.setAttribute('content', original);
    }
    owned.clear();
  }
  return { set, close };
}
