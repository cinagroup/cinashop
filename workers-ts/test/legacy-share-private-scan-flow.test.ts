import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { Env } from '@/env';
import { createContainerFromDb, type DbClient } from '@/lib/di';
import { legacyCache, storeOrder, systemConfig, user } from '@/models/schema';
import { LegacyShareCodeService, parseLegacyShareInput, type LegacyShareActor } from '@/services/other/LegacyShareCodeService';
import { md5 } from '@/utils/jwt';
import { financePostgres } from './helpers/financePostgres';
import { MEMBER_CODE, ORDER_CODE, PRIVATE_SCAN_TABLES, seedPrivateScan, type PrivateScanFixture } from './helpers/legacyPrivateScanFixture';

const actor = (uid: number, password = ''): LegacyShareActor => ({ uid,
  authVersion: uid ? md5(password) : '', expiresAt: uid ? Math.floor(Date.now() / 1000) + 3600 : 0 });
const input = (type: 90 | 91) => parseLegacyShareInput(String(type), '0', new URLSearchParams(type === 91 ? 'order_id=owned-pickup-1' : ''));
const imageUrl = (path: string) => new URL(path, 'https://api.example.test');
const token = (path: string) => imageUrl(path).pathname.split('/')[5];

describe('private legacy share complete persisted opaque artifact flow', () => {
  let f: PrivateScanFixture;
  const env = { APP_KEY: 'owned-private-flow-key', PUBLIC_H5_ORIGIN: 'https://shop.example.test',
    UPSTASH_REDIS_URL: '', UPSTASH_REDIS_TOKEN: '', CONFIG_KV: { get: async () => null, put: async () => {}, delete: async () => {} } } as unknown as Env;
  beforeAll(async () => { f = await financePostgres([...PRIVATE_SCAN_TABLES, legacyCache, systemConfig], { namespace: 'public' }); });
  beforeEach(async () => { await seedPrivateScan(f); await f.db.insert(systemConfig).values([
    { menuName: 'site_name', value: '"本机商店"' }, { menuName: 'share_qrcode', value: '0' },
  ]); });
  afterAll(async () => { await f?.close(); });
  const service = (db = f.db) => new LegacyShareCodeService(createContainerFromDb(db), env,
    async () => { throw Error('Private H5 flow forbids external provider traffic'); });

  it.each([90, 91] as const)('runs owner type %s through persisted opaque generation, signed download and genuinely scoped decode', async type => {
    const worker = service(), raw = type === 90 ? MEMBER_CODE : ORDER_CODE;
    const reply = await worker.code(input(type), actor(11), false);
    expect(reply.wechatUrl).not.toContain(raw); expect(reply.routineUrl).not.toContain(raw);
    expect(token(reply.wechatUrl)).toMatch(/^[a-f0-9]{24}$/);
    const url = imageUrl(reply.wechatUrl);
    const image = await worker.image(token(reply.wechatUrl), 'wechat', url.searchParams);
    expect(image.headers.get('Content-Type')).toBe('image/gif');
    expect(image.headers.get('Cache-Control')).toBe('private, no-store');
    expect(new TextDecoder().decode(new Uint8Array(await image.arrayBuffer()).subarray(0, 6))).toBe('GIF87a');
    for (const uid of type === 90 ? [11, 101, 201, 301] : [11, 101, 301]) {
      const resolved = await worker.scene(token(reply.wechatUrl), actor(uid));
      expect(resolved).toMatchObject({ type, code: raw, namespace: type === 90 ? 'member' : 'order' });
      const realm = uid === 11 ? 'owner' : uid === 101 ? 'staff' : uid === 201 ? 'delivery' : 'customer';
      expect(resolved).toMatchObject({ viewer_scope: realm });
      expect(resolved.path).toBe(realm === 'owner' ? type === 90 ? '/pages/user/memberCode' : '/pages/order/detail?orderId=owned-pickup-1'
        : realm === 'staff' ? '/pages/operator/writeoff?role=staff' : realm === 'delivery' ? '/pages/delivery/scanning' : '/pages/customer-work/scanning');
      expect(resolved.path).not.toContain(raw);
    }
    for (const uid of [0, 12, 102, 302]) await expect(worker.scene(token(reply.wechatUrl), actor(uid))).rejects.toThrow();
    const forged = new URLSearchParams(url.searchParams); forged.set('signature', '0'.repeat(64));
    await expect(worker.image(token(reply.wechatUrl), 'wechat', forged)).rejects.toThrow();
    await expect(worker.code(parseLegacyShareInput('91', '0', new URLSearchParams('order_id=foreign-pickup-2')), actor(11), false)).rejects.toThrow(/本人订单/);
  });

  it.each([90, 91] as const)('rejects all old type %s artifacts after authoritative code replacement and regenerates a new opaque target', async type => {
    const worker = service(), old = await worker.code(input(type), actor(11), false), oldToken = token(old.wechatUrl);
    if (type === 90) await f.db.update(user).set({ barCode: 'changed-member' }).where(eq(user.uid, 11));
    else await f.db.update(storeOrder).set({ verifyCode: '998877665544' }).where(eq(storeOrder.id, 401));
    await expect(worker.scene(oldToken, actor(11))).rejects.toThrow(/变化/);
    await expect(worker.image(oldToken, 'wechat', imageUrl(old.wechatUrl).searchParams)).rejects.toThrow(/变化/);
    const current = await worker.code(input(type), actor(11), false);
    expect(token(current.wechatUrl)).not.toBe(oldToken);
    expect((await worker.scene(token(current.wechatUrl), actor(11)) as { code: string }).code).toBe(type === 90 ? 'changed-member' : '998877665544');
  });

  it('revalidates the real JWT password version after private viewer authority finishes', async () => {
    const reply = await service().code(input(90), actor(11), false);
    let snapshots = 0;
    const observed = new Proxy(f.db, { get(target, key, receiver) {
      if (key !== 'transaction') return Reflect.get(target, key, receiver);
      return async (read: (tx: DbClient) => Promise<unknown>, config?: Parameters<DbClient['transaction']>[1]) => {
        const value = await target.transaction(tx => read(tx as unknown as DbClient), config);
        // Core fresh owner snapshot + two helper target snapshots + true JWT
        // snapshot precede the viewer's first snapshot. The real committed
        // password change happens while that final helper is still reading.
        if (++snapshots === 5) await f.db.update(user).set({ pwd: 'rotated-during-private-read' }).where(eq(user.uid, 11));
        return value;
      };
    } });
    await expect(service(observed).scene(token(reply.wechatUrl), actor(11))).rejects.toThrow(/账户已变化/);
    expect(snapshots).toBeGreaterThanOrEqual(5);
  });

});
