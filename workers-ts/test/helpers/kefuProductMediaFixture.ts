import { createHash } from 'node:crypto';
import { SQL, sql } from 'drizzle-orm';
import { getTableConfig, PgDialect } from 'drizzle-orm/pg-core';
import type { Env } from '../../src/env';
import {
  storeOrder, storeOrderCartInfo, storeProduct, storeProductDescription,
  storeProductRelation, storeVisit, systemAttachment, systemSupplier,
} from '../../src/models/schema';
import { runtimeBusinessPrivilegePlan } from '../../src/migrations/runtimeBusinessPrivilegePlan';
import {
  adminAttachmentScope, R2_IMAGE_TYPE, supplierAttachmentScope, userAttachmentScope,
} from '../../src/services/system/AttachmentService';
import { kefuMobileTables, kefuMobileWorkbenchFixture } from './kefuMobileWorkbenchFixture';

const identifier = (value: string) => {
  if (!/^[a-z_][a-z_0-9]*$/.test(value)) throw Error('Invalid owned Kefu media fixture identifier');
  return `"${value}"`;
};
const additionalTables = [systemSupplier, storeProductDescription] as const;
type RuntimePeer = Parameters<Awaited<ReturnType<typeof kefuMobileWorkbenchFixture>>['installPlan']>[0];
type AttachmentName = 'platform' | 'supplier' | 'foreign' | 'user';
type StateRow = Record<string, unknown>;
type ResourceName = 'kvGet' | 'kvPut' | 'kvDelete' | 'kvList'
  | 'r2Get' | 'r2Head' | 'r2Put' | 'r2Delete' | 'r2List'
  | 'queueSend' | 'queueSendBatch' | 'sequence' | 'rateLimit'
  | 'chatTransfer' | 'chatDisconnect';
type ObjectRange = { offset?: number; length?: number; suffix?: number };

/** Owned native PG16, real independent LOGIN and actual Kefu application code.
 * Only infrastructure transports are local. All four registered objects exist,
 * including foreign/user objects, so absent bytes cannot hide an owner-policy
 * failure. No upload or external network call is needed to seed these objects. */
