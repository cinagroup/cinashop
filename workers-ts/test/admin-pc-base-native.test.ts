import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '@/app';
import type { Env } from '@/env';
import { createContainerFromDb, type DbClient } from '@/lib/di';
import { systemAdmin, systemAttachment, systemAttachmentCategory, systemConfig, systemMenus, systemRole } from '@/models/schema';
import { runRuntimeBusinessCommissioning } from '@/migrations/runRuntimeBusinessCommissioning';
import { runAdminAuthorityOperationUpgrade } from '@/migrations/runAdminAuthorityOperationUpgrade';
import { inspectAdminAuthorityMenuLock } from '@/migrations/adminAuthorityOperation';
import { runAdminWechatMenuUpgrade } from '@/migrations/runAdminWechatMenuUpgrade';
import { runAdminWechatBaseUpgrade } from '@/migrations/runAdminWechatBaseUpgrade';
import { runAdminWechatOpenUpgrade } from '@/migrations/runAdminWechatOpenUpgrade';
import { runAdminPcBaseUpgrade } from '@/migrations/runAdminPcBaseUpgrade';
import { auditRuntimeBusinessPrivileges } from '@/migrations/auditRuntimeBusinessPrivileges';
import { inspectAdminPcBaseOperation } from '@/migrations/adminPcBaseOperation';
import { AdminPcBaseService } from '@/services/admin/AdminPcBaseService';
import { readPcBaseImageReferences } from '@/services/pc/PcBaseAssetPolicy';
import { PC_BASE_INSERT_METADATA } from '@/services/admin/AdminPcBaseMetadata';
import { PC_BASE_VIEW_SEED, PC_BASE_SAVE_SEED } from '@/services/admin/AdminPcBasePermissionBinding';
import { AdminPermissionService, canRetainOpaqueLegacyMenu } from '@/services/admin/AdminPermissionService';
import { createToken, md5 } from '@/utils/jwt';
import { refundRuntimeFixture } from './helpers/refundRuntimeFixture';
import { PC_BASE_KEYS, PC_BASE_MAX_BODY_BYTES, type PcBaseValues } from '../../view/common/pcBase';
import type { PcBaseIntentSave } from '../../view/common/pcBaseIntent';
import { WECHAT_OPEN_KEYS, WECHAT_OPEN_AUTHORITY_KEY, type WechatOpenSave } from '../../view/common/wechatOpen';
import { WECHAT_BASE_KEYS, WECHAT_BASE_CALLBACK_AUTHORITY_KEY, type WechatBaseSave } from '../../view/common/wechatBase';

type F = Awaited<ReturnType<typeof refundRuntimeFixture>>;
type Peer = Parameters<NonNullable<F['withRuntimeRole']>>[0] extends (peer: infer R) => unknown ? R : never;
type Names = { database: string; maintenance: string; app: string; admin: string; pricingOwner: string };
type NativeRow = { id: number; menu_name: string; is_store: number; value: string; sort: number; version: string; [key: string]: unknown };
const PASSWORD = 'owned-pc-base-test-password', KEY = 'owned-pc-base-signing-key', ID = 8990;
const issuedAt = Math.floor(Date.now() / 1000), expiry = issuedAt + 7 * 86400;
const actor = (index = 0) => ({ id: ID + index, authVersion: md5(PASSWORD), expiresAt: expiry });
// Canonical strings, exact legacy pair, page only, shared315 only, generic
// writers/readers, the two other config domains, owner, and unprivileged staff.
const roleRules = ['pc_base.manage', 'pc_base.view', '1361,315', '1361', '315', 'config.manage', 'config.view', 'wechat_open.manage', 'wechat_base.manage', '', ''];
const page = { ...PC_BASE_VIEW_SEED, menuName: 'PC基础配置', isShow: 0 };
const saveSeed = { ...PC_BASE_SAVE_SEED, menuName: '保存配置' };
const openDomain = [...WECHAT_OPEN_KEYS, WECHAT_OPEN_AUTHORITY_KEY];
const baseDomain = [...WECHAT_BASE_KEYS, WECHAT_BASE_CALLBACK_AUTHORITY_KEY];
const ticket = '/api/assets/991?expires=2000000000&signature=owned-pc-private-bearer-ticket';
// Independent expected tuples from fixed PHP8ed2a5b139f9170dd11b0dff91803f2fd59e40a5
// public/install/crmeb.sql; do not derive expected metadata from the writer's
// exported template. Each tuple omits only seed id/is_store/menu_name/value.
const phpMetadataColumns = ["type", "inputType", "configTabId", "parameter", "uploadType", "required", "width", "high", "info", "desc", "sort", "status"] as const;
const phpMetadataRows = [
  ["pc_logo", "upload", "", 74, "", 1, "", 0, 0, "PC端LOGO", "PC端右上角展示LOGO，建议尺寸：140 * 60px", 0, 1],
  ["bast_number", "text", "number", 74, "", 0, "required:true,digits:true,min:1", 100, 0, "精品推荐个数", "首页配置精品推荐个数", 0, 1],
  ["first_number", "text", "number", 74, "", 0, "required:true,digits:true,min:1", 100, 0, "首发新品个数", "首页配置首发新品个数", 0, 1],
  ["product_phone_buy_url", "radio", "", 74, "1=>公众号\n2=>小程序", 0, "", 0, 0, "商品手机购买跳转地址", "商品手机购买跳转地址（小程序|公众号）", 0, 1],
  ["contact_number", "text", "input", 74, "", 0, "", 100, 0, "联系电话", "", 0, 1],
  ["company_address", "text", "input", 74, "", 0, "", 100, 0, "公司地址", "", 0, 1],
  ["copyright", "text", "input", 74, "", 0, "", 100, 0, "版权信息", "", 0, 1],
  ["seo_title", "text", "input", 26, "", 0, "required:true", 100, 0, "SEO标题", "", 0, 0],
  ["site_keywords", "text", "input", 74, "", 0, "", 100, 0, "关键词", "", 0, 1],
  ["site_description", "textarea", "", 74, "", 0, "", 100, 5, "网站描述", "", 0, 1],
  ["links_open", "radio", "", 74, "1=>开启\r\n0=>关闭", 1, "", 0, 0, "友情链接开关", "友情链接开关", 0, 1],
  ["links_list", "textarea", "", 74, "", 1, "", 100, 5, "友情链接列表", "友情链接列表", 0, 1],
  ["filing_list", "textarea", "", 74, "", 1, "", 100, 5, "底部自定义", "PC底部自定义（公安备案、市场监管等）", 0, 1],
] as const;
const fixedPhpMetadata = Object.fromEntries(phpMetadataRows.map(([key, ...values]) =>
  [key, Object.fromEntries(phpMetadataColumns.map((name, index) => [name, values[index]]))]));
const settings = (): PcBaseValues => ({ pc_logo: 'http://images.example.test/original.png', bast_number: 151, first_number: 101,
  product_phone_buy_url: 2, contact_number: '4001234567', company_address: '  原始公司地址  ', copyright: '原始版权', seo_title: '历史SEO标题',
  site_keywords: '关键词', site_description: '第一行\n第二行', links_open: 1,
  links_list: [{ name: '保留顺序', url: 'http://example.test/first', sort: 1.25 }, { name: '第二行', url: '/second', sort: 0 }],
  filing_list: [{ icon: 'http://images.example.test/filing.png', name: '', url: '', sort: 0.5 }] });
