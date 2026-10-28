import { randomUUID, createHash, createHmac } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { eq, sql } from 'drizzle-orm';
import { expect, vi } from 'vitest';
import type { Env } from '@/env';
import { createContainerFromDb } from '@/lib/di';
import { createToken, md5 } from '@/utils/jwt';
import { systemAttachment, systemConfig, user } from '@/models/schema';
import { refundRuntimeFixture } from './refundRuntimeFixture';
import { sortedDiyState, type DiyStateSnapshot, type DiyStateRow as Row } from './diyStateFixture';

export const SPREAD_POSTER = { a: 670011, b: 670012, template1: 670201, template2: 670202, avatarA: 670211, avatarB: 670212 } as const;
export const spreadPosterKeys = {
  template1: 'attachments/admin/1/2026/10/67000000-0000-4000-8000-000000000001.jpg',
  template2: 'attachments/admin/1/2026/10/67000000-0000-4000-8000-000000000002.jpg',
  avatarA: 'attachments/user/670011/2026/10/67000000-0000-4000-8000-000000000011.png',
  avatarB: 'attachments/user/670012/2026/10/67000000-0000-4000-8000-000000000012.png',
} as const;
/** Poster, fixed theme/suspended navigation, homepage QR and existing finance
 * target reads only. QR generation separately opts into the existing cache DML. */
export const SPREAD_POSTER_APP_READ_TABLES = ['cache', 'system_attachment', 'system_config', 'system_dise',
  'system_group', 'system_group_data', 'user', 'user_brokerage', 'user_extract'].sort();
export type SpreadPosterScenario = 'normal' | 'avatar-relative' | 'avatar-empty' | 'avatar-foreign' | 'template-relative'
  | 'template-foreign' | 'empty-templates' | 'password-revoked' | 'status-revoked' | 'deleted' | 'restore-account'
  | 'rename-owner' | 'restore-name' | 'missing-template' | 'corrupt-template' | 'restore-template'
  | 'missing-avatar' | 'corrupt-avatar' | 'restore-avatar';
const ids = SPREAD_POSTER;
const identifier = (value: string) => { if (!/^[a-z_][a-z_0-9]*$/.test(value)) throw Error('Invalid owned spread-poster identifier'); return '"' + value + '"'; };
const one = (rows: Row[], key: string, value: unknown) => { const found = rows.filter(row => row[key] === value); expect(found).toHaveLength(1); return found[0]!; };
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const sign = (secret: string, purpose: string, value: string) => createHmac('sha256', secret).update('legacy-share:v1:' + purpose + ':' + value).digest('hex');

/** Independent raw-row oracle: local website QR generation owns two exact cache
 * records. It consumes no serial and changes no financial/config/account row. */
