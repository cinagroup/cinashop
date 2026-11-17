import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { getTableName, type SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { DbClient } from '@/lib/di';
import { systemAttachment, systemSupplier } from '@/models/schema';
import { adminAttachmentScope, R2_IMAGE_TYPE, supplierAttachmentScope } from '@/services/system/AttachmentService';
import {
  MAX_KEFU_SPLIT_CART_ROWS, MAX_KEFU_SPLIT_CART_SNAPSHOT_UNITS,
  assertKefuSplitCartPreviewBudget, readKefuSplitCartMedia, renderKefuSplitCartMedia,
} from '@/services/kefu/KefuSplitCartMediaPolicy';

type Target = { id: number; image: string; cart_info: Record<string, unknown> | null };
type Owner = { id: number; type: number; relationId: number };
const key = 'owned-split-policy-key';
const dialect = new PgDialect();
const ref = (id: number) => `/api/assets/${id}`;
const attachment = (attId: number, type = 0, relationId = 0) => ({
  attId, ...(type === 2 ? supplierAttachmentScope(relationId) : adminAttachmentScope()), fileType: 1, imageType: R2_IMAGE_TYPE,
  attDir: ref(attId), name: type === 2 ? `attachments/supplier/${relationId}/${attId}.png` : `attachments/admin/1/${attId}.png`,
  attType: 'image/png',
});

/** Only the SELECT transport is local. No product policy, normalization,
 * canonicalization, owner check, attachment check or HMAC is mocked. The real
 * shared helper supplies SQL and its actual bound attachment IDs select rows. */
type FixtureAttachment = Omit<ReturnType<typeof attachment>, 'moduleType' | 'type'> & { moduleType: number; type: number };
function transport(assets: FixtureAttachment[] = [attachment(9101), attachment(9102, 2, 310), attachment(9103, 2, 320)], active = [310, 320]) {
  const trace: { table: string; sql: string; params: unknown[] }[] = [];
  const db = { select: () => ({ from: (table: typeof systemSupplier | typeof systemAttachment) => ({ where: async (where: SQL) => {
    const query = dialect.sqlToQuery(where), name = getTableName(table);
    trace.push({ table: name, sql: query.sql, params: [...query.params] });
    const ids = new Set(query.params.filter((value): value is number => typeof value === 'number'));
    return name === 'system_supplier'
      ? active.filter(id => ids.has(id)).map(id => ({ id }))
      : assets.filter(row => ids.has(row.attId) && row.moduleType === 1 && row.fileType === 1 && row.imageType === R2_IMAGE_TYPE);
  } }) }) } as unknown as Pick<DbClient, 'select'>;
  return { db, trace };
}
const target = (id: number, image: string, cart_info: Record<string, unknown> | null = { product: { image } }): Target => ({ id, image, cart_info });
const owner = (id: number, type = 0, relationId = 0): Owner => ({ id, type, relationId });
const signed = (image: string, reference: string) => {
  const url = new URL(image, 'https://owned-split-policy.local'), expires = Number(url.searchParams.get('expires'));
  expect(url.pathname).toBe(reference); expect([...url.searchParams.keys()].sort()).toEqual(['expires', 'signature']);
  expect(expires).toBeGreaterThan(Math.floor(Date.now() / 1000));
  expect(expires).toBeLessThanOrEqual(Math.floor(Date.now() / 1000) + 900);
  expect(url.searchParams.get('signature')).toBe(createHmac('sha256', key).update(`GET\n${reference}\n${expires}`).digest('base64url'));
};
async function project(owners: Owner[], targets: Target[], local = transport()) {
  const slots = await readKefuSplitCartMedia(local.db, owners, targets);
  await renderKefuSplitCartMedia(key, slots); return { ...local, slots, targets };
}

describe('Kefu split-cart snapshot media using the actual shared product asset policy', () => {
  it('binds explicit 10000-row and 16Mi UTF16-code-unit complete-preview budgets', () => {
    expect(MAX_KEFU_SPLIT_CART_ROWS).toBe(10_000);
    expect(MAX_KEFU_SPLIT_CART_SNAPSHOT_UNITS).toBe(16 * 1024 * 1024);
    expect(() => assertKefuSplitCartPreviewBudget(Array.from({ length: 10_000 }, () => ({ cartInfo: null })))).not.toThrow();
    expect(() => assertKefuSplitCartPreviewBudget(Array.from({ length: 10_001 }, () => ({ cartInfo: null })))).toThrow();
    expect(() => assertKefuSplitCartPreviewBudget([{ cartInfo: 'a'.repeat(MAX_KEFU_SPLIT_CART_SNAPSHOT_UNITS) }])).not.toThrow();
    expect(() => assertKefuSplitCartPreviewBudget([{ cartInfo: 'a'.repeat(MAX_KEFU_SPLIT_CART_SNAPSHOT_UNITS) }, { cartInfo: 'x' }])).toThrow();
  });

  it('counts astral characters as two UTF16 units and adds complete raw JSON across rows', () => {
    const half = '😀'.repeat(MAX_KEFU_SPLIT_CART_SNAPSHOT_UNITS / 4);
    expect(() => assertKefuSplitCartPreviewBudget([{ cartInfo: half }, { cartInfo: half }])).not.toThrow();
    expect(() => assertKefuSplitCartPreviewBudget([{ cartInfo: half }, { cartInfo: half + 'x' }])).toThrow();
  });

  it('independently projects the top image and five recognized raw snapshot paths without changing finance or unknown fields', async () => {
    const snapshot = { product: { image: ref(9101), attrInfo: { image: ref(9102), price: '1.2300' } },
      productInfo: { image: ref(9103), attrInfo: { image: '/legacy/attr.png', sku: '旧规格' } },
      sku: { image: 'https://legacy.example.test/sku.png?a=1&b=2', price: '007.00' },
      promotion_quote_version: 'unparsed-value', truePrice: '0.13', unknown: { image: 'javascript:untouched' } };
    const item = target(1, ref(9101), structuredClone(snapshot));
    const { trace } = await project([owner(1, 2, 310)], [item]);
    signed(item.image, ref(9101)); signed((item.cart_info!.product as any).image, ref(9101));
    signed((item.cart_info!.product as any).attrInfo.image, ref(9102));
    expect((item.cart_info!.productInfo as any).image).toBe('');
    expect((item.cart_info!.productInfo as any).attrInfo.image).toBe('/legacy/attr.png');
    expect((item.cart_info!.sku as any).image).toBe('https://legacy.example.test/sku.png?a=1&b=2');
    expect((item.cart_info!.product as any).attrInfo.price).toBe('1.2300');
    expect(item.cart_info!.promotion_quote_version).toBe(snapshot.promotion_quote_version);
    expect(item.cart_info!.truePrice).toBe('0.13'); expect(item.cart_info!.unknown).toEqual(snapshot.unknown);
    expect((item.cart_info!.sku as any).price).toBe('007.00');
    expect(trace.map(row => row.table)).toEqual(['system_supplier', 'system_attachment']);
  });

  it('preserves raw non-string fields and independently authorizes a top array already converted by the original String projection', async () => {
    for (const raw of [[ref(9101)], false, 0, 42, {}, null]) {
      const snapshot = { product: { image: structuredClone(raw), attrInfo: { image: raw } },
        productInfo: { image: raw, attrInfo: { image: raw } }, sku: { image: raw } };
      const item = target(1, String(raw ?? ''), structuredClone(snapshot));
      await project([owner(1)], [item]); expect(item.cart_info).toEqual(snapshot);
      if (Array.isArray(raw)) signed(item.image, ref(9101)); else expect(item.image).toBe('');
    }
    const foreign = target(1, String([ref(9102)]), { product: { image: [ref(9102)] } });
    await project([owner(1)], [foreign]); expect(foreign.image).toBe(''); expect((foreign.cart_info!.product as any).image).toEqual([ref(9102)]);
  });

  it('preserves explicit empty and absent shapes rather than adding fields or attr-first precedence', async () => {
    const targets = [target(1, '', { product: { image: '' }, productInfo: { image: ref(9101) } }),
      target(2, '', { other: { image: ref(9101) } }), target(3, '', null)];
    await project(targets.map(item => owner(item.id)), targets);
    expect(targets[0].image).toBe(''); expect((targets[0].cart_info!.product as any).image).toBe('');
    signed((targets[0].cart_info!.productInfo as any).image, ref(9101));
    expect(targets[1].cart_info).toEqual({ other: { image: ref(9101) } }); expect(targets[2].cart_info).toBeNull();
  });

  it('maps only a persisted positive int32 store relation to platform authority', async () => {
    for (const relationId of [1, 77, 2_147_483_647]) {
      const item = target(1, ref(9101)); await project([owner(1, 1, relationId)], [item]); signed(item.image, ref(9101));
    }
    for (const invalid of [owner(1, 0, 310), owner(1, 1, 0), owner(1, 1, -1), owner(1, 1, 2_147_483_648),
      owner(1, 2, 0), owner(1, -1), owner(1, 3), owner(0), owner(Number.NaN)]) {
      const item = target(1, ref(9101), { product: { image: ref(9101), type: 0, relation_id: 0 } });
      await project([invalid], [item]); expect(item.image).toBe(''); expect((item.cart_info!.product as any).image).toBe('');
    }
  });

  it('requires active same-supplier authority including platform fallback and does not trust JSON owner claims', async () => {
    for (const image of [ref(9101), ref(9102)]) {
      const item = target(1, image); await project([owner(1, 2, 310)], [item]); signed(item.image, image);
      const inactive = target(1, image); await project([owner(1, 2, 310)], [inactive], transport(undefined, [320])); expect(inactive.image).toBe('');
    }
    for (const image of [ref(9102), ref(9103)]) {
      const item = target(1, image, { product: { image, type: 2, relation_id: 310 } });
      await project([owner(1)], [item]); expect(item.image).toBe('');
    }
  });

  it('rejects raw or once-decoded control, backslash or whitespace before removing any suffix', async () => {
    const bad = ['javascript:alert(1)', 'data:image/png,AAAA', 'http://legacy.example.test/x.png', '//legacy.example.test/x.png',
      'https://u:p@legacy.example.test/x.png', '/a\\b.png', '/a b.png', '/a\u0000b.png', '/a\u007fb.png',
      '/a&#92;b.png', '/a&#x00;b.png', '/a&#127;b.png', '/a&#32;b.png',
      ref(9101) + '?old=\n', ref(9101) + '?old=&#10;', ref(9101) + '#old=&#92;',
      ref(9101) + '?old=a b', ref(9101) + '?old=&#x7f;'];
    for (const image of bad) {
      const item = target(1, image); const local = transport(); await project([owner(1)], [item], local);
      expect(item.image, JSON.stringify(image)).toBe(''); expect((item.cart_info!.product as any).image).toBe(''); expect(local.trace).toEqual([]);
    }
  });

  it('decodes exactly once, strips stale canonical tickets and preserves safe root/HTTPS legacy query text', async () => {
    const item = target(1, ref(9101) + '?expires=1&amp;signature=old#old');
    await project([owner(1)], [item]); signed(item.image, ref(9101)); expect(item.image).not.toContain('old');
    for (const [input, output] of [['/static/a&amp;#32;b.png', '/static/a&#32;b.png'],
      ['https://legacy.example.test/a.png?x=1&amp;y=2', 'https://legacy.example.test/a.png?x=1&y=2']]) {
      const legacy = target(1, input), local = transport(); await project([owner(1)], [legacy], local);
      expect(legacy.image).toBe(output); expect(local.trace).toEqual([]);
    }
  });

  it('allows safe legacy references beyond 256Ki within the aggregate JSON budget and needs no SQL or signing key', async () => {
    for (const image of ['/' + '图'.repeat(300_000), 'https://legacy.example.test/' + 'x'.repeat(300_000) + '.png?x=1&y=2']) {
      const item = target(1, image), local = transport();
      assertKefuSplitCartPreviewBudget([{ cartInfo: JSON.stringify(item.cart_info) }]);
      const slots = await readKefuSplitCartMedia(local.db, [owner(1)], [item]);
      await renderKefuSplitCartMedia(undefined, slots); expect(item.image).toBe(image); expect(local.trace).toEqual([]);
    }
  });

  it('rejects malformed canonical int32 IDs before attachment SQL', async () => {
    for (const image of ['/api/assets/0', '/api/assets/02', '/api/assets/-1', '/api/assets/2147483648', '/api/assets/1/no.png']) {
      const item = target(1, image), local = transport(); await project([owner(1)], [item], local);
      expect(item.image).toBe(''); expect(local.trace).toEqual([]);
    }
  });

  it('checks contradictory metadata and object namespace through the real shared policy', async () => {
    const original = attachment(9101);
    for (const patch of [{ moduleType: 2 }, { fileType: 0 }, { imageType: 1 }, { type: 2, relationId: 310 },
      { attDir: ref(9102) }, { name: 'attachments/admin/0/wrong.png' }, { name: 'attachments/admin/1/../wrong.png' },
      { name: 'attachments/admin/1/a\\b.png' }, { name: 'attachments/admin/1/wrong.svg', attType: 'image/svg+xml' },
      { attType: 'text/html' }, { attType: 'image/jpeg' }]) {
      const item = target(1, ref(9101)); await project([owner(1)], [item], transport([{ ...original, ...patch }])); expect(item.image, JSON.stringify(patch)).toBe('');
    }
    const emptyMime = target(1, ref(9101)); await project([owner(1)], [emptyMime], transport([{ ...original, attType: '' }])); signed(emptyMime.image, ref(9101));
  });

  it('deduplicates mirrored top/raw paths by owner and reference while retaining independent authorization', async () => {
    const items = [target(1, ref(9102), { product: { image: ref(9102), attrInfo: { image: ref(9102) } }, sku: { image: ref(9102) } }),
      target(2, ref(9102), { product: { image: ref(9102) } })];
    const local = transport(); await project([owner(1, 2, 310), owner(2, 2, 320)], items, local);
    signed(items[0].image, ref(9102)); expect(items[1].image).toBe(''); expect((items[1].cart_info!.product as any).image).toBe('');
    expect(local.trace.map(row => row.table)).toEqual(['system_supplier', 'system_attachment']);
  });

  it('accepts exactly 10000 rows and rejects10001 before any supplier or attachment SQL', async () => {
    const local = transport(), allowed = Array.from({ length: 10_000 }, (_, i) => target(i + 1, ref(9101)));
    await project(allowed.map(item => owner(item.id, 2, 310)), allowed, local);
    expect(local.trace.map(row => row.table)).toEqual(['system_supplier', 'system_attachment']);
    expect(allowed[9999].image).toBe(allowed[0].image); signed(allowed[0].image, ref(9101));
    const rejected = transport(), tooMany = [...allowed, target(10_001, ref(9101))];
    await expect(readKefuSplitCartMedia(rejected.db, tooMany.map(item => owner(item.id)), tooMany)).rejects.toThrow();
    expect(rejected.trace).toEqual([]);
  });

  it('sends the10001st distinct owner-reference to a second bounded shared-policy chunk', async () => {
    const assets = Array.from({ length: 10_001 }, (_, i) => attachment(100_000 + i));
    const items = Array.from({ length: 10_000 }, (_, i) => target(i + 1, ref(100_000 + i)));
    items[9999].cart_info = { product: { image: ref(109_999), attrInfo: { image: ref(110_000) } } };
    const local = transport(assets); const slots = await readKefuSplitCartMedia(local.db, items.map(item => owner(item.id, 2, 310)), items);
    expect(local.trace.filter(row => row.table === 'system_supplier')).toHaveLength(2);
    expect(local.trace.filter(row => row.table === 'system_attachment')).toHaveLength(2);
    expect(slots.some(slot => slot.reference === ref(110_000))).toBe(true);
    await renderKefuSplitCartMedia(key, slots); signed((items[9999].cart_info!.product as any).attrInfo.image, ref(110_000));
  });

  it('covers10000 rows with50000 unique recognized references in exactly five bounded chunks without an OOM stress workload', async () => {
    const assets = Array.from({ length: 50_000 }, (_, i) => attachment(200_000 + i));
    const items = Array.from({ length: 10_000 }, (_, i) => {
      const start = 200_000 + i * 5;
      return target(i + 1, ref(start), { product: { image: i % 2 ? [ref(start)] : ref(start), attrInfo: { image: ref(start + 1) } },
        productInfo: { image: ref(start + 2), attrInfo: { image: ref(start + 3) } }, sku: { image: ref(start + 4) } });
    });
    const local = transport(assets), slots = await readKefuSplitCartMedia(local.db, items.map(item => owner(item.id, 2, 310)), items);
    expect(local.trace.filter(row => row.table === 'system_supplier')).toHaveLength(5);
    const queries = local.trace.filter(row => row.table === 'system_attachment'); expect(queries).toHaveLength(5);
    expect(queries.every(row => row.params.filter(value => typeof value === 'number' && value >= 200_000).length <= 10_000)).toBe(true);
    expect(new Set(slots.map(slot => slot.reference)).size).toBe(50_000);
    expect(slots.some(slot => slot.reference === ref(249_999))).toBe(true);
    expect((items[9999].cart_info!.product as any).image).toEqual([ref(249_995)]);
    expect(slots.find(slot => slot.target === items[9999])?.reference).toBe(ref(249_995));
  });

  it('retains separate authority for the same reference on opposite sides of a chunk boundary', async () => {
    const assets = Array.from({ length: 10_000 }, (_, i) => attachment(300_000 + i, 2, 310));
    const items = Array.from({ length: 10_000 }, (_, i) => target(i + 1, ref(300_000 + i)));
    items[9999].cart_info = { product: { image: ref(300_000) } };
    const owners = items.map(item => owner(item.id, 2, item.id === 10_000 ? 320 : 310));
    const local = transport(assets), slots = await readKefuSplitCartMedia(local.db, owners, items);
    expect(local.trace.filter(row => row.table === 'system_attachment')).toHaveLength(2);
    expect(slots.find(slot => slot.target === items[0])?.reference).toBe(ref(300_000));
    expect(slots.filter(slot => slot.target === items[9999] || slot.target === items[9999].cart_info!.product).every(slot => slot.reference === '')).toBe(true);
  });
});