function intent(revision: string, replacements: Partial<PcBaseValues> = {}): PcBaseIntentSave {
  const fields = Object.fromEntries(PC_BASE_KEYS.map(key => [key, Object.hasOwn(replacements, key)
    ? { action: 'replace', value: replacements[key] } : { action: 'keep' }])) as PcBaseIntentSave['fields'];
  return { request_id: randomUUID(), revision, fields, confirmed: true };
}
async function rows(db: DbClient): Promise<NativeRow[]> {
  const result = await db.execute<{ row: Record<string, unknown>; version: string }>(sql`SELECT to_jsonb(t) AS row,t.xmin::text AS version FROM public.system_config t ORDER BY t.id`);
  return Array.from(result, item => ({ ...item.row, version: item.version } as NativeRow));
}
const operations = async (db: DbClient) => Array.from(await db.execute(sql`SELECT * FROM public.admin_pc_base_operation ORDER BY operation_id`));
async function seed(f: F) {
  await f.db.delete(systemConfig).where(inArray(systemConfig.menuName, [...PC_BASE_KEYS, ...openDomain, ...baseDomain]));
  const values = settings();
  await f.db.insert(systemConfig).values(PC_BASE_KEYS.map(key => ({ ...PC_BASE_INSERT_METADATA[key], menuName: key,
    value: JSON.stringify(values[key]), isStore: 0 })));
  await f.db.insert(systemConfig).values([
    { menuName: 'wechat_open_app_id', value: '"wx1234567890abcdef"' },
    { menuName: 'wechat_open_app_secret', value: '"owned-pc-open-secret-never-readable"' },
    { menuName: WECHAT_OPEN_AUTHORITY_KEY, value: 'deployment' },
    ...WECHAT_BASE_KEYS.map(key => ({ menuName: key, value: JSON.stringify(key === 'wechat_appid' ? 'wx1234567890abcdef'
      : key === 'wechat_appsecret' ? 'owned-pc-base-secret-never-readable' : key === 'wechat_encodingaeskey' ? 'A'.repeat(43)
      : key === 'wechat_token' ? 'OwnedPcBaseToken' : key === 'wechat_qrcode' ? '' : 0) })),
    { menuName: WECHAT_BASE_CALLBACK_AUTHORITY_KEY, value: 'deployment' },
    { menuName: 'owned_pc_unrelated', value: '"unrelated original"' },
  ]);
  await f.db.insert(systemAttachment).values([
    { attId: 991, type: 1, relationId: 0, moduleType: 1, fileType: 1, imageType: 8, name: 'attachments/admin/1/2026/10/pc-logo.png', attDir: '/api/assets/991', sattDir: '/api/assets/991', attType: 'image/png' },
    { attId: 992, type: 2, relationId: 7, moduleType: 1, fileType: 1, imageType: 8, name: 'attachments/supplier/7/2026/10/pc-logo.png', attDir: '/api/assets/992', sattDir: '/api/assets/992', attType: 'image/png' },
    { attId: 993, type: 1, relationId: 0, moduleType: 1, fileType: 1, imageType: 8, name: 'attachments/admin/1/2026/10/bad-mime.png', attDir: '/api/assets/993', sattDir: '/api/assets/993', attType: 'text/html' },
    { attId: 994, type: 1, relationId: 0, moduleType: 1, fileType: 1, imageType: 8, name: 'attachments/admin/2/2026/10/wrong-owner.png', attDir: '/api/assets/994', sattDir: '/api/assets/994', attType: 'image/png' },
    { attId: 995, type: 1, relationId: 0, moduleType: 1, fileType: 1, imageType: 8, name: 'attachments/admin/1/2026/10/pc-filing.png', attDir: '/api/assets/995', sattDir: '/api/assets/995', attType: 'image/png' },
  ]);
}
async function fixture(run: (f: F, app: Peer, admin: Peer, names: Names) => Promise<void>, installPc = true) {
  const f = await refundRuntimeFixture();
  try {
    expect(f.format).toBe('pg16');
    await f.withRuntimeRole!(app => f.withRuntimeRole!(async admin => {
      expect(app.pid).not.toBe(admin.pid); expect(app.role).not.toBe(admin.role);
      const [context] = await f.exec('SELECT current_database() AS database,current_user AS maintenance');
      const names: Names = { database: String(context.database), maintenance: String(context.maintenance), app: app.role, admin: admin.role, pricingOwner: f.pricingOwner };
      await runRuntimeBusinessCommissioning(f.db, names);
      // PC authors use the mature staff -> exact menu fence. Commission its
      // existing addon explicitly; a request never installs missing locks.
      await runAdminAuthorityOperationUpgrade(f.db, names);
      expect(await inspectAdminAuthorityMenuLock(admin.db, names)).toBe(true);
      await runAdminWechatMenuUpgrade(f.db, names);
      await runAdminWechatBaseUpgrade(f.db, names);
      await runAdminWechatOpenUpgrade(f.db, names);
      await f.db.insert(systemRole).values(roleRules.map((rules, index) => ({ id: ID + index, roleName: 'Owned PC ' + index, rules })));
      await f.db.insert(systemAdmin).values(roleRules.map((_rules, index) => ({ id: ID + index, account: 'owned_pc_' + index,
        pwd: PASSWORD, roles: String(ID + index), level: index === 9 ? 0 : 1, adminType: 1 })));
      await f.db.delete(systemMenus).where(inArray(systemMenus.id, [1361, 315]));
      await f.db.insert(systemMenus).values([page, saveSeed]);
      await seed(f);
      if (installPc) await runAdminPcBaseUpgrade(f.db, names);
      try { await run(f, app, admin, names); }
      finally {
        // Close only pools opened by this fixture's real Hono requests, before
        // the existing runtime helper verifies/drops its self-owned LOGINs.
        await f.db.execute(sql`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=current_database()
          AND usename IN (${app.role},${admin.role}) AND application_name='cinashop_api' AND pid<>pg_backend_pid()`);
      }
    }));
  } finally { await f.close(); }
}
async function kit(f: F, app: Peer, admin: Peer) {
  const cache = { fail: false, invalidated: [] as string[], written: [] as string[] };
  const env = { HYPERDRIVE: { connectionString: app.connectionString }, HYPERDRIVE_ADMIN: { connectionString: admin.connectionString },
    APP_KEY: KEY, UPSTASH_REDIS_URL: '', UPSTASH_REDIS_TOKEN: '', CONFIG_KV: { get: async () => 'poisoned-old-pc-config',
      put: async (key: string) => { cache.written.push(key); }, delete: async (key: string) => { cache.invalidated.push(key); if (cache.fail) throw Error('Owned PC cache unavailable'); } } } as unknown as Env;
  // The service actor and JWT must carry the very same expiry: revision HMAC
  // intentionally binds exp, so a guessed test-only lifetime causes false CAS.
  const http = createApp(), tokens = await Promise.all(roleRules.map(async (_rules, index) => {
    const signed = await createToken(ID + index, 'admin', md5(PASSWORD), KEY, 'cinashop', issuedAt);
    expect(signed.exp).toBe(expiry); return signed.token;
  }));
  const call = async (path: string, method = 'GET', body?: unknown, index = 0, raw?: string) => {
    const response = await http.request(path, { method, headers: { Authorization: 'Bearer ' + tokens[index], 'Content-Type': 'application/json' },
      ...(body === undefined && raw === undefined ? {} : { body: raw ?? JSON.stringify(body) }) }, env);
    const text = await response.text();
    expect(text).not.toMatch(/owned-pc-(?:private-bearer-ticket|open-secret-never-readable|base-secret-never-readable|sql-reject-material)/u);
    const payload = JSON.parse(text) as { status: number; msg: string; data: any };
    // A real App connection is used by middleware. Release each generated
    // short-lived request pool without touching the stable runtime peers.
    await f.db.execute(sql`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=current_database()
      AND usename=${app.role} AND application_name='cinashop_api' AND pid<>pg_backend_pid()`);
    return { ...payload, headers: response.headers, httpStatus: response.status, text };
  };
  return { env, cache, call, service: new AdminPcBaseService(createContainerFromDb(admin.db), env) };
}
const bytes = (value: string) => new TextEncoder().encode(value).byteLength;
const padded = (value: unknown, count: number) => { const text = JSON.stringify(value); expect(bytes(text)).toBeLessThanOrEqual(count); return text + ' '.repeat(count - bytes(text)); };
async function foreignRows(db: DbClient) { return (await rows(db)).filter(row => row.is_store !== 0 || !(PC_BASE_KEYS as readonly string[]).includes(row.menu_name)); }

/** Schedule an independent writer after the real SELECT ... FOR SHARE has
 * completed. Every builder call and SQL result is the original Drizzle/PG
 * operation; only this test's inter-session scheduling is controlled. */