export function assertSpreadPosterQrDelta(before: DiyStateSnapshot, after: DiyStateSnapshot, owner: number,
  start: number, end: number, appKey: string, origin = 'https://spread-poster-proof.test') {
  const added = after.cache.filter(row => !before.cache.some(old => old.key === row.key));
  expect(added).toHaveLength(2);
  const artifact = added.find(row => /^lshare:[a-f0-9]{24}$/.test(row.key));
  expect(artifact).toBeDefined();
  const document = JSON.parse(artifact!.result), { mac, ...unsigned } = document;
  expect(Object.keys(document).sort()).toEqual(['version', 'state', 'token', 'descriptor', 'created', 'expires', 'lease', 'leaseUntil', 'images', 'scene', 'mac'].sort());
  expect(document).toMatchObject({ version: 1, state: 'ready', leaseUntil: 0,
    descriptor: { type: -1, id: 0, uid: owner, origin, browser: false, official: false, permanent: false, miniApp: '', officialApp: '' } });
  expect(document.descriptor).toEqual({ type: -1, id: 0, uid: owner, origin, browser: false, official: false, permanent: false, miniApp: '', officialApp: '' });
  expect(document.token).toMatch(/^[a-f0-9]{24}$/); expect(document.lease).toMatch(/^[a-f0-9]{24}$/);
  expect(document.created).toBeGreaterThanOrEqual(Math.floor(start / 1000)); expect(document.created).toBeLessThanOrEqual(Math.floor(end / 1000));
  expect(document.expires).toBe(document.created + 30 * 86400); expect(mac).toBe(sign(appKey, 'document', JSON.stringify(unsigned)));
  const scene = 'ls:' + document.token + ':' + document.expires;
  expect(document.scene).toBe(scene + ':' + sign(appKey, 'official', scene).slice(0, 24));
  expect(Object.keys(document.images)).toEqual(['wechat']); expect(document.images.wechat.mime).toBe('image/gif');
  const qr = Buffer.from(document.images.wechat.base64, 'base64');
  expect(qr.subarray(0, 6).toString('ascii')).toMatch(/^GIF8[79]a$/); expect(qr.length).toBeGreaterThan(100);
  expect(qr.toString('base64')).toBe(document.images.wechat.base64);
  const indexKey = 'lsc:' + sign(appKey, 'index', JSON.stringify(document.descriptor)).slice(0, 28);
  const index = one(added, 'key', indexKey);
  expect(index.result).toBe(artifact!.result);
  for (const row of added) expect(row).toEqual({ key: row.key, result: artifact!.result, expire_time: document.expires, add_time: document.created });
  expect(artifact!.key).toBe('lshare:' + document.token);
  const expected = structuredClone(before); expected.cache.push(...added);
  expect(after).toEqual(sortedDiyState(expected));
  return { kind: 'local-h5-qr-cache', owner, token: document.token, index_key: indexKey, artifact_key: artifact!.key,
    target: origin + '/#/pages/share/landing?q=' + document.token, image_sha256: digest(qr), image_bytes: qr.length,
    cache_rows: added.map(row => row.key), sequence_allocations: 0 };
}

/** Complete migrated schema and separately authenticated non-owner PG16 LOGIN.
 * Both poster templates deliberately use the same sourced PHP600x1000 bytes in
 * two distinct platform-owned records; they are not claimed as distinct art. */