export async function kefuProductMediaFixture() {
  const base = await kefuMobileWorkbenchFixture();
  try {
    const dialect = new PgDialect();
    for (const table of additionalTables) {
      const definition = getTableConfig(table);
      const columns = definition.columns.map(column => {
        const initial = column.default;
        const value = initial === undefined ? '' : ` DEFAULT ${initial instanceof SQL
          ? dialect.sqlToQuery(initial).sql
          : dialect.sqlToQuery(sql`${initial}`.inlineParams()).sql}`;
        return `${identifier(column.name)} ${column.getSQLType()}${value}${column.notNull ? ' NOT NULL' : ''}${column.primary ? ' PRIMARY KEY' : ''}${column.isUnique ? ' UNIQUE' : ''}`;
      });
      await base.exec(`CREATE TABLE public.${identifier(definition.name)} (${columns.join(',')})`);
    }
    // Preserve the additional ORM tables' composite uniqueness and checks;
    // setup never catches DDL/ACL failures or repairs missing privileges.
    await base.exec('CREATE UNIQUE INDEX supplier_admin_id_uq ON public.system_supplier(admin_id)');
    await base.exec('CREATE INDEX supplier_status_idx ON public.system_supplier(is_show,is_del)');
    await base.exec('CREATE UNIQUE INDEX spd_product_type_unique ON public.store_product_description(product_id,type)');
    await base.exec('CREATE INDEX spd_type_product ON public.store_product_description(type,product_id)');
    await base.exec('ALTER TABLE public.store_product_description ADD CONSTRAINT spd_type_ck CHECK(type BETWEEN 0 AND 7) NOT VALID');

    const png = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGPQytn1HwAEZAJQNG7X8gAAAABJRU5ErkJggg==', 'base64'));
    const refs = { platform: '/api/assets/9101', supplier: '/api/assets/9102', foreign: '/api/assets/9103', user: '/api/assets/9104' } as const;
    const productIds = { platform: 501, supplier: 502, store: 503, foreign: 504, hidden: 505 } as const;
    const keys = {
      platform: 'attachments/admin/1/kefu-product-platform.png',
      supplier: 'attachments/supplier/310/kefu-product-supplier.png',
      foreign: 'attachments/supplier/320/kefu-product-foreign.png',
      user: 'attachments/user/201/kefu-product-user.png',
    } as const;
    const objects = new Map<string, Uint8Array>(Object.values(keys).map(key => [key, Uint8Array.from(png)]));
    const counters: Record<ResourceName, number> = {
      kvGet: 0, kvPut: 0, kvDelete: 0, kvList: 0,
      r2Get: 0, r2Head: 0, r2Put: 0, r2Delete: 0, r2List: 0,
      queueSend: 0, queueSendBatch: 0, sequence: 0, rateLimit: 0,
      chatTransfer: 0, chatDisconnect: 0,
    };
    const forbidden = (name: ResourceName) => async (..._args: unknown[]): Promise<never> => {
      counters[name]++;
      throw Error(`Kefu product GET attempted forbidden infrastructure effect: ${name}`);
    };
    const resetResources = () => { for (const name of Object.keys(counters) as ResourceName[]) counters[name] = 0; };
    const metadata = (key: string, value: Uint8Array) => {
      const etag = createHash('sha256').update(value).digest('hex');
      return { key, size: value.length, etag, httpEtag: `"${etag}"`, uploaded: new Date('2026-11-16T00:00:00.000Z'),
        httpMetadata: { contentType: 'image/png' },
        writeHttpMetadata: (headers: Headers) => { headers.set('Content-Type', 'image/png'); } };
    };
    const requestedRange = (input: Headers | ObjectRange | undefined, size: number): ObjectRange | undefined => {
      if (!input) return undefined;
      if (!(input instanceof Headers)) return input;
      const match = /^bytes=(\d*)-(\d*)$/.exec(input.get('Range') ?? '');
      if (!match) throw Error('Invalid owned object range');
      if (!match[1]) return { suffix: Number(match[2]) };
      const offset = Number(match[1]);
      return { offset, length: match[2] ? Number(match[2]) - offset + 1 : size - offset };
    };
    const bucket = {
      get: async (key: string, options?: { range?: Headers | ObjectRange }) => {
        counters.r2Get++;
        const value = objects.get(key);
        if (!value) return null;
        const range = requestedRange(options?.range, value.length);
        const offset = range?.suffix !== undefined ? Math.max(0, value.length - range.suffix) : range?.offset ?? 0;
        const length = range?.suffix !== undefined ? Math.min(value.length, range.suffix) : range?.length ?? value.length - offset;
        const bytes = value.slice(offset, offset + length);
        return { ...metadata(key, value), ...(range ? { range } : {}), body: new Response(bytes).body,
          arrayBuffer: async () => bytes.slice().buffer, text: async () => new TextDecoder().decode(bytes),
          blob: async () => new Blob([bytes], { type: 'image/png' }) };
      },
      head: async (key: string) => {
        counters.r2Head++;
        const value = objects.get(key);
        return value ? metadata(key, value) : null;
      },
      put: forbidden('r2Put'), delete: forbidden('r2Delete'), list: forbidden('r2List'),
    };
    // Mutate the original Env object, which the base auth/app factories close
    // over. They continue to use the same real key and dedicated token domain.
    base.env.ASSETS_BUCKET = bucket as unknown as Env['ASSETS_BUCKET'];
    base.env.CONFIG_KV = { get: async (..._args: unknown[]) => { counters.kvGet++; return null; },
      put: forbidden('kvPut'), delete: forbidden('kvDelete'), list: forbidden('kvList') } as unknown as Env['CONFIG_KV'];
    base.env.ORDER_QUEUE = { send: forbidden('queueSend'), sendBatch: forbidden('queueSendBatch') } as unknown as Env['ORDER_QUEUE'];
    base.env.SEQUENCE = { get: forbidden('sequence'), idFromName: forbidden('sequence'), getByName: forbidden('sequence') } as unknown as Env['SEQUENCE'];
    base.env.TOKEN_BUCKET = { getByName: () => ({ consumeRateLimit: async () => {
      counters.rateLimit++;
      return { allowed: true, auditEvent: false, limit: 10, remaining: 9, resetAt: Date.now() + 60_000 };
    } }) } as unknown as Env['TOKEN_BUCKET'];
    base.env.CHAT_ROOM = { getByName: () => ({ deliverTransfer: async () => { counters.chatTransfer++; return 0; },
      disconnectToken: async () => { counters.chatDisconnect++; return 0; } }) } as unknown as Env['CHAT_ROOM'];
    const resources = () => ({ ...counters, objects: [...objects].map(([key, value]) => ({ key, bytes: value.length,
      sha256: createHash('sha256').update(value).digest('hex') })).sort((a, b) => a.key.localeCompare(b.key)) });

    const attachmentRows = {} as Record<AttachmentName, typeof systemAttachment.$inferSelect>;
    const reset = async () => {
      for (const table of [...additionalTables].reverse()) await base.db.delete(table);
      await base.reset();
      await base.db.insert(systemSupplier).values([
        { id: 310, adminId: 31310, name: '客服媒体本属供应商', supplierName: '本属媒体', isShow: 1, isDel: 0 },
        { id: 320, adminId: 31320, name: '客服媒体外属供应商', supplierName: '外属媒体', isShow: 1, isDel: 0 },
      ]);
      const names = Object.keys(refs) as AttachmentName[];
      const scopes = { platform: adminAttachmentScope(), supplier: supplierAttachmentScope(310),
        foreign: supplierAttachmentScope(320), user: userAttachmentScope(201) };
      await base.db.insert(systemAttachment).values(names.map((name, index) => ({
        attId: 9101 + index, ...scopes[name], fileType: 1, imageType: R2_IMAGE_TYPE,
        name: keys[name], attDir: refs[name], sattDir: refs[name], attSize: String(png.length), attType: 'image/png',
        realName: `owned-kefu-${name}.png`, time: 1_700_000_000,
      })));
      const persisted = await base.db.select().from(systemAttachment).orderBy(systemAttachment.attId);
      for (let index = 0; index < names.length; index++) {
        const row = persisted[index];
        if (!row || row.attId !== 9101 + index) throw Error('Incomplete owned Kefu media attachment seed');
        attachmentRows[names[index]] = row;
      }
      await base.db.insert(storeProduct).values([
        { id: 501, type: 0, relationId: 0, pid: 0, storeName: '客服媒体平台商品', image: refs.platform,
          sliderImage: JSON.stringify([refs.platform, '/static/legacy-product.png', refs.platform, refs.foreign, refs.user]),
          price: '12.34', vipPrice: '11.11', otPrice: '19.99', stock: 11, sales: 10, ficti: 5, sort: 50, isShow: 1, isDel: 0, isVerify: 1 },
        { id: 502, type: 2, relationId: 310, pid: 0, storeName: '客服媒体供应商商品', image: refs.supplier,
          sliderImage: JSON.stringify([refs.supplier, refs.platform, refs.supplier, refs.foreign, refs.user]),
          price: '23.45', vipPrice: '22.22', otPrice: '29.99', stock: 12, sales: 20, ficti: 2, sort: 40, isShow: 1, isDel: 0, isVerify: 1 },
        { id: 503, type: 1, relationId: 77, pid: 0, storeName: '客服媒体门店商品', image: refs.platform,
          sliderImage: JSON.stringify([refs.platform, '/static/store.png', refs.supplier]),
          price: '34.56', vipPrice: '33.33', otPrice: '39.99', stock: 13, sales: 7, ficti: 1, sort: 30, isShow: 1, isDel: 0, isVerify: 1 },
        { id: 504, type: 0, relationId: 0, pid: 0, storeName: '客服媒体不匹配归属商品', image: refs.supplier,
          sliderImage: JSON.stringify([refs.supplier, refs.platform]),
          price: '45.67', vipPrice: '44.44', otPrice: '49.99', stock: 14, sales: 1, ficti: 0, sort: 20, isShow: 1, isDel: 0, isVerify: 1 },
        { id: 505, type: 0, relationId: 0, pid: 0, storeName: '客服媒体未发布目录商品', image: refs.platform,
          sliderImage: JSON.stringify([refs.platform]),
          price: '56.78', vipPrice: '55.55', otPrice: '59.99', stock: 15, sales: 100, ficti: 10, sort: 10, isShow: 0, isDel: 0, isVerify: 0 },
      ]);
      await base.db.insert(storeProductDescription).values(Object.values(productIds).map(productId => ({
        productId, type: 0, description: `<p>客服媒体商品 ${productId} 说明 & 保留文本展示</p>`,
      })));
      await base.db.insert(storeOrder).values({ id: 7001, uid: 201, orderId: 'owned-kefu-product-media-order' });
      await base.db.insert(storeOrderCartInfo).values(Object.values(productIds).map((productId, index) => ({
        id: 8101 + index, uid: 201, oid: 7001, productId, unique: `kefu-media-${productId}`, cartNum: 1,
      })));
      await base.db.insert(storeVisit).values([501, 502, 501, 503, 504, 505].map((productId, index) => ({
        id: 8201 + index, uid: 201, productId, addTime: 1_700_000_100 + index, count: 1,
      })));
      await base.db.insert(storeProductRelation).values(Object.values(productIds).map(productId => ({
        productId, type: 1, relationId: 10,
      })));
      resetResources();
    };
    await reset();

    const installPlan = async (peer: RuntimePeer) => {
      await base.installPlan(peer);
      const plan = runtimeBusinessPrivilegePlan('app');
      for (const table of additionalTables) {
        const definition = getTableConfig(table), privileges = plan.tables[definition.name];
        if (!privileges?.includes('SELECT')) throw Error('Actual app cannot read additional Kefu media table');
        await base.exec(`GRANT ${privileges.join(',')} ON public.${identifier(definition.name)} TO ${identifier(peer.role)}`);
        const columns = plan.updateColumns[definition.name];
        if (columns?.length) await base.exec(`GRANT UPDATE(${columns.map(identifier).join(',')}) ON public.${identifier(definition.name)} TO ${identifier(peer.role)}`);
        if (privileges.includes('INSERT')) for (const column of definition.columns) {
          if (column.getSQLType() === 'serial') await base.exec(`GRANT USAGE ON SEQUENCE public.${identifier(`${definition.name}_${column.name}_seq`)} TO ${identifier(peer.role)}`);
        }
      }
    };
    const tables = (await base.exec("SELECT tablename AS name FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).map(row => String(row.name));
    const expectedTables = [...kefuMobileTables, ...additionalTables].map(table => getTableConfig(table).name).sort();
    if (tables.length !== 20 || JSON.stringify(tables) !== JSON.stringify(expectedTables)) throw Error('Kefu media snapshot must cover all20 owned business tables');
    const sequences = (await base.exec("SELECT sequencename AS name FROM pg_sequences WHERE schemaname='public' ORDER BY sequencename")).map(row => String(row.name));
    const expectedSequences = ['kefu_visitor_uid_seq', ...[...kefuMobileTables, ...additionalTables].flatMap(table => {
      const definition = getTableConfig(table);
      return definition.columns.filter(column => column.getSQLType() === 'serial').map(column => `${definition.name}_${column.name}_seq`);
    })].sort();
    if (JSON.stringify(sequences) !== JSON.stringify(expectedSequences)) throw Error('Kefu media snapshot must cover every owned sequence');
    const snapshot = async () => {
      const state: Record<string, StateRow[]> = {};
      for (const name of tables) {
        const [row] = await base.exec(`SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb) AS rows FROM public.${identifier(name)} t`);
        state[name] = row.rows as StateRow[];
      }
      state.__sequences = await base.exec(sequences.map(name => `SELECT '${name}'::text AS name,last_value::text AS last_value,is_called FROM public.${identifier(name)}`).join(' UNION ALL ') + ' ORDER BY name');
      return state;
    };
    return { ...base, reset, installPlan, snapshot, resources, resetResources, png, refs, attachmentRows, productIds, tables, sequences };
  } catch (error) {
    await base.close();
    throw error;
  }
}