function afterRealImageLock(db: DbClient, after: (locked: Array<{ id: number }>, tx: DbClient) => Promise<void>): DbClient {
  return new Proxy(db, { get(target, key) {
    const member: unknown = Reflect.get(target, key);
    if (typeof member !== 'function') return member;
    if (key !== 'transaction') return member.bind(target);
    return (callback: (tx: DbClient) => Promise<unknown>, options: unknown) => target.transaction(async tx => {
      let port: DbClient;
      port = new Proxy(tx as unknown as DbClient, { get(current, property) {
        const fn: unknown = Reflect.get(current, property);
        if (typeof fn !== 'function') return fn;
        if (property !== 'select') return fn.bind(current);
        return (...args: unknown[]) => {
          const selection = Reflect.apply(fn, current, args) as { from: (table: unknown) => object };
          const fields = args[0] as Record<string, unknown> | undefined;
          if (!fields || Object.keys(fields).length !== 1 || fields.id !== systemAttachment.attId) return selection;
          return new Proxy(selection, { get(builder, method) {
            if (method !== 'from') { const value: unknown = Reflect.get(builder, method); return typeof value === 'function' ? value.bind(builder) : value; }
            return (table: unknown) => {
              const query = builder.from(table);
              if (table !== systemAttachment) return query;
              let observed: object;
              observed = new Proxy(query, { get(currentQuery, operation) {
                const call: unknown = Reflect.get(currentQuery, operation);
                if (typeof call !== 'function') return call;
                if (operation === 'for') return async (...lockArgs: unknown[]) => {
                  const selected = await Reflect.apply(call, currentQuery, lockArgs) as Array<{ id: number }>;
                  await after(selected, port);
                  return selected;
                };
                return (...queryArgs: unknown[]) => {
                  const next: unknown = Reflect.apply(call, currentQuery, queryArgs);
                  return next === currentQuery ? observed : next;
                };
              } });
              return observed;
            };
          } });
        };
      } });
      return callback(port);
    }, options as Parameters<typeof target.transaction>[1]);
  } });
}

