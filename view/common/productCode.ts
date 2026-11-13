export interface ProductCodeSelection { version: 1; code: string; erp_open: boolean | null }
export interface ProductCodeEditor { ready: boolean; code: string; erpOpen: boolean | null; changed: boolean }

export function productCodeValue(raw: unknown): string {
  if (typeof raw !== 'string' || [...raw.trim()].length > 50 || /[\u0000-\u001f\u007f\ud800-\udfff]/u.test(raw))
    throw Error('商品编码最多50个字符，不能含换行或控制字符');
  return raw.trim();
}

export function productCodeEditor(raw?: unknown, creating = false): ProductCodeEditor {
  if (raw === undefined) return { ready: creating, code: '', erpOpen: null, changed: false };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw Error('商品编码响应无效');
  const row = raw as ProductCodeSelection;
  // Historical text is an editing echo, not an instruction to normalize it.
  if (Object.keys(row).length !== 3 || row.version !== 1 || typeof row.code !== 'string' || [...row.code].length > 50
    || row.erp_open !== null && typeof row.erp_open !== 'boolean') throw Error('商品编码响应无效');
  return { ready: true, code: row.code, erpOpen: row.erp_open, changed: false };
}

export function productCodePayload(editor: ProductCodeEditor): { code?: string } {
  return editor.ready && editor.changed ? { code: productCodeValue(editor.code) } : {};
}
