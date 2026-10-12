/** Shared URL boundary for Supplier media. This classifies references, not HTML. */
export type ProductMediaReference =
  | { kind: 'asset'; reference: string; id: number }
  | { kind: 'public'; reference: string }
  | { kind: 'invalid'; privateNamespace: boolean };

const BASE = 'https://supplier-media.invalid';
// These are the two actual AttachmentController.asset mounts. The v1 route
// namespace is mounted at /api (not /api/v1); both tickets grant the same asset.
const PRIVATE_PATH = /^\/(?:api|kefuapi)\/assets(?:\/|$)/;
const CONTROLS = /[\u0000-\u001f\u007f]/;

function pathNamespace(path: string): boolean {
  return PRIVATE_PATH.test(path);
}

/** Unsafe aliases are hints only; they never become an accepted public URL. */
function privateHint(value: string): boolean {
  const candidate = value.replaceAll('\\', '/').replace(/[\u0000-\u0020\u007f]/g, '');
  const paths: string[] = [];
  // A malformed same-scheme URL resolves differently with a page base than as
  // an absolute URL. Either possible private route must remain unavailable.
  for (const base of [BASE, undefined]) {
    try { paths.push(new URL(candidate, base).pathname); } catch { /* not an absolute URL */ }
  }
  for (let path of paths) {
    // A bounded hint also recognizes nested encodings that the accepted path
    // decoder rejects. No decoded hint is returned for use in an IMG or link.
    try {
      for (let depth = 0; depth < 4; depth++) {
        const normalized = new URL(path.replaceAll('\\', '/').replace(/\/{2,}/g, '/'), BASE).pathname;
        if (pathNamespace(normalized)) return true;
        const next = decodeURIComponent(path);
        if (next === path) break;
        path = next;
      }
      if (pathNamespace(new URL(path, BASE).pathname)) return true;
    } catch { /* accepted classification separately rejects invalid encodings */ }
  }
  return false;
}

export function classifyProductMediaReference(value: unknown): ProductMediaReference {
  if (typeof value !== 'string' || !value || value.length > 4096) return { kind: 'invalid', privateNamespace: false };
  const hint = privateHint(value);
  const invalid = (): ProductMediaReference => ({ kind: 'invalid', privateNamespace: hint });
  if (CONTROLS.test(value) || value.includes('\\')) return invalid();
  const reference = value.trim();
  if (!reference || /[\s\u00a0]/u.test(reference)) return invalid();
  const rootRelative = reference.startsWith('/') && !reference.startsWith('//');
  let url: URL;
  try { url = new URL(reference, BASE); } catch { return invalid(); }
  if ((!rootRelative && !/^https:\/\//i.test(reference)) || url.protocol !== 'https:' || url.username || url.password) return invalid();
  let path: string;
  try { path = decodeURIComponent(url.pathname); } catch { return invalid(); }
  // Decode the pathname once. Encoded separators, nested percent encodings and
  // controls are ambiguous across routers and must not fall into the public arm.
  if (/%(?:2f|5c)/i.test(url.pathname) || path.includes('%') || path.includes('\\') || CONTROLS.test(path) || /\/{2,}/.test(path)) return invalid();
  try { path = new URL(path, BASE).pathname; } catch { return invalid(); }
  if (pathNamespace(path)) {
    const match = /^\/(?:api|kefuapi)\/assets\/([1-9]\d*)$/.exec(path);
    const id = match ? Number(match[1]) : 0;
    if (!Number.isSafeInteger(id) || id <= 0 || id > 2_147_483_647) return { kind: 'invalid', privateNamespace: true };
    return { kind: 'asset', reference: `/api/assets/${id}`, id };
  }
  return { kind: 'public', reference };
}