// These are six native scenarios, not an expansion of the accepted Open three.
// Only the explicit loopback PG16 fixture runs; there is no SET ROLE, PGlite,
// SQL result mock, automatic repair, runtime grant fallback or provider call.
describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('PC base actual commissioned PG16 LOGIN and production dual-prefix Hono', () => {
  afterEach(() => vi.restoreAllMocks());

  it('commissions the independent exact immutable addon and rejects catalog ACL gate and runtime authority drift', async () => fixture(async (f, app, admin, names) => {
    const { service, env } = await kit(f, app, admin), snapshot = await service.read(actor());
    expect(snapshot.runtime_ready).toBe(false);
    await expect(service.save(intent(snapshot.revision, { copyright: '未安装不可保存' }), actor())).rejects.toMatchObject({ code: 503 });
    await expect(service.receipt(randomUUID(), actor())).rejects.toMatchObject({ code: 503 });
    const [before] = await f.exec("SELECT count(*)::integer AS n FROM pg_tables WHERE schemaname='public'");
    expect(await runAdminPcBaseUpgrade(f.db, names)).toMatchObject({ applied: true });
    expect(await runAdminPcBaseUpgrade(f.db, names)).toMatchObject({ applied: false });
    expect((await f.exec("SELECT count(*)::integer AS n FROM pg_tables WHERE schemaname='public'"))[0].n).toBe(Number(before.n) + 1);
    expect(await inspectAdminPcBaseOperation(f.db, names)).toBe(true);
    expect((await service.read(actor())).runtime_ready).toBe(true);
    for (const [peer, kind] of [[app, 'app'], [admin, 'admin']] as const) {
      expect(await auditRuntimeBusinessPrivileges(peer.db, kind, names)).toMatchObject({ ready: true, failures: [] });
      const [identity] = await peer.exec('SELECT current_user AS role,session_user AS session,rolinherit,rolsuper,rolcanlogin FROM pg_roles WHERE rolname=current_user');
      expect(identity).toMatchObject({ role: peer.role, session: peer.role, rolinherit: false, rolsuper: false, rolcanlogin: true });
    }
    const [catalog] = await f.exec("SELECT (SELECT count(*)::integer FROM pg_attribute WHERE attrelid='public.admin_pc_base_operation'::regclass AND attnum>0 AND NOT attisdropped) AS columns,(SELECT count(*)::integer FROM pg_constraint WHERE conrelid='public.admin_pc_base_operation'::regclass AND contype IN ('p','c')) AS constraints,(SELECT count(*)::integer FROM pg_trigger WHERE tgrelid='public.admin_pc_base_operation'::regclass) AS triggers");
    expect(catalog).toMatchObject({ columns: 9, constraints: 10, triggers: 2 });
    for (const command of ['SELECT * FROM public.admin_pc_base_operation', 'INSERT INTO public.admin_pc_base_operation DEFAULT VALUES']) await expect(app.exec(command)).rejects.toMatchObject({ code: '42501' });
    for (const command of ['UPDATE public.admin_pc_base_operation SET actor_id=actor_id', 'DELETE FROM public.admin_pc_base_operation', 'TRUNCATE public.admin_pc_base_operation', 'ALTER TABLE public.admin_pc_base_operation ADD COLUMN forbidden integer']) await expect(admin.exec(command)).rejects.toMatchObject({ code: '42501' });
    await f.withPeer!(peer => peer.db.transaction(async tx => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(731662,0)`);
      expect((await service.read(actor())).runtime_ready).toBe(false);
      await expect(service.save(intent(snapshot.revision), actor())).rejects.toMatchObject({ code: 503 });
      await expect(runAdminPcBaseUpgrade(f.db, names)).rejects.toThrow(/busy/u);
    }));
    await f.exec(`REVOKE INSERT ON public.admin_pc_base_operation FROM "${admin.role}"`);
    try { expect((await service.read(actor())).runtime_ready).toBe(false); await expect(service.save(intent(snapshot.revision), actor())).rejects.toMatchObject({ code: 503 }); }
    finally { await f.exec(`GRANT INSERT ON public.admin_pc_base_operation TO "${admin.role}"`); }
    await f.exec(`GRANT SELECT ON public.admin_pc_base_operation TO "${app.role}"`);
    try { expect(await inspectAdminPcBaseOperation(f.db, names)).toBe(false); expect((await auditRuntimeBusinessPrivileges(app.db, 'app', names)).ready).toBe(false); await expect(runAdminPcBaseUpgrade(f.db, names)).rejects.toBeDefined(); }
    finally { await f.exec(`REVOKE SELECT ON public.admin_pc_base_operation FROM "${app.role}"`); }
    await expect(f.db.transaction(async tx => {
      await tx.execute(sql`ALTER TABLE public.admin_pc_base_operation ADD COLUMN forbidden integer`);
      expect(await inspectAdminPcBaseOperation(tx, names)).toBe(false);
      throw Error('Owned PC catalog rollback');
    })).rejects.toThrow('Owned PC catalog rollback');
    expect(await inspectAdminPcBaseOperation(f.db, names)).toBe(true);
    await expect(new AdminPcBaseService(createContainerFromDb(f.db), env).save(intent(snapshot.revision), actor())).rejects.toMatchObject({ code: 503 });
    await expect(new AdminPcBaseService(createContainerFromDb(app.db), env).save(intent(snapshot.revision), actor())).rejects.toMatchObject({ code: 503 });
  }, false), 180000);

  it('keeps raw and missing fields, inserts explicit PHP metadata and refuses complete history beyond64 rows or1MiB without truncation', async () => fixture(async (f, app, admin) => {
    const { service, call } = await kit(f, app, admin);
    await f.db.delete(systemConfig).where(and(eq(systemConfig.isStore, 0), inArray(systemConfig.menuName, ['first_number', 'seo_title'])));
    await f.db.update(systemConfig).set({ value: '{bad historical JSON', info: 'original unexpected metadata' }).where(eq(systemConfig.menuName, 'company_address'));
    await f.db.update(systemConfig).set({ value: JSON.stringify([{ icon: ticket, name: '原始票据', url: '', sort: 0 }]) }).where(eq(systemConfig.menuName, 'filing_list'));
    // JSON slash escaping is part of the raw preservation contract.
    await f.db.update(systemConfig).set({ value: '"http:\\/\\/images.example.test\\/original.png"' }).where(eq(systemConfig.menuName, 'pc_logo'));
    await f.db.insert(systemConfig).values([{ menuName: 'pc_logo', sort: -1, value: JSON.stringify(ticket), parameter: 'preserve losing metadata' },
      { menuName: 'pc_logo', sort: 99, isStore: 7, value: JSON.stringify(ticket), info: 'store history' }]);
    const before = await rows(f.db), snapshot = await service.read(actor());
    expect(snapshot.settings.pc_logo).toBe('http://images.example.test/original.png');
    expect(snapshot.asset_previews.pc_logo).toBe('http://images.example.test/original.png');
    expect(snapshot.settings.company_address).toBeNull(); expect(snapshot.settings.filing_list).toBeNull();
    expect(snapshot.fields.company_address).toEqual({ present: true, parseable: false, redacted: true });
    expect(snapshot.fields.filing_list).toEqual({ present: true, parseable: true, redacted: true });
    expect(snapshot.fields.first_number.present).toBe(false); expect(snapshot.fields.seo_title.present).toBe(false);
    expect(JSON.stringify(snapshot)).not.toContain('owned-pc-private-bearer-ticket'); expect(snapshot).not.toHaveProperty('raw_public_values');
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('PC settings must not call providers or media'));
    const save = intent(snapshot.revision, { copyright: '只替换版权' });
    const result = await call('/adminapi/config/pc', 'POST', save);
    expect(result.status, result.msg).toBe(200); expect(result.data.state).toBe('committed');
    const after = await rows(f.db), winner = before.find(row => row.menu_name === 'copyright' && row.is_store === 0)!;
    for (const original of before) {
      const current = after.find(row => row.id === original.id)!;
      if (original.id !== winner.id) expect(current).toEqual(original);
      else { const { value: _old, version: _oldVersion, ...oldMeta } = original, { value: _new, version: _newVersion, ...newMeta } = current;
        expect(newMeta).toEqual(oldMeta); expect(current.value).toBe(JSON.stringify('只替换版权')); expect(current.version).not.toBe(original.version); }
    }
    expect(after).toHaveLength(before.length);
    const keepBaseline = await rows(f.db), allKeep = intent((await service.read(actor())).revision);
    await service.save(allKeep, actor()); expect(await rows(f.db)).toEqual(keepBaseline);
    expect(JSON.stringify(await operations(admin.db))).not.toContain('owned-pc-private-bearer-ticket');
    for (const bad of ['/api/assets/992', '/api/assets/993', '/api/assets/994', '/api/assets/999999', ticket, 'javascript:alert(1)']) {
      await expect(service.save(intent((await service.read(actor())).revision, { pc_logo: bad }), actor())).rejects.toMatchObject({ code: 400 });
      expect(await rows(f.db)).toEqual(keepBaseline);
    }
    const foreign = await foreignRows(f.db);
    await f.db.delete(systemConfig).where(and(eq(systemConfig.isStore, 0), inArray(systemConfig.menuName, [...PC_BASE_KEYS])));
    const empty = await service.read(actor()); expect(PC_BASE_KEYS.every(key => empty.fields[key].present === false)).toBe(true);
    const values = settings(); values.pc_logo = 'http://images.example.test/new-safe-http.png';
    const inserted = await service.save(intent(empty.revision, values), actor()); expect(inserted.state).toBe('committed');
    const insertedRows = await f.db.select().from(systemConfig).where(and(eq(systemConfig.isStore, 0), inArray(systemConfig.menuName, [...PC_BASE_KEYS])));
    expect(insertedRows).toHaveLength(13);
    expect(Object.keys(fixedPhpMetadata).sort()).toEqual([...PC_BASE_KEYS].sort());
    expect(PC_BASE_INSERT_METADATA).toEqual(fixedPhpMetadata);
    for (const key of PC_BASE_KEYS) {
      const current = insertedRows.find(row => row.menuName === key)!;
      const { id, menuName, isStore, value, ...meta } = current;
      expect(id).toBeGreaterThan(0); expect(menuName).toBe(key); expect(isStore).toBe(0);
      expect(value).toBe(JSON.stringify(values[key])); expect(meta).toEqual(fixedPhpMetadata[key]);
    }
    expect(await foreignRows(f.db)).toEqual(foreign);
    const final = await service.read(actor()); expect(final.settings).toEqual(values); expect(final.settings.bast_number).toBe(151); expect(final.settings.first_number).toBe(101);
    // All thirteen source rows plus51 distinct losing rows are readable. An
    // all-keep save must retain every raw value, metadata field and xmin.
    await f.db.insert(systemConfig).values(Array.from({ length: 51 }, (_unused, index) => ({
      ...PC_BASE_INSERT_METADATA.copyright, menuName: 'copyright', isStore: 0, sort: -10,
      value: JSON.stringify('owned capacity loser ' + index), info: 'capacity loser metadata ' + index,
    })));
    const platformRows = (source: NativeRow[]) => source.filter(row => row.is_store === 0 && (PC_BASE_KEYS as readonly string[]).includes(row.menu_name));
    const sixtyFourRows = await rows(f.db); expect(platformRows(sixtyFourRows)).toHaveLength(64);
    const sixtyFour = await service.read(actor()); expect(sixtyFour.settings).toEqual(values);
    expect(await service.save(intent(sixtyFour.revision), actor())).toMatchObject({ state: 'committed' });
    expect(await rows(f.db)).toEqual(sixtyFourRows);
    const operationsAt64 = await operations(admin.db);
    const [sixtyFifth] = await f.db.insert(systemConfig).values({ ...PC_BASE_INSERT_METADATA.copyright,
      menuName: 'copyright', isStore: 0, sort: -20, value: '"owned row65 must not be ignored"' }).returning({ id: systemConfig.id });
    const sixtyFiveRows = await rows(f.db); expect(platformRows(sixtyFiveRows)).toHaveLength(65);
    await expect(service.read(actor())).rejects.toMatchObject({ code: 503 });
    await expect(service.save(intent(sixtyFour.revision, { copyright: 'must not truncate row65' }), actor())).rejects.toMatchObject({ code: 503 });
    expect(await rows(f.db)).toEqual(sixtyFiveRows); expect(await operations(admin.db)).toEqual(operationsAt64);
    await f.db.delete(systemConfig).where(eq(systemConfig.id, sixtyFifth.id));
    // PostgreSQL varchar(5000) counts Unicode characters, not UTF-8 bytes.
    // Each value is valid JSON with exactly5000 PG characters; all64 legal
    // values together exceed1MiB without changing the schema or row ceiling.
    const legalLargeRaw = JSON.stringify('😀'.repeat(4998)); expect(bytes(legalLargeRaw)).toBe(19994);
    const pcPlatform = and(eq(systemConfig.isStore, 0), inArray(systemConfig.menuName, [...PC_BASE_KEYS]));
    await f.db.update(systemConfig).set({ value: legalLargeRaw }).where(pcPlatform);
    const [capacity] = await f.db.select({ count: sql<number>`count(*)::integer`, minChars: sql<number>`min(char_length(${systemConfig.value}))::integer`,
      maxChars: sql<number>`max(char_length(${systemConfig.value}))::integer`, rawBytes: sql<string>`sum(octet_length(${systemConfig.value}))::text` })
      .from(systemConfig).where(pcPlatform);
    expect(capacity).toMatchObject({ count: 64, minChars: 5000, maxChars: 5000 }); expect(Number(capacity.rawBytes)).toBeGreaterThan(1024 * 1024);
    const overByteLimit = await rows(f.db); expect(platformRows(overByteLimit)).toHaveLength(64);
    await expect(service.read(actor())).rejects.toMatchObject({ code: 503 });
    await expect(service.save(intent(sixtyFour.revision, { copyright: 'must not truncate UTF8 history' }), actor())).rejects.toMatchObject({ code: 503 });
    expect(await rows(f.db)).toEqual(overByteLimit); expect(await operations(admin.db)).toEqual(operationsAt64);
    expect(await foreignRows(f.db)).toEqual(foreign);
    expect(fetch).not.toHaveBeenCalled();
  }), 180000);

  it('rolls back real late SQL and post-insert failures, preserves immutable replay and seals owner recovery after permission loss', async () => fixture(async (f, app, admin) => {
    const { service, call, cache } = await kit(f, app, admin), baseline = await rows(f.db), opBefore = await operations(admin.db);
    const failed = intent((await service.read(actor())).revision, { pc_logo: 'http://images.example.test/early-write.png',
      filing_list: [{ icon: '', name: 'owned-pc-sql-reject-material', url: '', sort: 0 }] });
    await f.exec("ALTER TABLE public.system_config ADD CONSTRAINT owned_pc_reject_late CHECK(value NOT LIKE '%owned-pc-sql-reject-material%')");
    const sqlFailure = vi.spyOn(service as unknown as { failure: (error: unknown) => never }, 'failure');
    try {
      try { await service.save(failed, actor()); throw Error('Expected real SQL rejection'); }
      catch (error) { expect(error).toMatchObject({ code: 503 }); expect(error).not.toHaveProperty('cause'); expect(String(error)).not.toContain('owned-pc-sql-reject-material'); }
      const chain: Array<{ code: unknown; constraint: unknown }> = [];
      let rawFailure = sqlFailure.mock.calls[0]?.[0];
      for (let depth = 0; depth < 8 && rawFailure && typeof rawFailure === 'object'; depth++) {
        const error = rawFailure as { code?: unknown; constraint_name?: unknown; cause?: unknown };
        chain.push({ code: error.code, constraint: error.constraint_name }); rawFailure = error.cause;
      }
      expect(chain).toContainEqual({ code: '23514', constraint: 'owned_pc_reject_late' });
      expect(await rows(f.db)).toEqual(baseline); expect(await operations(admin.db)).toEqual(opBefore);
      await expect(service.receipt(failed.request_id, actor())).rejects.toMatchObject({ code: 404 });
    } finally { sqlFailure.mockRestore(); await f.exec('ALTER TABLE public.system_config DROP CONSTRAINT owned_pc_reject_late'); }
    // Test control at a real transaction boundary: the original append writes
    // and verifies its actual PG receipt, then publication throws. SQL and
    // authorization are never mocked or replaced with fabricated success.
    const internals = service as unknown as { append: (...args: any[]) => Promise<any> };
    const append = internals.append.bind(service), afterInsert = intent((await service.read(actor())).revision, { copyright: '回执后必须回滚' });
    const publication = vi.spyOn(internals, 'append').mockImplementationOnce(async (...args) => {
      const row = await append(...args), tx = args[0] as DbClient;
      expect((await tx.execute(sql`SELECT operation_id FROM public.admin_pc_base_operation WHERE operation_id=${afterInsert.request_id}::uuid`))).toHaveLength(1);
      expect((await tx.select({ value: systemConfig.value }).from(systemConfig).where(eq(systemConfig.menuName, 'copyright')))[0].value).toBe(JSON.stringify('回执后必须回滚'));
      expect(row.state).toBe('committed'); throw Error('Owned transport publication fault');
    });
    await expect(service.save(afterInsert, actor())).rejects.toMatchObject({ code: 503 }); publication.mockRestore();
    expect(await rows(f.db)).toEqual(baseline); expect(await operations(admin.db)).toEqual(opBefore);
    await expect(service.receipt(afterInsert.request_id, actor())).rejects.toMatchObject({ code: 404 });
    const revokedLate = intent((await service.read(actor())).revision, { copyright: '提交末尾仍须有权限' });
    const lateGrant = vi.spyOn(internals, 'append').mockImplementationOnce(async (...args) => {
      const receipt = await append(...args), tx = args[0] as DbClient;
      await tx.update(systemRole).set({ rules: '' }).where(eq(systemRole.id, ID));
      return receipt;
    });
    try { await expect(service.save(revokedLate, actor())).rejects.toMatchObject({ code: 400011 }); }
    finally { lateGrant.mockRestore(); }
    expect((await f.db.select({ rules: systemRole.rules }).from(systemRole).where(eq(systemRole.id, ID)))[0].rules).toBe('pc_base.manage');
    expect(await rows(f.db)).toEqual(baseline); expect(await operations(admin.db)).toEqual(opBefore);
    const [clock] = await f.exec('SELECT floor(extract(epoch FROM clock_timestamp()))::integer AS now');
    const deadlineActor = { ...actor(), expiresAt: Number(clock.now) + 3 }, frozenNow = Date.now();
    const deadlineSave = intent((await service.read(deadlineActor)).revision, { copyright: 'DB时限前不得提交' });
    const deadline = vi.spyOn(internals, 'append').mockImplementationOnce(async (...args) => {
      const row = await append(...args), tx = args[0] as DbClient;
      // Keep the real statement active (<5s), so idle-TX timeout is not the
      // refusal. Freeze only JS time; actual DB clock must enforce expiry.
      await tx.execute(sql`SELECT pg_sleep(GREATEST(0,${deadlineActor.expiresAt}+0.05-extract(epoch FROM clock_timestamp())))`);
      return row;
    });
    const jsClock = vi.spyOn(Date, 'now').mockReturnValue(frozenNow);
    try { await expect(service.save(deadlineSave, deadlineActor)).rejects.toMatchObject({ code: 410001 }); }
    finally { jsClock.mockRestore(); deadline.mockRestore(); }
    expect(await rows(f.db)).toEqual(baseline); expect(await operations(admin.db)).toEqual(opBefore);
    cache.fail = true; const committed = intent((await service.read(actor())).revision, { copyright: '真实提交后丢失ACK' });
    await expect((async () => { const result = await call('/api/admin/config/pc', 'POST', committed); expect(result.status, result.msg).toBe(200); expect(result.data.cache_status).toBe('pending'); throw Error('Owned dropped ACK'); })()).rejects.toThrow('Owned dropped ACK');
    const committedRows = await rows(f.db); cache.fail = false;
    expect((await service.receipt(committed.request_id, actor()))).toMatchObject({ state: 'committed', cache_status: 'cleared' });
    expect(await service.save(committed, actor())).toMatchObject({ state: 'committed', replayed: true });
    expect(await rows(f.db)).toEqual(committedRows);
    const different = intent(committed.revision, { copyright: '同UUID不同正文' }); different.request_id = committed.request_id;
    await expect(service.save(different, actor())).rejects.toMatchObject({ code: 409 });
    const copy = randomUUID();
    await f.db.execute(sql`INSERT INTO public.admin_pc_base_operation SELECT ${copy}::uuid,actor_id,operation,format_version,payload_hash,revision,state,result,created_at FROM public.admin_pc_base_operation WHERE operation_id=${committed.request_id}::uuid`);
    await expect(service.receipt(copy, actor())).rejects.toMatchObject({ code: 503 });
    for (const command of ['UPDATE public.admin_pc_base_operation SET actor_id=actor_id', 'DELETE FROM public.admin_pc_base_operation', 'TRUNCATE public.admin_pc_base_operation']) await expect(f.exec(command)).rejects.toMatchObject({ code: '42501' });
    const absent = intent((await service.read(actor())).revision, { copyright: '封存后不能提交' });
    await f.db.update(systemRole).set({ rules: '' }).where(eq(systemRole.id, ID));
    expect((await call('/adminapi/config/pc')).status).not.toBe(200);
    expect((await call('/adminapi/config/pc/operations/' + committed.request_id)).data.state).toBe('committed');
    const missingReceipt = await call('/adminapi/config/pc/operations/' + absent.request_id);
    expect(missingReceipt.status).toBe(404); expect(missingReceipt.headers.get('Cache-Control')).toBe('private, no-store');
    expect((await call('/api/admin/config/pc/operations/' + absent.request_id + '/resolve', 'POST', {})).status).not.toBe(200);
    expect((await call('/api/admin/config/pc/operations/' + absent.request_id + '/resolve', 'POST', { confirmed: true })).data.state).toBe('not_applied');
    expect((await call('/adminapi/config/pc/operations/' + committed.request_id, 'GET', undefined, 2)).status).not.toBe(200);
    await f.db.update(systemRole).set({ rules: 'pc_base.manage' }).where(eq(systemRole.id, ID));
    expect(await service.save(absent, actor())).toMatchObject({ state: 'not_applied', replayed: true });
    expect(await rows(f.db)).toEqual(committedRows);
    await f.db.update(systemAdmin).set({ pwd: 'owned-pc-rotated-password' }).where(eq(systemAdmin.id, ID));
    await expect(service.receipt(committed.request_id, actor())).rejects.toMatchObject({ code: 410001 });
    const currentOwner = { ...actor(), authVersion: md5('owned-pc-rotated-password') };
    expect(await service.receipt(committed.request_id, currentOwner)).toMatchObject({ state: 'committed' });
    await f.db.update(systemAdmin).set({ status: 0 }).where(eq(systemAdmin.id, ID));
    await expect(service.receipt(committed.request_id, currentOwner)).rejects.toMatchObject({ code: 410002 });
  }), 180000);

  it('requires every exact1361 and315 identity field and rejects copied generic or cross-domain author grants', async () => fixture(async (f, app, admin) => {
    const { service, call, cache } = await kit(f, app, admin), permissions = new AdminPermissionService(createContainerFromDb(admin.db));
    const resolved = async () => permissions.resolveManyRulePermissionKeys(['1361', '315', '1361,315']);
    expect((await resolved())[0]).toEqual(['pc_base.view']); expect((await resolved())[1]).not.toContain('pc_base.manage'); expect((await resolved())[2]).toContain('pc_base.manage');
    expect(canRetainOpaqueLegacyMenu(page)).toBe(false);
    const fields = [
      { pid: 1 }, { type: 2 }, { module: 'supplier' }, { controller: 'config' }, { action: 'save' },
      { authType: 2 }, { menuPath: '/config/pc' }, { uniqueAuth: 'app-pc ' }, { apiUrl: 'config/pc' }, { methods: 'GET' },
    ];
    for (const drift of fields) {
      await f.db.update(systemMenus).set(drift).where(eq(systemMenus.id, 1361));
      expect((await resolved())[2]).not.toContain('pc_base.manage');
      expect((await resolved())[0].some(key => key.startsWith('pc_base.'))).toBe(false);
      await f.db.update(systemMenus).set(page).where(eq(systemMenus.id, 1361));
    }
    for (const drift of [{ pid: 1 }, { type: 2 }, { module: 'supplier' }, { controller: 'config' }, { action: 'save' },
      { authType: 1 }, { menuPath: '/config/pc' }, { uniqueAuth: 'pc_base.manage' }, { apiUrl: 'config/pc' }, { methods: 'PUT' }]) {
      await f.db.update(systemMenus).set(drift).where(eq(systemMenus.id, 315));
      expect((await resolved())[2]).not.toContain('pc_base.manage');
      await f.db.update(systemMenus).set(saveSeed).where(eq(systemMenus.id, 315));
    }
    // ID is the eleventh tuple component: valid-looking copied rows are not
    // aliases, and changing the actual seed ID removes the original authority.
    await f.db.insert(systemMenus).values([{ ...page, id: 9991361, isShow: 1 }, { ...saveSeed, id: 999315 }]);
    expect((await permissions.resolveManyRulePermissionKeys(['9991361,315']))[0].some(key => key.startsWith('pc_base.'))).toBe(false);
    expect((await permissions.resolveManyRulePermissionKeys(['1361,999315']))[0]).not.toContain('pc_base.manage');
    await f.db.update(systemMenus).set({ id: 9991362 }).where(eq(systemMenus.id, 1361));
    try { expect((await resolved())[2]).not.toContain('pc_base.manage'); } finally { await f.db.update(systemMenus).set({ id: 1361 }).where(eq(systemMenus.id, 9991362)); }
    await f.db.update(systemMenus).set({ id: 999316 }).where(eq(systemMenus.id, 315));
    try { expect((await resolved())[2]).not.toContain('pc_base.manage'); } finally { await f.db.update(systemMenus).set({ id: 315 }).where(eq(systemMenus.id, 999316)); }
    // The author has only pc_base.manage, with no generic attachment grant.
    // Dedicated actual Hono queries expose platform canonical choices and
    // separately signed previews, never supplier/bad MIME/wrong owner rows.
    await f.db.insert(systemAttachmentCategory).values([
      { id: 899991, type: 1, relationId: 0, fileType: 1, name: 'Owned PC platform category', pid: 0 },
      { id: 899992, type: 2, relationId: 7, fileType: 1, name: 'Owned supplier category must stay private', pid: 0 },
    ]);
    await f.db.update(systemAttachment).set({ pid: 899991 }).where(inArray(systemAttachment.attId, [991, 992, 993, 994, 995]));
    expect(roleRules[0]).toBe('pc_base.manage');
    for (const prefix of ['/adminapi', '/api/admin']) {
      const categories = await call(prefix + '/config/pc/attachment-categories');
      expect(categories.status, categories.msg).toBe(200); expect(categories.headers.get('Cache-Control')).toBe('private, no-store');
      expect(categories.data.list).toContainEqual({ id: 899991, pid: 0, name: 'Owned PC platform category' });
      expect(categories.data.list.some((row: { id: number }) => row.id === 899992)).toBe(false);
      const choices = await call(prefix + '/config/pc/attachment-options?pid=899991&page=1&limit=100');
      expect(choices.status, choices.msg).toBe(200); expect(choices.headers.get('Cache-Control')).toBe('private, no-store');
      expect(choices.data.count).toBe(2); expect(choices.data.list.map((row: { att_id: number }) => row.att_id)).toEqual([995, 991]);
      for (const choice of choices.data.list as Array<{ att_id: number; reference: string; preview: string }>) {
        expect(choice.reference).toBe('/api/assets/' + choice.att_id); expect(choice.reference).not.toContain('?');
        expect(choice.preview).toMatch(new RegExp('^/api/assets/' + choice.att_id + '\\?'));
      }
      for (const path of ['/config/pc/attachment-categories', '/config/pc/attachment-options?pid=899991']) {
        expect((await call(prefix + path, 'GET', undefined, 1)).status).toBe(400011);
      }
      for (const path of ['/config/pc/attachment-categories?unknown=1', '/config/pc/attachment-categories?pid=1&pid=2',
        '/config/pc/attachment-options?pid=899991&page=1&page=1', '/config/pc/attachment-options?pid=899991&unknown=1']) {
        const rejected = await call(prefix + path); expect(rejected.status).toBe(400);
        expect(rejected.headers.get('Cache-Control')).toBe('private, no-store');
      }
      expect((await call(prefix + (prefix === '/adminapi' ? '/file/category' : '/asset-categories'))).status).toBe(400011);
    }
    const before = await rows(f.db), operation = intent((await service.read(actor())).revision, { copyright: '仅PC作者可写' });
    for (const prefix of ['/adminapi', '/api/admin']) {
      for (const index of [0, 1, 2, 3, 9]) expect((await call(prefix + '/config/pc', 'GET', undefined, index)).status).toBe(200);
      for (const index of [4, 5, 6, 7, 8, 10]) expect((await call(prefix + '/config/pc', 'GET', undefined, index)).status).toBe(400011);
      for (const index of [1, 3, 4, 5, 6, 7, 8, 10]) {
        expect((await call(prefix + '/config/pc', 'POST', operation, index)).status).toBe(400011);
        expect((await call(prefix + '/setting/config/save_basics', 'POST', operation, index)).status).toBe(400011);
      }
    }
    for (const index of [5, 6, 9]) {
      const list = await call('/api/admin/config/list', 'GET', undefined, index); expect(list.status, list.msg).toBe(200);
      expect(list.data.some((row: { menuName: string }) => (PC_BASE_KEYS as readonly string[]).includes(row.menuName))).toBe(false);
      for (const key of [...PC_BASE_KEYS, ...openDomain]) {
        for (const path of ['/adminapi/setting/config/', '/api/admin/config/']) expect((await call(path + key, 'GET', undefined, index)).status).not.toBe(200);
      }
    }
    for (const index of [5, 9]) for (const key of PC_BASE_KEYS) {
      expect((await call('/api/admin/config/save', 'POST', { owned_pc_unrelated: 'must-not-write', [key]: 'generic-bypass' }, index)).status).not.toBe(200);
    }
    expect(await rows(f.db)).toEqual(before); expect(await operations(admin.db)).toHaveLength(0);
    expect(cache.invalidated).toEqual([]); expect(cache.written).toEqual([]);
  }), 180000);

  it('holds real staff menu config and attachment fences through receipt commit and orders in-flight owner sealing across independent sessions', async () => fixture(async (f, app, admin) => {
    const { service, env } = await kit(f, app, admin), baseline = await rows(f.db);
    for (const table of ['system_admin', 'system_role', 'system_menus', 'system_config']) {
      const request = intent((await service.read(actor())).revision, { copyright: '外部持锁不可写' });
      await f.withPeer!(peer => peer.db.transaction(async tx => {
        // A physical competing writer lock, not an advisory approximation.
        await tx.execute(sql.raw(`LOCK TABLE ONLY public.${table} IN ROW EXCLUSIVE MODE NOWAIT`));
        await expect(service.save(request, actor())).rejects.toMatchObject({ code: 409 });
      }));
      expect(await rows(f.db)).toEqual(baseline);
    }
    const imageRequest = intent((await service.read(actor())).revision, { pc_logo: '/api/assets/991' });
    await f.withPeer!(peer => peer.db.transaction(async tx => {
      await tx.execute(sql`SELECT att_id FROM public.system_attachment WHERE att_id=991 FOR UPDATE`);
      await expect(service.save(imageRequest, actor())).rejects.toMatchObject({ code: 409 });
    }));
    expect(await rows(f.db)).toEqual(baseline); expect(await operations(admin.db)).toHaveLength(0);
    // Both requested IDs participate in the real ordered lock query. The
    // missing996 is then inserted/committed by another authenticated backend
    // before that query's actual result is returned to the policy. Under RC,
    // the later policy SELECT can already see this valid, still-unlocked row.
    await f.withPeer!(async peer => {
      expect(peer.pid).not.toBe(admin.pid);
      expect(await peer.db.select().from(systemAttachment).where(eq(systemAttachment.attId, 996))).toEqual([]);
      let boundaries = 0;
      const raceDb = afterRealImageLock(admin.db, async (locked, tx) => {
        boundaries++; expect(locked).toEqual([{ id: 991 }]);
        const [isolation] = await tx.execute(sql`SELECT current_setting('transaction_isolation') AS isolation,pg_backend_pid() AS pid`);
        expect(isolation).toMatchObject({ isolation: 'read committed', pid: admin.pid });
        const inserted = await peer.db.insert(systemAttachment).values({ attId: 996, type: 1, relationId: 0,
          moduleType: 1, fileType: 1, imageType: 8, name: 'attachments/admin/1/2026/10/late-insertion.png',
          attDir: '/api/assets/996', sattDir: '/api/assets/996', attType: 'image/png' }).returning({ id: systemAttachment.attId });
        expect(inserted).toEqual([{ id: 996 }]);
        expect(await readPcBaseImageReferences(tx, ['/api/assets/996'])).toEqual(['/api/assets/996']);
        await peer.exec('BEGIN');
        try {
          await peer.exec("SET LOCAL lock_timeout='100ms'");
          expect(await peer.exec("UPDATE public.system_attachment SET real_name='late row is not locked by author' WHERE att_id=996 RETURNING att_id")).toEqual([{ att_id: 996 }]);
          await peer.exec('COMMIT');
        } catch (error) { await peer.exec('ROLLBACK'); throw error; }
      });
      const raceService = new AdminPcBaseService(createContainerFromDb(raceDb), env);
      const race = intent((await service.read(actor())).revision, { pc_logo: '/api/assets/996',
        filing_list: [{ icon: '/api/assets/991', name: 'existing locked row and late missing row', url: '', sort: 0 }] });
      await expect(raceService.save(race, actor())).rejects.toMatchObject({ code: 400 });
      expect(boundaries).toBe(1); expect(await rows(f.db)).toEqual(baseline); expect(await operations(admin.db)).toHaveLength(0);
      await expect(service.receipt(race.request_id, actor())).rejects.toMatchObject({ code: 404 });
      expect(await peer.db.select({ id: systemAttachment.attId, name: systemAttachment.realName }).from(systemAttachment)
        .where(eq(systemAttachment.attId, 996))).toEqual([{ id: 996, name: 'late row is not locked by author' }]);
    });
    const client = postgres(admin.connectionString, { max: 1, prepare: false, connect_timeout: 5, idle_timeout: 0, max_lifetime: 0 });
    try {
      const secondDb = drizzle(client) as unknown as DbClient, second = new AdminPcBaseService(createContainerFromDb(secondDb), env);
      const [secondIdentity] = await client`SELECT current_user AS role,session_user AS session,pg_backend_pid() AS pid`;
      expect(secondIdentity).toMatchObject({ role: admin.role, session: admin.role }); expect(secondIdentity.pid).not.toBe(admin.pid);
      const request = intent((await service.read(actor())).revision, { pc_logo: '/api/assets/991',
        filing_list: [{ icon: '/api/assets/995', name: '反向ID顺序', url: '', sort: 1 }, { icon: '/api/assets/991', name: '', url: '', sort: 0 }] });
      const internals = service as unknown as { append: (...args: any[]) => Promise<any> }, append = internals.append.bind(service);
      const fence = vi.spyOn(internals, 'append').mockImplementationOnce(async (...args) => {
        const receipt = await append(...args);
        const held = await f.db.execute<{ relname: string; mode: string }>(sql`SELECT c.relname,l.mode FROM pg_locks l JOIN pg_class c ON c.oid=l.relation
          WHERE l.pid=${admin.pid} AND l.granted AND c.relname IN ('system_admin','system_role','system_menus','system_config','system_attachment')`);
        for (const relname of ['system_admin', 'system_role', 'system_config']) expect(held).toContainEqual({ relname, mode: 'ShareRowExclusiveLock' });
        expect(held).toContainEqual({ relname: 'system_menus', mode: 'ShareLock' });
        expect(held).toContainEqual({ relname: 'system_attachment', mode: 'RowShareLock' });
        await expect(second.receipt(request.request_id, actor())).rejects.toMatchObject({ code: 404 });
        await expect(second.resolve(request.request_id, { confirmed: true }, actor())).rejects.toMatchObject({ code: 409 });
        await f.withPeer!(async peer => {
          for (const statement of [
            'LOCK TABLE ONLY public.system_menus IN ROW EXCLUSIVE MODE NOWAIT',
            'LOCK TABLE ONLY public.system_role IN ROW EXCLUSIVE MODE NOWAIT',
            'LOCK TABLE ONLY public.system_config IN ROW EXCLUSIVE MODE NOWAIT',
            'UPDATE public.system_attachment SET real_name=real_name WHERE att_id=991',
            'UPDATE public.system_attachment SET real_name=real_name WHERE att_id=995',
          ]) {
            await peer.exec('BEGIN');
            try { await peer.exec("SET LOCAL lock_timeout='100ms'"); await expect(peer.exec(statement)).rejects.toMatchObject({ code: '55P03' }); }
            finally { await peer.exec('ROLLBACK'); }
          }
        });
        return receipt;
      });
      const openBefore = (await rows(f.db)).filter(row => openDomain.includes(row.menu_name as typeof openDomain[number]));
      try { expect(await service.save(request, actor())).toMatchObject({ state: 'committed' }); } finally { fence.mockRestore(); }
      expect(await second.receipt(request.request_id, actor())).toMatchObject({ state: 'committed' });
      expect((await operations(admin.db)).filter(row => row.operation_id === request.request_id)).toHaveLength(1);
      const snap = await service.read(actor()); expect(snap.settings.pc_logo).toBe('/api/assets/991'); expect(snap.asset_previews.pc_logo).toMatch(/^\/api\/assets\/991\?/u);
      expect(snap.asset_previews['filing_list.0.icon']).toMatch(/^\/api\/assets\/995\?/u);
      // The Open provider/identity gate has no PC authority. Its independent
      // session can hold731661 while a purely PC author transaction commits.
      await app.db.transaction(async tx => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock_shared(731661,0)`);
        expect(await service.save(intent((await service.read(actor())).revision, { copyright: 'PC不取得Open锁' }), actor())).toMatchObject({ state: 'committed' });
      });
      expect((await rows(f.db)).filter(row => openDomain.includes(row.menu_name as typeof openDomain[number]))).toEqual(openBefore);
      const stale = intent((await service.read(actor())).revision, { copyright: '旧版本不可写' });
      await f.db.update(systemConfig).set({ value: sql`${systemConfig.value}` }).where(eq(systemConfig.menuName, 'pc_logo'));
      const afterXminOnly = await rows(f.db); await expect(service.save(stale, actor())).rejects.toMatchObject({ code: 409 }); expect(await rows(f.db)).toEqual(afterXminOnly);
      const [shadow] = await f.db.insert(systemConfig).values({ menuName: 'pc_logo', sort: -10, value: '"http://images.example.test/loser.png"' }).returning();
      const oldLoser = intent((await service.read(actor())).revision, { copyright: '所有loser元数据也绑定' });
      await f.db.update(systemConfig).set({ desc: 'independent loser metadata changed' }).where(eq(systemConfig.id, shadow.id));
      const changedLoser = await rows(f.db); await expect(service.save(oldLoser, actor())).rejects.toMatchObject({ code: 409 }); expect(await rows(f.db)).toEqual(changedLoser);
      const otherActor = intent((await service.read(actor())).revision, { copyright: '其他作者的revision不可借用' });
      await expect(service.save(otherActor, actor(2))).rejects.toMatchObject({ code: 409 }); expect(await rows(f.db)).toEqual(changedLoser);
    } finally { await client.end({ timeout: 5 }); }
  }), 180000);

  it('dispatches one complete PC Base or Open envelope through both production aliases and enforces PC256KiB versus predecessor64KiB', async () => fixture(async (f, app, admin) => {
    const { service, call } = await kit(f, app, admin);
    const baseIntent = (revision: string): WechatBaseSave => ({ request_id: randomUUID(), revision, confirmed: true, database_callback: false,
      settings: { wechat_appid: 'wx1234567890abcdef', wechat_encode: 0, share_qrcode: 0, spread_share_forever: 0, wechat_qrcode: '', create_wechat_user: 0 },
      secrets: { wechat_appsecret: { action: 'keep' }, wechat_encodingaeskey: { action: 'keep' }, wechat_token: { action: 'keep' } } });
    const openIntent = (revision: string): WechatOpenSave => ({ request_id: randomUUID(), revision, confirmed: true, database_credentials: false,
      settings: { wechat_open_app_id: 'wx1234567890abcdef' }, secrets: { wechat_open_app_secret: { action: 'keep' } } });
    for (const prefix of ['/adminapi', '/api/admin']) {
      const read = await call(prefix + '/setting/config/edit_new_build/pc', 'GET', undefined, 2);
      expect(read.status, read.msg).toBe(200); expect(read.headers.get('Cache-Control')).toBe('private, no-store');
      const foreign = await foreignRows(f.db), pc = intent(read.data.revision, { copyright: 'shared PC ' + prefix });
      const saved = await call(prefix + '/setting/config/save_basics', 'POST', pc, 2);
      expect(saved.status, saved.msg).toBe(200); expect(saved.headers.get('Cache-Control')).toBe('private, no-store');
      expect(await foreignRows(f.db)).toEqual(foreign);
      expect((await call(prefix + '/config/pc/operations/' + pc.request_id, 'GET', undefined, 2)).data.state).toBe('committed');
      const large = intent((await service.read(actor())).revision, { company_address: '界'.repeat(4900), copyright: '界'.repeat(4900),
        seo_title: '界'.repeat(4900), site_keywords: '界'.repeat(4900), site_description: '界'.repeat(4900) });
      expect(bytes(JSON.stringify(large))).toBeGreaterThan(65536); expect(bytes(JSON.stringify(large))).toBeLessThan(PC_BASE_MAX_BODY_BYTES);
      const bigSaved = await call(prefix + '/setting/config/save_basics', 'POST', large);
      expect(bigSaved.status, bigSaved.msg).toBe(200);
      for (const path of ['/setting/config/save_basics', '/config/pc']) {
        const max = await call(prefix + path, 'POST', undefined, 0, padded(large, PC_BASE_MAX_BODY_BYTES));
        expect(max.status, max.msg).toBe(200); expect(max.data.replayed).toBe(true);
        const baseline = await rows(f.db), opBaseline = await operations(admin.db);
        expect((await call(prefix + path, 'POST', undefined, 0, padded(large, PC_BASE_MAX_BODY_BYTES + 1))).status).not.toBe(200);
        expect(await rows(f.db)).toEqual(baseline); expect(await operations(admin.db)).toEqual(opBaseline);
      }
      for (const [name, make, ownIndex] of [['base', baseIntent, 8], ['open', openIntent, 7]] as const) {
        const snapshot = await call(prefix + '/wechat/' + name, 'GET', undefined, ownIndex); expect(snapshot.status, snapshot.msg).toBe(200);
        const operation = make(snapshot.data.revision), pcRows = (await rows(f.db)).filter(row => (PC_BASE_KEYS as readonly string[]).includes(row.menu_name));
        const shared = await call(prefix + '/setting/config/save_basics', 'POST', operation, ownIndex); expect(shared.status, shared.msg).toBe(200);
        for (const path of ['/setting/config/save_basics', '/wechat/' + name]) {
          const atLimit = await call(prefix + path, 'POST', undefined, ownIndex, padded(operation, 65536));
          expect(atLimit.status, atLimit.msg).toBe(200); expect(atLimit.data.replayed).toBe(true);
          const before = await rows(f.db);
          expect((await call(prefix + path, 'POST', undefined, ownIndex, padded(operation, 65537))).status).not.toBe(200);
          expect(await rows(f.db)).toEqual(before);
        }
        expect((await rows(f.db)).filter(row => (PC_BASE_KEYS as readonly string[]).includes(row.menu_name))).toEqual(pcRows);
        expect((await call(prefix + '/setting/config/save_basics', 'POST', operation, 0)).status).toBe(400011);
      }
      const next = intent((await service.read(actor())).revision, { copyright: '不可混合分流' }), before = await rows(f.db), opBefore = await operations(admin.db);
      for (const body of [
        { pc_logo: 'http://images.example.test/flat.png' },
        { ...next, fields: { ...next.fields, wechat_open_app_secret: { action: 'replace', value: 'owned-pc-open-secret-never-readable' } } },
        { ...next, settings: { wechat_open_app_id: 'wx1234567890abcdef' }, database_credentials: false },
        { ...next, fields: { copyright: { action: 'replace', value: 'partial' } } },
      ]) {
        const rejected = await call(prefix + '/setting/config/save_basics', 'POST', body, 9);
        expect(rejected.status).toBe(400); expect(rejected.headers.get('Cache-Control')).toBe('private, no-store');
      }
      const duplicated = JSON.stringify(next).replace('"confirmed":true', '"confirmed":true,"confirmed":true');
      for (const raw of [duplicated, '{bad', '[]']) expect((await call(prefix + '/setting/config/save_basics', 'POST', undefined, 9, raw)).status).toBe(400);
      expect((await call(prefix + '/setting/config/save_basics?domain=pc', 'POST', next, 9)).status).toBe(400);
      expect((await call(prefix + '/setting/config/save_basics', 'POST', next, 7)).status).toBe(400011);
      expect((await call(prefix + '/setting/config/save_basics', 'POST', next, 8)).status).toBe(400011);
      expect((await call(prefix + '/config/pc', 'POST', next, 1)).status).toBe(400011);
      expect(await rows(f.db)).toEqual(before); expect(await operations(admin.db)).toEqual(opBefore);
    }
  }), 180000);
});