export async function spreadPosterFixture() {
  const f = await refundRuntimeFixture();
  try {
    const tables = (await f.exec("SELECT tablename AS name FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).map(row => String(row.name));
    const sequences = (await f.exec("SELECT sequencename AS name FROM pg_sequences WHERE schemaname='public' ORDER BY sequencename")).map(row => String(row.name));
    expect(tables).toHaveLength(283); expect(sequences).toHaveLength(229); [...tables, ...sequences].forEach(identifier);
    const snapshot = async () => {
      const state: DiyStateSnapshot = {};
      for (const row of await f.db.execute<{ name: string; rows: Row[] }>(sql.join(tables.map(name => sql`SELECT ${name}::text AS name,coalesce(jsonb_agg(to_jsonb(t)),'[]'::jsonb) AS rows FROM ${sql.identifier(name)} t`), sql` UNION ALL `))) state[row.name] = row.rows;
      state.__sequences = await f.db.execute(sql.join(sequences.map(name => sql`SELECT ${name}::text AS name,last_value::text AS last,is_called AS called FROM ${sql.identifier(name)}`), sql` UNION ALL `));
      return sortedDiyState(state);
    };
    const before = await snapshot(), seconds = Math.floor(Date.now() / 1000), appKey = randomUUID() + randomUUID();
    const password = md5('synthetic-spread-poster-' + randomUUID());
    const template = await readFile(resolve(import.meta.dirname, '../../../view/uniapp-ts/src/static/php-spread-poster/template.jpg'));
    expect(digest(template)).toBe('f87db1da52b726b502e172cfb61c6b4c396750359dafa58c796dce0300f609ce');
    const avatar = await readFile(resolve(import.meta.dirname, '../fixtures/community-teal.png'));
    const objects = new Map<string, { bytes: Uint8Array; type: string }>([
      [spreadPosterKeys.template1, { bytes: template, type: 'image/jpeg' }], [spreadPosterKeys.template2, { bytes: template, type: 'image/jpeg' }],
      [spreadPosterKeys.avatarA, { bytes: avatar, type: 'image/png' }], [spreadPosterKeys.avatarB, { bytes: avatar, type: 'image/png' }],
    ]);
    const assetReads: Row[] = [], kvReads: Row[] = [], budgetCalls: Row[] = [];
    const forbidden = vi.fn(() => { throw Error('Spread poster proof forbids providers/queues/resource writes'); });
    await f.db.insert(user).values([ids.a, ids.b].map(uid => ({ uid, pwd: password, nickname: uid === ids.a ? 'PHP海报本人甲' : 'PHP海报本人乙',
      avatar: '/api/assets/' + (uid === ids.a ? ids.avatarA : ids.avatarB), status: 1, isDel: 0, isPromoter: 1, spreadOpen: 1, brokeragePrice: '0.00' })));
    await f.db.insert(systemAttachment).values((['template1', 'template2', 'avatarA', 'avatarB'] as const).map(name => {
      const own = name.startsWith('avatar'), attId = ids[name], owner = name === 'avatarA' ? ids.a : ids.b, bytes = own ? avatar : template;
      return { attId, name: spreadPosterKeys[name], type: own ? 3 : 1, relationId: own ? owner : 0, moduleType: own ? 3 : 1,
        fileType: 1, imageType: 8, attDir: '/api/assets/' + attId, sattDir: '/api/assets/' + attId, attType: own ? 'image/png' : 'image/jpeg', attSize: String(bytes.length) };
    }));
    const templateConfig = JSON.stringify(['/api/assets/' + ids.template1, '/api/assets/' + ids.template2]);
    const settings = { spread_banner: templateConfig, site_name: '"PHP推广海报验收"', site_url: '"https://spread-poster-proof.test/"',
      share_qrcode: '0', spread_share_forever: '0', routine_appId: '""', routine_appsecret: '""', wechat_appid: '""', station_open: '1', brokerage_func_status: '1' };
    for (const [menuName, value] of Object.entries(settings)) {
      await f.db.update(systemConfig).set({ value, sort: 30000, isStore: 0 }).where(eq(systemConfig.menuName, menuName));
      if (!(await f.db.select().from(systemConfig).where(eq(systemConfig.menuName, menuName))).length) await f.db.insert(systemConfig).values({ menuName, value, sort: 30000, isStore: 0 });
    }
    const configCache = new Map<string, string>();
    const cache = async () => { configCache.clear(); for (const row of (await f.db.select().from(systemConfig)).filter(row => row.isStore === 0).sort((a, b) => b.sort - a.sort || b.id - a.id)) if (!configCache.has(row.menuName)) configCache.set(row.menuName, String(row.value ?? '')); };
    await cache();
    const tokens = new Map<number, string>(); for (const uid of [ids.a, ids.b]) tokens.set(uid, (await createToken(uid, 'api', md5(password), appKey)).token);
    const resources = () => ({ forbidden: forbidden.mock.calls.length, objects: [...objects].map(([key, value]) => ({ key, bytes: value.bytes.length, type: value.type, sha256: digest(value.bytes) })).sort((a, b) => a.key.localeCompare(b.key)) });
    async function control(scenario: SpreadPosterScenario) {
      const before = await snapshot(), expected = structuredClone(before), resourcesBefore = resources();
      const account = async (changes: Partial<typeof user.$inferInsert>, raw: Row) => { await f.db.update(user).set(changes).where(eq(user.uid, ids.a)); Object.assign(one(expected.user, 'uid', ids.a), raw); };
      const templates = async (value: string) => { await f.db.update(systemConfig).set({ value }).where(eq(systemConfig.menuName, 'spread_banner')); for (const row of expected.system_config) if (row.menu_name === 'spread_banner') row.value = value; };
      if (scenario === 'normal') { await account({ avatar: '/api/assets/' + ids.avatarA }, { avatar: '/api/assets/' + ids.avatarA }); await templates(templateConfig); }
      else if (scenario === 'avatar-relative') await account({ avatar: '/static/logo.png' }, { avatar: '/static/logo.png' });
      else if (scenario === 'avatar-empty') await account({ avatar: '' }, { avatar: '' });
      else if (scenario === 'avatar-foreign') await account({ avatar: '/api/assets/' + ids.avatarB }, { avatar: '/api/assets/' + ids.avatarB });
      else if (scenario === 'template-relative') await templates('["/statics/arbitrary-poster.jpg"]');
      else if (scenario === 'template-foreign') await templates(JSON.stringify(['/api/assets/' + ids.avatarB]));
      else if (scenario === 'empty-templates') await templates('[]');
      else if (scenario === 'password-revoked') await account({ pwd: md5(password + '-revoked') }, { pwd: md5(password + '-revoked') });
      else if (scenario === 'status-revoked') await account({ status: 0 }, { status: 0 });
      else if (scenario === 'deleted') await account({ isDel: 1 }, { is_del: 1 });
      else if (scenario === 'restore-account') await account({ pwd: password, status: 1, isDel: 0, deleteTime: null }, { pwd: password, status: 1, is_del: 0, delete_time: null });
      else if (scenario === 'rename-owner' || scenario === 'restore-name') { const nickname = scenario === 'rename-owner' ? '海报本人资料已更新' : 'PHP海报本人甲'; await account({ nickname }, { nickname }); }
      else if (scenario === 'missing-template') objects.delete(spreadPosterKeys.template2);
      else if (scenario === 'corrupt-template') objects.set(spreadPosterKeys.template2, { bytes: Buffer.from('corrupt-template-payload'), type: 'image/jpeg' });
      else if (scenario === 'restore-template') objects.set(spreadPosterKeys.template2, { bytes: template, type: 'image/jpeg' });
      else if (scenario === 'missing-avatar') objects.delete(spreadPosterKeys.avatarA);
      else if (scenario === 'corrupt-avatar') objects.set(spreadPosterKeys.avatarA, { bytes: Buffer.from('corrupt-avatar-payload'), type: 'image/png' });
      else if (scenario === 'restore-avatar') objects.set(spreadPosterKeys.avatarA, { bytes: avatar, type: 'image/png' });
      else throw Error('Unknown finite spread-poster fixture control');
      await cache(); const after = await snapshot(); expect(after).toEqual(sortedDiyState(expected));
      return { kind: 'qa-finite-spread-poster-fixture', nonproof: true, scenario, before, after, resources_before: resourcesBefore, resources_after: resources() };
    }
    async function withApplication<T>(run: (runtime: { env: Env; container: ReturnType<typeof createContainerFromDb>; role: string; pid: number; identities: Row[]; shareWrites: boolean }) => Promise<T>, options: { shareWrites?: boolean } = {}) {
      return f.withRuntimeRole!(async app => {
        const shareWrites = options.shareWrites === true;
        for (const table of SPREAD_POSTER_APP_READ_TABLES) { expect(tables).toContain(table); await f.exec('GRANT SELECT ON public.' + identifier(table) + ' TO ' + identifier(app.role)); }
        if (shareWrites) { await f.exec('GRANT INSERT ON public.cache TO ' + identifier(app.role)); await f.exec('GRANT UPDATE(result,expire_time,add_time) ON public.cache TO ' + identifier(app.role)); }
        const [identity] = await app.exec("SELECT current_user AS role,session_user AS session,pg_backend_pid() AS pid,current_setting('server_version_num') AS version,rolsuper,rolinherit,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls,rolcanlogin FROM pg_roles WHERE rolname=current_user");
        expect(identity.role).toBe(app.role); expect(identity.session).toBe(app.role); expect(identity.pid).toBe(app.pid); expect(identity.rolcanlogin).toBe(true); expect(Math.floor(Number(identity.version) / 10000)).toBe(16);
        for (const name of ['rolsuper', 'rolinherit', 'rolcreatedb', 'rolcreaterole', 'rolreplication', 'rolbypassrls']) expect(identity[name]).toBe(false);
        const reads = await app.exec("SELECT table_name FROM information_schema.role_table_grants WHERE grantee=current_user AND privilege_type='SELECT' ORDER BY table_name");
        expect(reads).toEqual(SPREAD_POSTER_APP_READ_TABLES.map(table_name => ({ table_name })));
        const grants = await app.exec("SELECT table_name,privilege_type FROM information_schema.role_table_grants WHERE grantee=current_user AND privilege_type<>'SELECT' ORDER BY table_name,privilege_type");
        expect(grants).toEqual(shareWrites ? [{ table_name: 'cache', privilege_type: 'INSERT' }] : []);
        const columns = await app.exec("SELECT table_name,column_name FROM information_schema.role_column_grants WHERE grantee=current_user AND privilege_type='UPDATE' ORDER BY table_name,column_name");
        expect(columns).toEqual(shareWrites ? ['add_time', 'expire_time', 'result'].map(column_name => ({ table_name: 'cache', column_name })) : []);
        const seqs: string[] = []; for (const name of sequences) { const [row] = await app.db.execute<{ allowed: boolean }>(sql`SELECT has_sequence_privilege(current_user,${'public.' + name},'USAGE,SELECT,UPDATE') AS allowed`); if (row.allowed) seqs.push(name); }
        expect(seqs).toEqual([]);
        const env = { ...f.env, APP_KEY: appKey, PUBLIC_H5_ORIGIN: 'https://spread-poster-proof.test', NODE_ENV: 'test', UPSTASH_REDIS_URL: '', UPSTASH_REDIS_TOKEN: '', HYPERDRIVE: { connectionString: app.connectionString },
          CONFIG_KV: { get: async (key: string) => { kvReads.push({ key, at_ms: Date.now() }); return key.startsWith('cfg_') ? configCache.get(key.slice(4)) ?? '' : null; }, put: forbidden, delete: forbidden, list: forbidden },
          ASSETS_BUCKET: { get: async (key: string) => { const value = objects.get(key); assetReads.push({ key, found: !!value, at_ms: Date.now(), bytes: value?.bytes.length ?? 0 }); if (!value) return null;
            const bytes = Uint8Array.from(value.bytes), etag = digest(bytes); return { size: bytes.length, etag, httpEtag: '"' + etag + '"', body: new Response(bytes).body, httpMetadata: { contentType: value.type }, writeHttpMetadata: (headers: Headers) => headers.set('Content-Type', value.type) }; }, put: forbidden, delete: forbidden, head: forbidden, list: forbidden },
          TOKEN_BUCKET: { getByName: (name: string) => ({ consumeRateLimit: async (requests: unknown, seconds: number) => { budgetCalls.push({ name, requests, seconds, at_ms: Date.now() }); return { allowed: true, resetAt: Date.now() + 60000 }; } }) },
          ORDER_QUEUE: { send: forbidden, sendBatch: forbidden }, SEQUENCE: { idFromName: forbidden, get: forbidden }, IMAGES: { input: forbidden },
        } as unknown as Env;
        return run({ env, container: createContainerFromDb(app.db), role: app.role, pid: app.pid, shareWrites,
          identities: [{ ...identity, select_tables: reads, table_grants: grants, column_updates: columns, sequence_permissions: seqs }] });
      });
    }
    return { ...f, appKey, tables, sequences, tokens, template, avatar, objects, assetReads, kvReads, budgetCalls, resources, forbidden, snapshot, control, withApplication,
      setup: { before, after: await snapshot(), seconds, owned_users: [ids.a, ids.b], template_ids: [ids.template1, ids.template2], avatar_ids: [ids.avatarA, ids.avatarB], local_template_sha256: digest(template), second_template_reuses_same_sourced_bytes: true } };
  } catch (error) { await f.close(); throw error; }
}
