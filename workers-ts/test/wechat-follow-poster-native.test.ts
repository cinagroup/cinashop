import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import type { Env } from '@/env';
import { createContainerFromDb, type DbClient } from '@/lib/di';
import { systemAttachment, systemConfig } from '@/models/schema';
import { WechatFollowPosterService } from '@/services/wechat/WechatFollowPosterService';
import { FOLLOW_BACKGROUND_BASE64 } from '@/services/wechat/WechatFollowBackground';
import { sequenceRunnerDatabase } from './helpers/kefuSequenceRunnerDatabase';

type Fixture = Awaited<ReturnType<typeof sequenceRunnerDatabase>>;
const png = Uint8Array.from(atob(FOLLOW_BACKGROUND_BASE64), value => value.charCodeAt(0));
const jpeg = new Uint8Array([255, 216, 255, 224, 0, 16, 255, 217]);

/** The probe observes actual transaction state, not a simulated SQL string. */
function readProbe(db: DbClient, observe: (tx: DbClient) => Promise<void>, active: { count: number }): DbClient {
  return new Proxy(db, { get(target, key) {
    const method: unknown = Reflect.get(target, key);
    if (typeof method !== 'function') return method;
    if (key !== 'transaction') return method.bind(target);
    return (callback: (tx: DbClient) => Promise<unknown>, ...options: unknown[]) => Reflect.apply(method, target, [(tx: DbClient) => {
      active.count++;
      const wrapped = new Proxy(tx, { get(transaction, property) {
        const operation: unknown = Reflect.get(transaction, property);
        if (typeof operation !== 'function') return operation;
        if (property !== 'execute') return operation.bind(transaction);
        return async (...args: unknown[]) => { const result: unknown = await Reflect.apply(operation, transaction, args); await observe(transaction); return result; };
      } });
      return Promise.resolve(callback(wrapped)).finally(() => { active.count--; });
    }, ...options]);
  } });
}

/** Synthetic image/storage bindings prove SQL boundaries and resource authority;
 * this suite makes no claim about real Cloudflare raster rendering. */
