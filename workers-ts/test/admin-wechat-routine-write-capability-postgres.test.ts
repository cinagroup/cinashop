import { Buffer } from 'node:buffer';
import { randomBytes, randomUUID } from 'node:crypto';
import { URL } from 'node:url';
import postgres from 'postgres';
import { getTableColumns, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import { describe, expect, it } from 'vitest';
import type { DbClient } from '@/lib/di';
import { systemConfig } from '@/models/schema';
import { pricingIdentifier } from '@/migrations/checkoutPricingLockCatalog';
import { ADMIN_WECHAT_ROUTINE_OPERATION_SQL, assertAdminWechatRoutineOperationReady } from '@/migrations/adminWechatRoutineOperation';
import { ADMIN_WECHAT_ROUTINE_STORED_TEXT_SIGNATURE, ADMIN_WECHAT_ROUTINE_STORED_TEXT_SQL } from '@/migrations/adminWechatRoutineStoredText';
import { ADMIN_WECHAT_ROUTINE_SOURCE_SQL, ADMIN_WECHAT_ROUTINE_WRITE_SIGNATURE,
  adminWechatRoutineWriteSql, type AdminWechatRoutineWriteBinding } from '@/migrations/adminWechatRoutineWriteCapability';
import { inspectAdminWechatRoutineWriteCatalog } from '@/migrations/adminWechatRoutineWriteCatalog';
import { wechatRoutineActorBinding, wechatRoutineSourceRevision, wechatRoutineSqlFields,
  wechatRoutineReceiptDto, parseWechatRoutinePrivateReceipt } from '@/services/admin/AdminWechatRoutineWriteProtocol';
import { financePostgres, ownsFinanceFixtureEndpoint, ownsFinanceFixtureTarget, validateFinanceFixtureUrl } from './helpers/financePostgres';

type Fields = Record<string, { action: 'keep' } | { action: 'clear' } | { action: 'replace'; raw: string }>;
type Receipt = { operation_id: string; actor_id: number; operation: 'save' | 'resolve';
  state: 'committed' | 'not_applied'; replayed: boolean; result: { changed_keys: string[]; before_source: string; after_source: string } };
const keys = ['routine_appId', 'routine_appsecret', 'routine_name', 'routine_contact_type', 'store_user_avatar'] as const;
const keep = (): Fields => Object.fromEntries(keys.map(key => [key, { action: 'keep' as const }]));
const replace = (key: string, raw: string): Fields => ({ ...keep(), [key]: { action: 'replace', raw } });
const REVISION = 'a'.repeat(64), ACTOR_BINDING = 'b'.repeat(64);

/** Deliberately only the low-level SQL capability, not a formal installer,
 * runtime-profile commissioning, staff/JWT authorization or a published author.
 * All global roles are random, independently authenticated and owned here. */
async function withCapability(run: (context: Awaited<ReturnType<typeof createCapability>>) => Promise<void>,
  options: { extraShadows?: number; withoutAppId?: boolean; withAvatar?: boolean } = {}) {
  const context = await createCapability(options);
  try { await run(context); } finally { await context.close(); }
}

async function createCapability(options: { extraShadows?: number; withoutAppId?: boolean; withAvatar?: boolean }) {
  const base = validateFinanceFixtureUrl(process.env.TEST_FINANCE_POSTGRES_URL!);
  const fixture = await financePostgres([systemConfig], { namespace: 'public' });
  const root = postgres(base.href, { max: 1, prepare: false, connect_timeout: 5 });
  const suffix = Buffer.from(randomBytes(10)).toString('hex');
  const adminName = `routine_admin_${suffix}`, writerName = `routine_writer_${suffix}`;
  const adminIdentifier = pricingIdentifier(adminName), writerIdentifier = pricingIdentifier(writerName);
  const password = Buffer.from(randomBytes(32)).toString('hex');
  const createdRoles: string[] = [];
  let admin: ReturnType<typeof postgres> | undefined;
  const close = async () => {
    const failures: unknown[] = [];
    try { await admin?.end({ timeout: 5 }); } catch (error) { failures.push(error); }
    try { await fixture.close(); } catch (error) { failures.push(error); }
    for (const role of [...createdRoles].reverse()) {
      try { await root.unsafe(`DROP ROLE ${pricingIdentifier(role)}`); } catch (error) { failures.push(error); }
    }
    try { await root.end({ timeout: 5 }); } catch (error) { failures.push(error); }
    if (failures.length) throw new AggregateError(failures, 'Owned Routine capability fixture cleanup failed');
  };
  try {
    const [identity] = await fixture.db.execute<{ database: string; database_oid: number; maintenance: string;
      superuser: boolean; host: string; port: number }>(sql`SELECT current_database() AS database,
      (SELECT oid::integer FROM pg_database WHERE datname=current_database()) AS database_oid,
      current_user AS maintenance, (SELECT rolsuper FROM pg_roles WHERE rolname=current_user) AS superuser,
      host(inet_server_addr()) AS host, inet_server_port() AS port`);
    if (!identity.superuser || !ownsFinanceFixtureTarget(identity.database, 'public', base.href)
      || !ownsFinanceFixtureEndpoint(identity.database, 'public', base.href, identity.host, identity.port)) {
      throw Error('Routine role fixture requires its registered owned PG16 maintenance database');
    }
    const [coordinator] = await root`SELECT current_database() AS database, current_user AS role,
      host(inet_server_addr()) AS host, inet_server_port() AS port`;
    if (coordinator.database !== 'cinashop_finance_test' || coordinator.role !== identity.maintenance
      || coordinator.host !== identity.host || coordinator.port !== identity.port) throw Error('Owned Routine coordinator identity changed');
    await root.unsafe(`CREATE ROLE ${adminIdentifier} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`);
    createdRoles.push(adminName);
    await root.unsafe(`CREATE ROLE ${writerIdentifier} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`);
    createdRoles.push(writerName);
    const roles = await root`SELECT rolname, oid::integer AS oid FROM pg_roles WHERE rolname IN (${adminName}, ${writerName})`;
    const binding: AdminWechatRoutineWriteBinding = { database: identity.database, databaseOid: Number(identity.database_oid),
      admin: adminName, adminOid: Number(roles.find(role => role.rolname === adminName)?.oid),
      writer: writerName, writerOid: Number(roles.find(role => role.rolname === writerName)?.oid) };
    const seed: Array<typeof systemConfig.$inferInsert> = [
      ...options.withoutAppId ? [] : [
        { menuName: 'routine_appId', value: 'owned-app', sort: 30, configTabId: 99, info: 'imported app winner' },
        { menuName: 'routine_appId', value: JSON.stringify('shadow-app'), sort: -2, configTabId: 98, info: 'imported app shadow' },
      ],
      { menuName: 'routine_appsecret', value: JSON.stringify('owned-secret'), sort: 30, configTabId: 97, info: 'imported secret winner' },
      { menuName: 'routine_appsecret', value: JSON.stringify('shadow-secret'), sort: -2, configTabId: 96 },
      { menuName: 'routine_name', value: JSON.stringify('original name'), sort: 20, configTabId: 95, type: 'legacy', status: 0, info: 'preserve name metadata' },
      { menuName: 'routine_contact_type', value: '1', sort: 10 },
      { menuName: 'routine_appId', isStore: 1, value: JSON.stringify('store-realm-app'), sort: 50 },
      { menuName: 'ordinary_fixture_key', value: 'original ordinary', sort: 0 },
      ...options.withAvatar ? [{ menuName: 'store_user_avatar', value: '0', configTabId: 26 }] : [],
      ...Array.from({ length: options.extraShadows ?? 0 }, (_, index) => ({
        menuName: 'routine_name', value: JSON.stringify(`capacity shadow ${index}`), sort: -100 - index,
      })),
    ];
    await fixture.db.insert(systemConfig).values(seed);
    // The small ORM fixture creates columns/PK only. Install the four ordinary
    // production indexes explicitly; the catalog must not accept a weaker tree.
    await fixture.exec(`CREATE INDEX system_config_is_store_idx ON public.system_config(is_store);
CREATE INDEX config_tab_id ON public.system_config(config_tab_id);
CREATE INDEX system_config_menu_name_idx ON public.system_config(menu_name);
CREATE INDEX system_config_lookup ON public.system_config(is_store,menu_name,sort DESC NULLS FIRST,id DESC NULLS FIRST);`);
    await fixture.exec(ADMIN_WECHAT_ROUTINE_OPERATION_SQL);
    await fixture.exec(ADMIN_WECHAT_ROUTINE_STORED_TEXT_SQL);
    await fixture.exec(`GRANT USAGE ON SCHEMA public TO ${adminIdentifier}, ${writerIdentifier};
GRANT SELECT,INSERT,UPDATE ON TABLE public.system_config TO ${adminIdentifier};
GRANT USAGE ON SEQUENCE public.system_config_id_seq TO ${adminIdentifier};
GRANT SELECT,INSERT ON TABLE public.system_config TO ${writerIdentifier};
GRANT UPDATE(value) ON TABLE public.system_config TO ${writerIdentifier};
GRANT USAGE ON SEQUENCE public.system_config_id_seq TO ${writerIdentifier};
GRANT SELECT ON TABLE public.admin_wechat_routine_operation TO ${adminIdentifier};
GRANT SELECT,INSERT ON TABLE public.admin_wechat_routine_operation TO ${writerIdentifier};
GRANT EXECUTE ON FUNCTION ${ADMIN_WECHAT_ROUTINE_STORED_TEXT_SIGNATURE} TO ${writerIdentifier};`);
    await fixture.exec(adminWechatRoutineWriteSql(binding));
    await fixture.exec(`GRANT CREATE ON SCHEMA public TO ${writerIdentifier};
ALTER FUNCTION ${ADMIN_WECHAT_ROUTINE_WRITE_SIGNATURE} OWNER TO ${writerIdentifier};
REVOKE CREATE ON SCHEMA public FROM ${writerIdentifier};
GRANT EXECUTE ON FUNCTION ${ADMIN_WECHAT_ROUTINE_WRITE_SIGNATURE} TO ${adminIdentifier};`);
    if (!ownsFinanceFixtureTarget(identity.database, 'public', base.href)) throw Error('Owned Routine database registration disappeared');
    const peerUrl = new URL(base.href);
    peerUrl.pathname = '/' + identity.database; peerUrl.username = adminName; peerUrl.password = password;
    admin = postgres(peerUrl.href, { max: 1, prepare: false, connect_timeout: 5,
      connection: { options: '-c search_path=public -c statement_timeout=5000 -c lock_timeout=1000' } });
    const [peer] = await admin`SELECT current_database() AS database,current_user AS role,session_user AS session,
      (SELECT oid::integer FROM pg_roles WHERE rolname=current_user) AS role_oid,
      host(inet_server_addr()) AS host,inet_server_port() AS port`;
    if (peer.database !== binding.database || peer.role !== adminName || peer.session !== adminName
      || Number(peer.role_oid) !== binding.adminOid
      || !ownsFinanceFixtureEndpoint(binding.database, 'public', base.href, peer.host, peer.port)) throw Error('Independent Routine Admin TCP identity mismatch');
    const client = admin;
    const rows = () => fixture.db.select({ ...getTableColumns(systemConfig), version: sql<string>`xmin::text` })
      .from(systemConfig).orderBy(systemConfig.id);
    const source = async () => String((await fixture.db.execute<{ hash: string }>(sql`SELECT
      encode(sha256(convert_to((${sql.raw(ADMIN_WECHAT_ROUTINE_SOURCE_SQL)})::text,'UTF8')),'hex') AS hash`))[0].hash);
    const sequence = async () => Array.from(await fixture.db.execute(sql`SELECT last_value::text,is_called FROM public.system_config_id_seq`));
    const receipts = async () => Array.from(await fixture.db.execute(sql`SELECT * FROM public.admin_wechat_routine_operation ORDER BY operation_id`));
    const invoke = async (request: { id?: string; actor?: number; operation?: 'save' | 'resolve';
      fields?: Fields | null; expected?: string; revision?: string; actorBinding?: string } = {}) => {
      const id = request.id ?? randomUUID(), actor = request.actor ?? 17, operation = request.operation ?? 'save';
      const fields = request.fields === undefined ? keep() : request.fields;
      const expected = request.expected ?? await source();
      return client.begin(async tx => {
        const [before] = await tx`SELECT pg_current_xact_id_if_assigned()::text AS xid`;
        // postgres.js owns JSON serialization for jsonb parameters. Passing an
        // already stringified object would instead send a JSON string scalar.
        const packet = fields === null ? null : tx.json(fields);
        const [admitted] = await tx`SELECT jsonb_typeof(${packet}::jsonb) AS type,
          CASE WHEN ${packet}::jsonb IS NULL THEN NULL ELSE
            (SELECT count(*)::integer FROM jsonb_object_keys(${packet}::jsonb)) END AS keys`;
        expect({ ...admitted }).toEqual(fields === null ? { type: null, keys: null } : { type: 'object', keys: 5 });
        const [result] = await tx`SELECT public.cinashop_admin_wechat_routine_write_v1(
          ${id}::uuid,${actor},${operation},${request.revision ?? REVISION},${expected},${request.actorBinding ?? ACTOR_BINDING},
          ${packet}::jsonb) AS receipt`;
        const [after] = await tx`SELECT pg_current_xact_id_if_assigned()::text AS xid`;
        return { receipt: result.receipt as Receipt, xidBefore: before.xid, xidAfter: after.xid };
      });
    };
    // Explicit owner maintenance, confined to this registered fixture, simulates
    // a later reviewed import. It grants Admin no bypass or trigger ownership.
    const maintainName = async (sameValueOnly: boolean) => fixture.db.transaction(async tx => {
      await tx.execute(sql.raw('ALTER TABLE public.system_config DISABLE TRIGGER routine_config_rows'));
      await tx.execute(sameValueOnly ? sql`UPDATE public.system_config SET value=value WHERE menu_name='routine_name' AND sort=20`
        : sql`UPDATE public.system_config SET info='reviewed later metadata' WHERE menu_name='routine_name' AND sort=20`);
      await tx.execute(sql.raw('ALTER TABLE public.system_config ENABLE TRIGGER routine_config_rows'));
    });
    return { fixture, admin: client, binding, maintenance: identity.maintenance, rows, source, sequence, receipts, invoke, maintainName, close };
  } catch (error) {
    try { await close(); } catch (cleanup) { throw new AggregateError([error, cleanup], 'Routine capability setup and cleanup failed'); }
    throw error;
  }
}

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('Routine bounded writer on independent native PG16 roles (low-level only)', () => {
  it('recognizes the complete catalog with explicit names and OID-bound inferred identities', async () => withCapability(async c => {
    const names = { maintenance: c.maintenance, admin: c.binding.admin, writer: c.binding.writer };
    expect(await inspectAdminWechatRoutineWriteCatalog(c.fixture.db, names))
      .toEqual({ present: true, ready: true, binding: c.binding, failures: [] });
    expect(await inspectAdminWechatRoutineWriteCatalog(c.fixture.db))
      .toEqual({ present: true, ready: true, binding: c.binding, failures: [] });
    const adminDb = drizzle(c.admin) as unknown as DbClient;
    await expect(adminDb.transaction(tx => assertAdminWechatRoutineOperationReady(tx))).resolves.toBeUndefined();
  }));

  it.each([
    ['changed main body', 'body'], ['PUBLIC main EXECUTE', 'acl'], ['same-name overload', 'overload'],
    ['owner extra column grant', 'owner'], ['unknown table trigger', 'trigger'],
    ['unknown table index', 'index'], ['missing parser', 'partial'],
  ] as const)('rejects catalog drift without repairing it: %s', async (_label, kind) => withCapability(async c => {
    if (kind === 'body') await c.fixture.exec(`CREATE OR REPLACE FUNCTION ${ADMIN_WECHAT_ROUTINE_WRITE_SIGNATURE.replace(
      '(uuid,integer,text,text,text,text,jsonb)', '(p_id uuid,p_actor integer,p_operation text,p_revision text,p_expected_source text,p_actor_binding text,p_fields jsonb)')}
      RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$ BEGIN RETURN '{}'::jsonb; END $$`);
    else if (kind === 'acl') await c.fixture.exec(`GRANT EXECUTE ON FUNCTION ${ADMIN_WECHAT_ROUTINE_WRITE_SIGNATURE} TO PUBLIC`);
    else if (kind === 'overload') await c.fixture.exec(`CREATE FUNCTION public.cinashop_admin_wechat_routine_write_v1() RETURNS integer LANGUAGE sql AS 'SELECT 1'`);
    else if (kind === 'owner') await c.fixture.exec(`GRANT UPDATE(info) ON public.system_config TO ${pricingIdentifier(c.binding.writer)}`);
    else if (kind === 'trigger') await c.fixture.exec('CREATE TRIGGER owned_unreviewed_trigger BEFORE UPDATE ON public.system_config FOR EACH ROW EXECUTE FUNCTION public.cinashop_wechat_routine_config_guard_v1()');
    else if (kind === 'index') await c.fixture.exec('CREATE INDEX owned_unreviewed_index ON public.system_config(info)');
    else await c.fixture.exec(`DROP FUNCTION ${ADMIN_WECHAT_ROUTINE_STORED_TEXT_SIGNATURE}`);
    const before = await c.rows(), result = await inspectAdminWechatRoutineWriteCatalog(c.fixture.db,
      { maintenance: c.maintenance, admin: c.binding.admin, writer: c.binding.writer });
    expect(result.present).toBe(true); expect(result.ready).toBe(false); expect(result.failures.length).toBeGreaterThan(0);
    expect(await inspectAdminWechatRoutineWriteCatalog(c.fixture.db,
      { maintenance: c.maintenance, admin: c.binding.admin, writer: c.binding.writer })).toEqual(result);
    expect(await c.rows()).toEqual(before);
  }));

  it('projects only seven public receipt fields from actual SQL evidence and stable historical actor binding', async () => withCapability(async c => {
    const env = { APP_KEY: 'owned-routine-protocol-signing' };
    const actor = { id: 17, authVersion: 'c'.repeat(32), expiresAt: Math.floor(Date.now() / 1000) + 3600 };
    const actorBinding = wechatRoutineActorBinding(env, actor), expected = await c.source(), id = randomUUID();
    const revision = wechatRoutineSourceRevision(env, actorBinding, expected);
    const fields = wechatRoutineSqlFields({ request_id: id, revision, confirmed: true,
      fields: { ...keep(), routine_name: { action: 'replace', value: 'private protocol name' } } });
    const first = await c.invoke({ id, expected, revision, fields, actorBinding });
    const privateRow = parseWechatRoutinePrivateReceipt(first.receipt), actualAfter = await c.source();
    expect(privateRow.result.after_source).toBe(actualAfter);
    const dto = wechatRoutineReceiptDto(first.receipt, actor.id, env, false);
    expect(Object.keys(dto).sort()).toEqual(['actor_id','cache_status','created_at','replayed','request_id','revision','state']);
    expect(dto.revision).toBe(wechatRoutineSourceRevision(env, actorBinding, actualAfter));
    for (const value of [privateRow.payload_hash, privateRow.result.before_source, actualAfter, actorBinding, 'private protocol name']) {
      expect(JSON.stringify(dto)).not.toContain(value);
    }
    const rotatedBinding = wechatRoutineActorBinding(env, { ...actor, authVersion: 'd'.repeat(32), expiresAt: actor.expiresAt + 60 });
    expect(rotatedBinding).not.toBe(actorBinding);
    const persisted = await c.receipts();
    const replay = await c.invoke({ id, expected, revision, fields, actorBinding: rotatedBinding });
    expect(parseWechatRoutinePrivateReceipt(replay.receipt).result.actor_binding).toBe(actorBinding);
    expect(wechatRoutineReceiptDto(replay.receipt, actor.id, env, true)).toEqual({ ...dto, replayed: true });
    expect(await c.receipts()).toEqual(persisted);
  }));

  it('uses independent LOGIN/NOLOGIN roles and exact receipt/function ownership', async () => withCapability(async c => {
    const roles = await c.admin`SELECT rolname,rolcanlogin,rolsuper,rolcreatedb,rolcreaterole,rolinherit,rolreplication,rolbypassrls,
      NOT EXISTS(SELECT 1 FROM pg_auth_members WHERE member=r.oid OR roleid=r.oid) AS no_memberships
      FROM pg_roles r WHERE rolname IN (${c.binding.admin},${c.binding.writer}) ORDER BY rolname`;
    expect(roles.map(row => ({ ...row }))).toEqual([
      { rolname: c.binding.admin, rolcanlogin: true, rolsuper: false, rolcreatedb: false, rolcreaterole: false,
        rolinherit: false, rolreplication: false, rolbypassrls: false, no_memberships: true },
      { rolname: c.binding.writer, rolcanlogin: false, rolsuper: false, rolcreatedb: false, rolcreaterole: false,
        rolinherit: false, rolreplication: false, rolbypassrls: false, no_memberships: true },
    ]);
    const [receipt] = await c.admin`SELECT pg_get_userbyid(relowner) AS owner,
      has_table_privilege(current_user,oid,'SELECT') AS readable,
      has_table_privilege(current_user,oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS writable
      FROM pg_class WHERE oid='public.admin_wechat_routine_operation'::regclass`;
    expect(receipt).toMatchObject({ owner: c.maintenance, readable: true, writable: false });
    const owners = await c.admin`SELECT proname,pg_get_userbyid(proowner) AS owner FROM pg_proc
      WHERE pronamespace='public'::regnamespace ORDER BY proname`;
    expect(owners.filter(row => row.owner === c.binding.writer).map(row => row.proname)).toEqual(['cinashop_admin_wechat_routine_write_v1']);
    expect(owners.filter(row => row.owner !== c.binding.writer).every(row => row.owner === c.maintenance)).toBe(true);
  }));

  it.each(keys)('rejects raw protected INSERT and UPDATE for %s', async key => withCapability(async c => {
    const before = await c.rows();
    await expect(c.admin`INSERT INTO public.system_config(menu_name,value) VALUES(${key},'forged')`).rejects.toMatchObject({ code: '42501' });
    await expect(c.admin`UPDATE public.system_config SET value='forged' WHERE menu_name=${key}`).rejects.toMatchObject({ code: '42501' });
    expect(await c.rows()).toEqual(before);
  }, { withAvatar: key === 'store_user_avatar' }));

  it('binds execution to the actual independent Admin session rather than the maintenance caller', async () => withCapability(async c => {
    const expected = await c.source(), before = await c.rows();
    await expect(c.fixture.db.transaction(async tx => {
      await tx.execute(sql`SELECT set_config('statement_timeout','5000',true),set_config('lock_timeout','1000',true)`);
      return tx.execute(sql`SELECT public.cinashop_admin_wechat_routine_write_v1(
        ${randomUUID()}::uuid,17,'save',${REVISION},${expected},${ACTOR_BINDING},${JSON.stringify(keep())}::jsonb)`);
    })).rejects.toMatchObject({ cause: { code: '42501' } });
    expect(await c.rows()).toEqual(before); expect(await c.receipts()).toEqual([]);
  }));

  it.each([
    ['rename out of protected key', "UPDATE public.system_config SET menu_name='ordinary_escaped' WHERE menu_name='routine_name'"],
    ['rename ordinary into protected key', "UPDATE public.system_config SET menu_name='routine_name' WHERE menu_name='ordinary_fixture_key'"],
    ['move protected platform realm', "UPDATE public.system_config SET is_store=1 WHERE menu_name='routine_name'"],
    ['move protected store realm', "UPDATE public.system_config SET is_store=0 WHERE menu_name='routine_appId' AND is_store=1"],
    ['rewrite protected row identity', "UPDATE public.system_config SET id=id+1000 WHERE menu_name='routine_name'"],
    ['rewrite protected sort', "UPDATE public.system_config SET sort=sort+1 WHERE menu_name='routine_name'"],
    ['rewrite protected metadata', "UPDATE public.system_config SET info='forged' WHERE menu_name='routine_name'"],
    ['rewrite lower-priority shadow', "UPDATE public.system_config SET value='forged' WHERE menu_name='routine_appsecret' AND sort=-2"],
    ['delete protected row', "DELETE FROM public.system_config WHERE menu_name='routine_name'"],
    ['truncate protected table', 'TRUNCATE public.system_config'],
  ])('rejects raw Admin %s', async (_label, statement) => withCapability(async c => {
    const before = await c.rows();
    await expect(c.admin.unsafe(statement)).rejects.toMatchObject({ code: '42501' });
    expect(await c.rows()).toEqual(before); expect(await c.receipts()).toEqual([]);
  }));

  it('does not turn forged GUCs or advisory locks into writer authority', async () => withCapability(async c => {
    const before = await c.rows();
    await expect(c.admin.begin(async tx => {
      await tx`SELECT set_config('cinashop.routine_writer',${c.binding.writer},true),
        set_config('cinashop.routine_actor','17',true), pg_advisory_xact_lock(731666,0),pg_advisory_xact_lock(731667,0)`;
      await tx`UPDATE public.system_config SET value='forged' WHERE menu_name='routine_name'`;
    })).rejects.toMatchObject({ code: '42501' });
    expect(await c.rows()).toEqual(before);
  }));

  it('denies SET ROLE into the NOLOGIN writer', async () => withCapability(async c => {
    await expect(c.admin.unsafe(`SET ROLE ${pricingIdentifier(c.binding.writer)}`)).rejects.toMatchObject({ code: '42501' });
    expect((await c.admin`SELECT current_user AS role,session_user AS session`)[0])
      .toMatchObject({ role: c.binding.admin, session: c.binding.admin });
  }));

  it('denies direct forged receipt INSERT, UPDATE, DELETE and TRUNCATE', async () => withCapability(async c => {
    await expect(c.admin`INSERT INTO public.admin_wechat_routine_operation
      VALUES(${randomUUID()}::uuid,17,'save',1,${'a'.repeat(64)},${REVISION},'committed','{}'::jsonb,1)`)
      .rejects.toMatchObject({ code: '42501' });
    for (const statement of ['UPDATE public.admin_wechat_routine_operation SET actor_id=18',
      'DELETE FROM public.admin_wechat_routine_operation', 'TRUNCATE public.admin_wechat_routine_operation']) {
      await expect(c.admin.unsafe(statement)).rejects.toMatchObject({ code: '42501' });
    }
    expect(await c.receipts()).toEqual([]);
  }));

  it('retains ordinary generic configuration INSERT and UPDATE', async () => withCapability(async c => {
    await c.admin`UPDATE public.system_config SET value='ordinary changed' WHERE menu_name='ordinary_fixture_key'`;
    await c.admin`INSERT INTO public.system_config(menu_name,value) VALUES('ordinary_second','ordinary inserted')`;
    expect((await c.rows()).filter(row => row.menuName.startsWith('ordinary_')).map(row => row.value))
      .toEqual(['ordinary changed', 'ordinary inserted']);
    expect(await c.receipts()).toEqual([]);
  }));

  it('commits all-keep without changing source rows or consuming a sequence', async () => withCapability(async c => {
    const before = await c.rows(), sequence = await c.sequence(), source = await c.source();
    const { receipt } = await c.invoke();
    expect(receipt).toMatchObject({ state: 'committed', replayed: false,
      result: { before_source: source, after_source: source, changed_keys: [] } });
    expect(await c.rows()).toEqual(before); expect(await c.sequence()).toEqual(sequence);
    expect(await c.receipts()).toHaveLength(1);
  }));

  it('inserts missing avatar policy with fixed tab26 metadata and preserves every existing source', async () => withCapability(async c => {
    const before = await c.rows();
    expect((await c.invoke({ fields: replace('store_user_avatar', '1') })).receipt.result.changed_keys).toEqual(['store_user_avatar']);
    const after = await c.rows(), avatar = after.find(row => row.menuName === 'store_user_avatar');
    expect(avatar).toMatchObject({ isStore: 0, value: '1', type: 'radio', inputType: '', configTabId: 26,
      parameter: '1=>开启\n0=>关闭', uploadType: 0, required: '', width: 0, high: 0,
      info: '强制获取昵称头像', desc: '是否在小程序用户授权之后，弹窗获取用户的昵称和头像', sort: 0, status: 1 });
    expect(after.filter(row => row.id !== avatar!.id)).toEqual(before);
  }));

  it('changes only the selected value while retaining imported metadata and shadows', async () => withCapability(async c => {
    const before = await c.rows(), winner = before.find(row => row.menuName === 'routine_name')!;
    await c.invoke({ fields: replace('routine_name', JSON.stringify('replacement name')) });
    const after = await c.rows(), changed = after.find(row => row.id === winner.id)!;
    expect(changed.value).toBe(JSON.stringify('replacement name'));
    expect(changed.version).not.toBe(winner.version);
    expect({ ...changed, value: winner.value, version: winner.version }).toEqual(winner);
    expect(after.filter(row => row.id !== winner.id)).toEqual(before.filter(row => row.id !== winner.id));
  }));

  it('allows explicit secret clear without altering its shadow', async () => withCapability(async c => {
    const before = await c.rows(), fields = keep(); fields.routine_appsecret = { action: 'clear' };
    await c.invoke({ fields });
    const secrets = (await c.rows()).filter(row => row.menuName === 'routine_appsecret');
    expect(secrets.find(row => row.sort === 30)?.value).toBe('""');
    expect(secrets.find(row => row.sort === -2)).toEqual(before.find(row => row.menuName === 'routine_appsecret' && row.sort === -2));
  }));

  it('accepts a valid escaped NUL secret through the real byte parser', async () => withCapability(async c => {
    const value = '\u0000owned😀\u0000', raw = JSON.stringify(value);
    await c.invoke({ fields: replace('routine_appsecret', raw) });
    const [row] = await c.fixture.db.execute<{ value: string; hex: string }>(sql`SELECT value,
      encode(public.cinashop_wechat_routine_text_bytes_v1(value),'hex') AS hex
      FROM public.system_config WHERE menu_name='routine_appsecret' AND sort=30`);
    expect(row.value).toBe(raw); expect(row.hex).toBe(Buffer.from(value, 'utf8').toString('hex'));
  }));

  it('replays the same UUID without assigning an XID or repeating source writes', async () => withCapability(async c => {
    const id = randomUUID(), expected = await c.source(), fields = replace('routine_name', JSON.stringify('once'));
    const first = await c.invoke({ id, expected, fields }), before = await c.rows(), receipts = await c.receipts(), sequence = await c.sequence();
    const replay = await c.invoke({ id, expected, fields });
    expect(replay.xidBefore).toBeNull(); expect(replay.xidAfter).toBeNull();
    expect(replay.receipt).toEqual({ ...first.receipt, replayed: true });
    expect(await c.rows()).toEqual(before); expect(await c.receipts()).toEqual(receipts); expect(await c.sequence()).toEqual(sequence);
  }));

  it('refuses another payload or actor under a committed UUID', async () => withCapability(async c => {
    const id = randomUUID(), expected = await c.source(); await c.invoke({ id, expected });
    const before = await c.rows(), receipts = await c.receipts();
    await expect(c.invoke({ id, expected, fields: replace('routine_name', JSON.stringify('different')) })).rejects.toMatchObject({ code: '40001' });
    await expect(c.invoke({ id, expected, actor: 18 })).rejects.toMatchObject({ code: '42501' });
    expect(await c.rows()).toEqual(before); expect(await c.receipts()).toEqual(receipts);
  }));

  it('lets resolve arrive first and permanently prevents that UUID from applying save', async () => withCapability(async c => {
    const id = randomUUID(), expected = await c.source(), before = await c.rows();
    const resolved = await c.invoke({ id, expected, operation: 'resolve', fields: null });
    expect(resolved.receipt).toMatchObject({ state: 'not_applied', operation: 'resolve', replayed: false });
    const late = await c.invoke({ id, expected, fields: replace('routine_name', JSON.stringify('too late')) });
    expect(late.receipt).toEqual({ ...resolved.receipt, replayed: true });
    expect(await c.rows()).toEqual(before); expect(await c.receipts()).toHaveLength(1);
  }));

  it('rolls configuration back when the final immutable receipt INSERT fails', async () => withCapability(async c => {
    await c.fixture.exec("ALTER TABLE public.admin_wechat_routine_operation ADD CONSTRAINT owned_late_receipt_failure CHECK(state<>'committed')");
    const before = await c.rows(), source = await c.source();
    await expect(c.invoke({ fields: replace('routine_name', JSON.stringify('must roll back')) })).rejects.toMatchObject({ code: '23514' });
    expect(await c.rows()).toEqual(before); expect(await c.source()).toBe(source); expect(await c.receipts()).toEqual([]);
  }));

  it.each([false, true])('rejects stale full source after maintenance changes metadata or xmin (xmin-only=%s)', async sameValueOnly => withCapability(async c => {
    const expected = await c.source(), original = await c.rows();
    await c.maintainName(sameValueOnly);
    const maintained = await c.rows(); expect(await c.source()).not.toBe(expected);
    if (sameValueOnly) expect(maintained.map(({ version: _version, ...row }) => row))
      .toEqual(original.map(({ version: _version, ...row }) => row));
    await expect(c.invoke({ expected })).rejects.toMatchObject({ code: '40001' });
    expect(await c.rows()).toEqual(maintained); expect(await c.receipts()).toEqual([]);
  }));

  it('rejects a complete 65-row platform source without changing any row', async () => withCapability(async c => {
    const before = await c.rows(); expect(before.filter(row => row.isStore === 0 && keys.includes(row.menuName as typeof keys[number]))).toHaveLength(65);
    await expect(c.invoke()).rejects.toMatchObject({ code: '54000' });
    expect(await c.rows()).toEqual(before); expect(await c.receipts()).toEqual([]);
  }, { extraShadows: 59 }));

  it('allows same-material AppID canonicalization without authorizing another account', async () => withCapability(async c => {
    const raw = '"\\u006fwned-app"';
    expect((await c.rows()).find(row => row.menuName === 'routine_appId' && row.sort === 30)?.value).toBe('owned-app');
    expect((await c.invoke({ fields: replace('routine_appId', raw) })).receipt.result.changed_keys).toEqual(['routine_appId']);
    expect((await c.rows()).find(row => row.menuName === 'routine_appId' && row.sort === 30)?.value).toBe(raw);
  }));

  it('fails closed on an AppID material change before writing any other setting', async () => withCapability(async c => {
    const before = await c.rows(), fields = replace('routine_appId', JSON.stringify('another-account'));
    fields.routine_name = { action: 'replace', raw: JSON.stringify('must not partly save') };
    await expect(c.invoke({ fields })).rejects.toMatchObject({ code: '42501' });
    expect(await c.rows()).toEqual(before); expect(await c.receipts()).toEqual([]);
  }));

  it('also refuses first AppID adoption until ownership commissioning exists', async () => withCapability(async c => {
    const before = await c.rows();
    await expect(c.invoke({ fields: replace('routine_appId', JSON.stringify('first-account')) })).rejects.toMatchObject({ code: '42501' });
    expect(await c.rows()).toEqual(before); expect(await c.receipts()).toEqual([]);
  }, { withoutAppId: true }));
});
