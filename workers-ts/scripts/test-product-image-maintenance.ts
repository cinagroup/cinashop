import postgres from 'postgres';

// Deliberately fixed to the 68 publicly observed synthetic products approved on 2026-09-14.
export const IMAGE_IDS = Object.freeze([1, 2, 3, 4, ...Array.from({ length: 64 }, (_, i) => i + 8)]);
export const OLD_IMAGE = 'https://via.placeholder.com/300';
export const IMAGE_A = 'https://shop.cinaseek.ai/test-media/product-a.svg';
export const IMAGE_B = 'https://shop.cinaseek.ai/test-media/product-b.svg';
type Row = { id: number; store_name: string; image: string; other_hash: string };
export class ImageMaintenanceConflict extends Error {}
function requireSafe(condition: boolean): asserts condition {
  if (!condition) throw new ImageMaintenanceConflict('Fixed image maintenance precondition failed');
}
async function digest(rows: Row[]): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(rows)));
  return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
}
export async function maintainTestImages(connectionString: string, expectedDigest?: string) {
  const sql = postgres(connectionString, { max: 1, prepare: false, connect_timeout: 5,
    connection: { application_name: 'cinashop_test_image_maintenance' } });
  try {
    return await sql.begin(expectedDigest ? '' : 'read only', async tx => {
      await tx`SET LOCAL statement_timeout = '5s'`;
      await tx`SET LOCAL lock_timeout = '3s'`;
      await tx`SET LOCAL idle_in_transaction_session_timeout = '10s'`;
      const readRows = () => tx<Row[]>`SELECT p.id, p.store_name, p.image,
        md5((to_jsonb(p) - 'image')::text) AS other_hash
        FROM public.store_product p WHERE p.id IN ${tx([...IMAGE_IDS])} ORDER BY p.id`;
      if (expectedDigest) {
        await tx`SELECT id FROM public.store_product WHERE id IN ${tx([...IMAGE_IDS])} ORDER BY id FOR UPDATE`;
      }
      const rows = await readRows();
      const fingerprint = await digest(rows);
      const triggers = await tx`SELECT tgname, pg_get_triggerdef(oid) AS definition FROM pg_trigger
        WHERE tgrelid = 'public.store_product'::regclass AND NOT tgisinternal AND tgenabled <> 'D'
        AND (tgtype::int & 16) <> 0 AND (tgattr::text = '' OR
        (SELECT attnum FROM pg_attribute WHERE attrelid = tgrelid AND attname = 'image') = ANY(tgattr))`;
      const rules = await tx`SELECT rulename FROM pg_rewrite WHERE ev_class = 'public.store_product'::regclass
        AND rulename <> '_RETURN'`;
      if (!expectedDigest) return { mode: 'inspect', rows, fingerprint, imageUpdateTriggers: triggers, rules };
      requireSafe(expectedDigest === fingerprint && triggers.length === 0 && rules.length === 0);
      requireSafe(rows.length === 68 && rows.every((r, i) => r.id === IMAGE_IDS[i] && r.image === OLD_IMAGE));
      requireSafe(rows.filter(r => r.store_name === '测试商品A').length === 34 &&
        rows.filter(r => r.store_name === '会员专享商品B').length === 34);
      const updated = await tx`UPDATE public.store_product SET image = CASE store_name
        WHEN '测试商品A' THEN ${IMAGE_A} WHEN '会员专享商品B' THEN ${IMAGE_B} END
        WHERE id IN ${tx([...IMAGE_IDS])} AND image = ${OLD_IMAGE}
        AND store_name IN ('测试商品A', '会员专享商品B') RETURNING id`;
      requireSafe(updated.length === 68);
      const after = await readRows();
      requireSafe(after.length === rows.length && after.every((r, i) => r.id === rows[i].id &&
        r.other_hash === rows[i].other_hash && r.image === (r.store_name === '测试商品A' ? IMAGE_A : IMAGE_B)));
      return { mode: 'applied', updated: updated.length, beforeFingerprint: fingerprint,
        afterFingerprint: await digest(after), nonImageFieldsUnchanged: true, rows: after };
    });
  } finally { await sql.end({ timeout: 1 }); }
}