function rendering(active: { count: number }, afterInfo: () => Promise<void> = async () => {}) {
  const data = new Map<string, { bytes: Uint8Array; customMetadata?: Record<string, string>; httpMetadata: { contentType: string } }>([
    ['attachments/admin/1/follow.png', { bytes: png, httpMetadata: { contentType: 'image/png' } }],
  ]);
  let writes = 0;
  const env = { APP_KEY: 'owned-native-follow-key', PUBLIC_H5_ORIGIN: 'https://shop.example.com',
    ASSETS_BUCKET: {
      get: async (key: string) => { expect(active.count).toBe(0); const item = data.get(key); return item ? { ...item, size: item.bytes.length, body: new Response(item.bytes).body } : null; },
      put: async (key: string, bytes: Uint8Array, options: { customMetadata: Record<string, string>; httpMetadata: { contentType: string } }) => { expect(active.count).toBe(0); writes++; data.set(key, { ...options, bytes }); },
    },
    IMAGES: {
      info: async () => { expect(active.count).toBe(0); await afterInfo(); return { format: 'image/png', width: 500, height: 720 }; },
      input: () => { expect(active.count).toBe(0); const handle = { transform: () => handle, draw: () => handle,
        output: async () => ({ response: () => new Response(jpeg, { headers: { 'Content-Type': 'image/jpeg' } }) }) }; return handle; },
    },
  } as unknown as Env;
  return { env, writes: () => writes };
}

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('WeChat follow on independent PostgreSQL16 SELECT-only LOGIN', () => {
  let fixture: Fixture, ddl: string;
  beforeAll(async () => {
    const kit = await import('drizzle-kit/api');
    ddl = (await kit.generateMigration(kit.generateDrizzleJson({}), kit.generateDrizzleJson({ systemConfig, systemAttachment }))).join('\n');
  });
  beforeEach(async () => {
    fixture = await sequenceRunnerDatabase();
    if (fixture.format !== 'pg16' || !fixture.withRuntimeRole || !fixture.withPeer) throw Error('Follow native proof requires independent PG16 LOGIN peers');
    await fixture.exec(ddl);
    await fixture.db.insert(systemConfig).values({ id: 1, menuName: 'wechat_qrcode', value: '"/api/assets/41"' });
    await fixture.db.insert(systemAttachment).values({ attId: 41, type: 1, relationId: 0, moduleType: 1, fileType: 1, imageType: 8,
      name: 'attachments/admin/1/follow.png', attDir: '/api/assets/41', attType: 'image/png' });
  }, 60_000);
  afterEach(async () => { await fixture?.close(); }, 30_000);

  it('uses a genuine SELECT-only LOGIN and real RR/READ ONLY, with all image/storage work outside SQL and unchanged tables', async () => {
    await fixture.withRuntimeRole!(async peer => {
      if (!/^cinashop_runtime_[a-f0-9]{32}$/.test(peer.role)) throw Error('Unexpected owned runtime LOGIN');
      await fixture.exec(`GRANT SELECT ON public.system_config,public.system_attachment TO "${peer.role}"`);
      const [permissions] = await peer.exec(`SELECT current_user AS role,session_user AS session,pg_backend_pid() AS pid,
        has_table_privilege(current_user,'public.system_config','SELECT') AS read,
        has_any_column_privilege(current_user,'public.system_config','UPDATE') AS update,
        has_table_privilege(current_user,'public.system_config','INSERT') AS insert,
        has_table_privilege(current_user,'public.system_attachment','DELETE') AS delete`);
      expect(permissions).toEqual({ role: peer.role, session: peer.role, pid: peer.pid, read: true, update: false, insert: false, delete: false });
      const active = { count: 0 }; let snapshots = 0;
      const db = readProbe(peer.db, async tx => {
        const [state] = await tx.execute(sql`SELECT current_setting('transaction_isolation') AS isolation,current_setting('transaction_read_only') AS readonly,
          current_user AS role,session_user AS session,pg_backend_pid() AS pid`);
        expect(state).toEqual({ isolation: 'repeatable read', readonly: 'on', role: peer.role, session: peer.role, pid: peer.pid }); snapshots++;
      }, active), resources = rendering(active);
      const snapshot = async () => ({ config: await fixture.db.select().from(systemConfig), assets: await fixture.db.select().from(systemAttachment) });
      const before = await snapshot(), service = new WechatFollowPosterService(createContainerFromDb(db), resources.env,
        async () => { throw Error('Native follow tests forbid external fetch'); });
      const url = new URL((await service.follow('https://api.example.com/api/wechat/follow')).path);
      const response = await service.read(url.pathname.split('/').at(-1)!, url.searchParams.get('expires')!, url.searchParams.get('signature')!);
      expect(response.headers.get('Content-Type')).toBe('image/jpeg'); expect(snapshots).toBeGreaterThan(0); expect(active.count).toBe(0);
      expect(resources.writes()).toBe(1); expect(await snapshot()).toEqual(before);

      // Column UPDATE is intentionally granted only inside this owned fixture.
      // The outside write proves ACL works; READ ONLY must still reject it.
      await fixture.exec(`GRANT UPDATE(value) ON public.system_config TO "${peer.role}"`);
      await peer.db.update(systemConfig).set({ value: '"/api/assets/41"' }).where(eq(systemConfig.id, 1));
      let attempted = false;
      const counterfactual = readProbe(peer.db, async tx => {
        if (attempted) return; attempted = true;
        await tx.update(systemConfig).set({ value: 'must-not-write' }).where(eq(systemConfig.id, 1));
      }, { count: 0 });
      await expect(new WechatFollowPosterService(createContainerFromDb(counterfactual), resources.env).follow('https://api.example.com/api/wechat/follow'))
        .rejects.toMatchObject({ cause: { code: '25006' } });
      expect(attempted).toBe(true); expect(await snapshot()).toEqual(before);
    });
  }, 60_000);

  it('rejects configuration committed by an independent peer during image generation without saving a stale derivative', async () => {
    await fixture.withRuntimeRole!(async reader => fixture.withPeer!(async writer => {
      await fixture.exec(`GRANT SELECT ON public.system_config,public.system_attachment TO "${reader.role}"`);
      expect(writer.pid).not.toBe(reader.pid); const active = { count: 0 };
      const db = readProbe(reader.db, async () => {}, active), resources = rendering(active, async () => {
        await writer.db.update(systemConfig).set({ value: '' }).where(eq(systemConfig.id, 1));
      });
      await expect(new WechatFollowPosterService(createContainerFromDb(db), resources.env).follow('https://api.example.com/api/wechat/follow')).rejects.toThrow('请上传二维码');
      expect(resources.writes()).toBe(0); expect(active.count).toBe(0);
    }));
  }, 60_000);
});
